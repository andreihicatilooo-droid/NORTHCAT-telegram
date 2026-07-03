/**
 * NORTHCAT Гарант — бэкенд.
 *
 * Возможности:
 *  - хранение сделок (JSON-файл, для продакшена замените на БД);
 *  - авторизация: подпись Telegram initData (Mini App) или токен сессии,
 *    выданный после входа через Telegram Login Widget (браузер);
 *  - выставление счетов: xRocket Pay API, PGon, NicePay, RuKassa;
 *  - вебхуки об оплате от xRocket и платёжных шлюзов;
 *  - заявки об оплате через Bitpapa (подтверждает гарант).
 *
 * Документация xRocket Pay API: https://pay.xrocket.tg/api
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const XROCKET_API_KEY = process.env.XROCKET_API_KEY || "";
const XROCKET_API_URL = (process.env.XROCKET_API_URL || "https://pay.xrocket.tg").replace(/\/+$/, "");
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const FEE_PERCENT = parseFloat(process.env.FEE_PERCENT || "5");
const PORT = parseInt(process.env.PORT || "3000", 10);

// Платёжные шлюзы
const PGON_API_URL = (process.env.PGON_API_URL || "").replace(/\/+$/, "");
const PGON_API_KEY = process.env.PGON_API_KEY || "";
const NICEPAY_MERCHANT_ID = process.env.NICEPAY_MERCHANT_ID || "";
const NICEPAY_SECRET = process.env.NICEPAY_SECRET || "";
const RUKASSA_SHOP_ID = process.env.RUKASSA_SHOP_ID || "";
const RUKASSA_TOKEN = process.env.RUKASSA_TOKEN || "";

// Секрет, который добавляется query-параметром к URL вебхуков шлюзов
// (укажите его при настройке webhook в кабинете шлюза: /webhook/rukassa?secret=...)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter(Boolean);

const DB_FILE = path.join(__dirname, "deals.json");

/* ---------- Хранилище ---------- */

let deals = [];
try {
  deals = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
} catch (e) {
  deals = [];
}

function persist() {
  fs.writeFileSync(DB_FILE, JSON.stringify(deals, null, 2));
}

function findDeal(id) {
  return deals.find((d) => d.id === id);
}

/* ---------- Авторизация ---------- */

// Mini App: проверка подписи initData
function validateInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expected = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (expected !== hash) return null;

  try {
    return JSON.parse(params.get("user"));
  } catch (e) {
    return null;
  }
}

// Login Widget: проверка подписи полей виджета
// https://core.telegram.org/widgets/login#checking-authorization
function validateWidgetAuth(data) {
  if (!data || !data.hash || !BOT_TOKEN) return null;
  const { hash, ...fields } = data;
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const expected = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (expected !== hash) return null;
  // Данные не старше суток
  if (Math.floor(Date.now() / 1000) - Number(fields.auth_date || 0) > 86400) return null;
  return fields;
}

// Токен сессии: base64url(payload).hmac
function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    first_name: user.first_name,
    last_name: user.last_name,
    username: user.username,
    photo_url: user.photo_url,
    exp: Date.now() + 30 * 24 * 3600 * 1000
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", BOT_TOKEN).update(payload).digest("base64url");
  return payload + "." + sig;
}

function validateToken(token) {
  if (!token || !BOT_TOKEN) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", BOT_TOKEN).update(payload).digest("base64url");
  if (expected.length !== sig.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!user.id || user.exp < Date.now()) return null;
    return user;
  } catch (e) {
    return null;
  }
}

function auth(req, res, next) {
  const user =
    validateInitData(req.header("X-Telegram-Init-Data")) ||
    validateToken(req.header("X-Auth-Token"));
  if (!user) {
    return res.status(401).json({ error: "Требуется авторизация через Telegram" });
  }
  req.tgUser = user;
  next();
}

/* ---------- Счета: xRocket ---------- */

async function createXRocketInvoice(deal) {
  const res = await fetch(XROCKET_API_URL + "/tg-invoices", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Rocket-Pay-Key": XROCKET_API_KEY
    },
    body: JSON.stringify({
      amount: deal.total,
      currency: deal.currency === "USDT" ? "USDT" : deal.currency === "TON" ? "TONCOIN" : deal.currency,
      description: `Сделка ${deal.id}: ${deal.title}`.slice(0, 1000),
      payload: deal.id,
      numPayments: 1,
      callbackUrl: PUBLIC_URL ? `${PUBLIC_URL}/deal/${deal.id}` : undefined
    })
  });
  const body = await res.json();
  if (!res.ok || !body.success) {
    throw new Error("xRocket: " + JSON.stringify(body));
  }
  return { link: body.data.link, externalId: body.data.id };
}

/**
 * Подпись webhook xRocket: заголовок `rocket-pay-signature` содержит
 * HMAC-SHA256 от тела запроса, ключ — SHA-256 от API-ключа приложения.
 */
function verifyXRocketSignature(rawBody, signature) {
  if (!signature) return false;
  const key = crypto.createHash("sha256").update(XROCKET_API_KEY).digest();
  const expected = crypto.createHmac("sha256", key).update(rawBody).digest("hex");
  return expected.length === String(signature).length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
}

/* ---------- Счета: платёжные шлюзы ---------- */

/**
 * RuKassa — https://lk.rukassa.pro (раздел API).
 * Создание платежа: POST /api/v1/create, ответ содержит url на страницу оплаты.
 * Сверьте поля с актуальной документацией вашего кабинета.
 */
async function createRukassaInvoice(deal) {
  if (!RUKASSA_SHOP_ID || !RUKASSA_TOKEN) throw new Error("RuKassa не настроена");
  const form = new URLSearchParams({
    shop_id: RUKASSA_SHOP_ID,
    token: RUKASSA_TOKEN,
    order_id: deal.id,
    amount: String(deal.total),
    currency: deal.currency,
    data: JSON.stringify({ deal: deal.id })
  });
  const res = await fetch("https://lk.rukassa.pro/api/v1/create", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form
  });
  const body = await res.json();
  if (!res.ok || !body.url) throw new Error("RuKassa: " + JSON.stringify(body));
  return { link: body.url, externalId: body.id };
}

/**
 * NicePay — https://nicepay.io (раздел API).
 * Создание платежа возвращает ссылку на страницу оплаты.
 * Сверьте поля и формат суммы с актуальной документацией.
 */
async function createNicepayInvoice(deal) {
  if (!NICEPAY_MERCHANT_ID || !NICEPAY_SECRET) throw new Error("NicePay не настроен");
  const res = await fetch("https://nicepay.io/public/api/payment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      merchant_id: NICEPAY_MERCHANT_ID,
      secret: NICEPAY_SECRET,
      order_id: deal.id,
      account: deal.counterparty,
      amount: deal.total,
      currency: deal.currency,
      description: `Сделка ${deal.id}: ${deal.title}`.slice(0, 255)
    })
  });
  const body = await res.json();
  const link = body && body.data && (body.data.link || body.data.url);
  if (!res.ok || body.status !== "success" || !link) {
    throw new Error("NicePay: " + JSON.stringify(body));
  }
  return { link, externalId: body.data.payment_id };
}

/**
 * PGon — универсальный адаптер: укажите PGON_API_URL и PGON_API_KEY,
 * при необходимости поправьте путь и поля под документацию шлюза.
 */
async function createPgonInvoice(deal) {
  if (!PGON_API_URL || !PGON_API_KEY) throw new Error("PGon не настроен");
  const res = await fetch(PGON_API_URL + "/invoice", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + PGON_API_KEY
    },
    body: JSON.stringify({
      order_id: deal.id,
      amount: deal.total,
      currency: deal.currency,
      description: `Сделка ${deal.id}: ${deal.title}`.slice(0, 255),
      callback_url: PUBLIC_URL ? `${PUBLIC_URL}/webhook/pgon?secret=${WEBHOOK_SECRET}` : undefined
    })
  });
  const body = await res.json();
  const link = body.url || body.link || (body.data && (body.data.url || body.data.link));
  if (!res.ok || !link) throw new Error("PGon: " + JSON.stringify(body));
  return { link, externalId: body.id || (body.data && body.data.id) };
}

const INVOICE_PROVIDERS = {
  xrocket: createXRocketInvoice,
  rukassa: createRukassaInvoice,
  nicepay: createNicepayInvoice,
  pgon: createPgonInvoice
};

/* ---------- Bitpapa ---------- */

/**
 * Проверка входящего перевода Bitpapa по коду сделки.
 * Реализуйте под своё API-подключение: https://bitpapa.com (раздел API).
 * Пока возвращает false — сделку по Bitpapa гарант отмечает оплаченной
 * вручную через POST /api/deals/:id/mark-paid.
 */
async function verifyBitpapaTransfer(deal) {
  void deal;
  return false;
}

/* ---------- HTTP API ---------- */

const app = express();

// Сырое тело нужно для проверки подписи webhook xRocket
app.use("/webhook/xrocket", express.raw({ type: "*/*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// CORS для Mini App (страница может жить на другом домене)
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data, X-Auth-Token");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "northcat-garant" });
});

// Вход через Telegram Login Widget
app.post("/api/auth/telegram", (req, res) => {
  const fields = validateWidgetAuth(req.body);
  if (!fields) {
    return res.status(401).json({ error: "Некорректная подпись Telegram Login" });
  }
  const user = {
    id: Number(fields.id),
    first_name: fields.first_name,
    last_name: fields.last_name,
    username: fields.username,
    photo_url: fields.photo_url
  };
  res.json({ user, token: issueToken(user) });
});

function isParty(deal, user) {
  const uname = user.username ? "@" + String(user.username).toLowerCase() : null;
  return (
    deal.ownerId === user.id ||
    (uname && String(deal.counterparty || "").toLowerCase() === uname)
  );
}

// Сделки текущего пользователя
app.get("/api/deals", auth, (req, res) => {
  res.json(deals.filter((d) => isParty(d, req.tgUser)));
});

const KNOWN_METHODS = ["xrocket", "bitpapa", "pgon", "nicepay", "rukassa"];

// Создание сделки (сумму и комиссию пересчитываем на сервере — клиенту не доверяем)
app.post("/api/deals", auth, (req, res) => {
  const b = req.body || {};
  const amount = parseFloat(b.amount);
  if (!isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Некорректная сумма" });
  }
  if (!b.title || !b.terms || !b.counterparty) {
    return res.status(400).json({ error: "Заполните все поля" });
  }
  const fee = (amount * FEE_PERCENT) / 100;
  const deal = {
    id: "NC-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase(),
    ownerId: req.tgUser.id,
    role: b.role === "buyer" ? "buyer" : "seller",
    counterparty: String(b.counterparty).slice(0, 64),
    title: String(b.title).slice(0, 120),
    terms: String(b.terms).slice(0, 1000),
    amount,
    currency: ["USDT", "TON", "BTC", "RUB"].includes(b.currency) ? b.currency : "USDT",
    method: KNOWN_METHODS.includes(b.method) ? b.method : "xrocket",
    feePercent: FEE_PERCENT,
    fee,
    total: amount + fee,
    status: "new",
    createdAt: Date.now(),
    history: [{ status: "new", ts: Date.now() }]
  };
  deals.push(deal);
  persist();
  res.json(deal);
});

// Допустимые переходы статусов (оплату ставит только webhook/гарант)
const TRANSITIONS = {
  new: ["cancelled"],
  paid: ["fulfilled", "dispute"],
  fulfilled: ["completed", "dispute"]
};

app.post("/api/deals/:id/status", auth, (req, res) => {
  const deal = findDeal(req.params.id);
  if (!deal || !isParty(deal, req.tgUser)) {
    return res.status(404).json({ error: "Сделка не найдена" });
  }
  const next = req.body && req.body.status;
  if (!(TRANSITIONS[deal.status] || []).includes(next)) {
    return res.status(400).json({ error: `Переход ${deal.status} → ${next} запрещён` });
  }
  deal.status = next;
  deal.history.push({ status: next, ts: Date.now() });
  persist();

  if (next === "completed") {
    // Здесь инициируйте выплату продавцу (например, перевод через xRocket
    // POST /app/transfer) и уведомление сторон через Bot API.
    console.log(`[payout] Сделка ${deal.id}: выплатить продавцу ${deal.amount} ${deal.currency}`);
  }
  res.json(deal);
});

// Счёт на оплату сделки (xRocket / PGon / NicePay / RuKassa)
app.post("/api/deals/:id/invoice", auth, async (req, res) => {
  const deal = findDeal(req.params.id);
  if (!deal || !isParty(deal, req.tgUser)) {
    return res.status(404).json({ error: "Сделка не найдена" });
  }
  const provider = INVOICE_PROVIDERS[deal.method];
  if (deal.status !== "new" || !provider) {
    return res.status(400).json({ error: "Счёт для этой сделки недоступен" });
  }
  try {
    const invoice = await provider(deal);
    deal.invoiceId = invoice.externalId;
    persist();
    res.json({ link: invoice.link });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: `Не удалось создать счёт (${deal.method})` });
  }
});

// Покупатель сообщил, что отправил перевод Bitpapa
app.post("/api/deals/:id/bitpapa-claim", auth, async (req, res) => {
  const deal = findDeal(req.params.id);
  if (!deal || !isParty(deal, req.tgUser)) {
    return res.status(404).json({ error: "Сделка не найдена" });
  }
  deal.bitpapaClaimedAt = Date.now();
  if (await verifyBitpapaTransfer(deal)) {
    markPaid(deal, "bitpapa-api");
  }
  persist();
  res.json(deal);
});

// Ручное подтверждение оплаты гарантом
app.post("/api/deals/:id/mark-paid", auth, (req, res) => {
  if (!ADMIN_IDS.includes(req.tgUser.id)) {
    return res.status(403).json({ error: "Только для гаранта" });
  }
  const deal = findDeal(req.params.id);
  if (!deal || deal.status !== "new") {
    return res.status(400).json({ error: "Сделка не найдена или уже оплачена" });
  }
  markPaid(deal, "admin:" + req.tgUser.id);
  persist();
  res.json(deal);
});

function markPaid(deal, source) {
  if (deal.status !== "new") return;
  deal.status = "paid";
  deal.paidVia = source;
  deal.history.push({ status: "paid", ts: Date.now() });
  console.log(`[paid] Сделка ${deal.id} оплачена (${source})`);
}

/* ---------- Вебхуки ---------- */

// xRocket: подпись в заголовке rocket-pay-signature
app.post("/webhook/xrocket", (req, res) => {
  const raw = req.body; // Buffer (express.raw)
  if (!verifyXRocketSignature(raw, req.header("rocket-pay-signature"))) {
    return res.status(401).json({ error: "Неверная подпись" });
  }
  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    return res.status(400).json({ error: "Некорректное тело" });
  }
  const data = event && event.data;
  const dealId = data && (data.payload || (data.invoice && data.invoice.payload));
  const deal = dealId && findDeal(dealId);
  if (deal) {
    markPaid(deal, "xrocket");
    persist();
  }
  res.json({ ok: true });
});

/**
 * Вебхуки шлюзов PGon / NicePay / RuKassa.
 * Защита: query-параметр ?secret=WEBHOOK_SECRET (укажите его в URL вебхука
 * в кабинете шлюза) + сверка суммы. Дополнительно включите проверку
 * подписи конкретного шлюза по его документации.
 */
function gatewayWebhook(provider) {
  return (req, res) => {
    if (!WEBHOOK_SECRET || req.query.secret !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Неверный секрет вебхука" });
    }
    const b = req.body || {};
    const dealId = b.order_id || b.orderId || b.merchant_order_id || b.payload;
    const deal = dealId && findDeal(String(dealId));
    if (!deal) return res.status(404).json({ error: "Сделка не найдена" });

    const paidAmount = parseFloat(b.amount ?? b.sum ?? b.value);
    if (isFinite(paidAmount) && paidAmount + 1e-9 < deal.total) {
      console.warn(`[${provider}] Сделка ${deal.id}: оплачено ${paidAmount} < ${deal.total}`);
      return res.status(400).json({ error: "Сумма меньше требуемой" });
    }
    markPaid(deal, provider);
    persist();
    res.json({ ok: true });
  };
}

app.post("/webhook/pgon", gatewayWebhook("pgon"));
app.post("/webhook/nicepay", gatewayWebhook("nicepay"));
app.post("/webhook/rukassa", gatewayWebhook("rukassa"));

// Отдаём фронтенд, если он лежит рядом (можно хостить всё одним сервисом)
app.use(express.static(path.join(__dirname, "..")));

app.listen(PORT, () => {
  console.log(`NORTHCAT Гарант backend запущен на порту ${PORT}`);
  if (!BOT_TOKEN) console.warn("⚠️  BOT_TOKEN не задан — авторизация работать не будет");
  if (!XROCKET_API_KEY) console.warn("⚠️  XROCKET_API_KEY не задан — счета xRocket создаваться не будут");
  if (!WEBHOOK_SECRET) console.warn("⚠️  WEBHOOK_SECRET не задан — вебхуки шлюзов отключены");
});
