/**
 * NORTHCAT Гарант — бэкенд.
 *
 * Возможности:
 *  - хранение сделок (JSON-файл, для продакшена замените на БД);
 *  - проверка подписи Telegram initData (запросы принимаются только из Mini App);
 *  - выставление счетов через xRocket Pay API и приём webhook об оплате;
 *  - заявки об оплате через Bitpapa (подтверждаются гарантом вручную
 *    или автоматически через API Bitpapa — см. verifyBitpapaTransfer).
 *
 * Документация xRocket Pay API: https://pay.xrocket.tg/api
 * Ключ выдаёт бот @xRocket: Rocket Pay → Create App.
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

/* ---------- Проверка Telegram initData ---------- */

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

function auth(req, res, next) {
  const user = validateInitData(req.header("X-Telegram-Init-Data"));
  if (!user) {
    return res.status(401).json({ error: "Некорректная подпись Telegram initData" });
  }
  req.tgUser = user;
  next();
}

/* ---------- xRocket Pay ---------- */

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
  return body.data; // { id, link, ... }
}

/**
 * Подпись webhook xRocket: заголовок `rocket-pay-signature` содержит
 * HMAC-SHA256 от тела запроса, ключ — SHA-256 от API-ключа приложения.
 */
function verifyXRocketSignature(rawBody, signature) {
  if (!signature) return false;
  const key = crypto.createHash("sha256").update(XROCKET_API_KEY).digest();
  const expected = crypto.createHmac("sha256", key).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
}

/* ---------- Bitpapa ---------- */

/**
 * Проверка входящего перевода Bitpapa по коду сделки.
 * Реализуйте под своё API-подключение: https://bitpapa.com (раздел API).
 * Пока возвращает false — сделку по Bitpapa гарант отмечает оплаченной
 * вручную через POST /api/deals/:id/mark-paid (см. ниже).
 */
async function verifyBitpapaTransfer(deal) {
  void deal;
  return false;
}

/* ---------- HTTP API ---------- */

const app = express();

// Сырое тело нужно для проверки подписи webhook
app.use("/webhook", express.raw({ type: "*/*" }));
app.use(express.json());

// CORS для Mini App (страница живёт на другом домене, например GitHub Pages)
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function isParty(deal, user) {
  const uname = user.username ? "@" + user.username.toLowerCase() : null;
  return (
    deal.ownerId === user.id ||
    (uname && String(deal.counterparty || "").toLowerCase() === uname)
  );
}

// Сделки текущего пользователя
app.get("/api/deals", auth, (req, res) => {
  res.json(deals.filter((d) => isParty(d, req.tgUser)));
});

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
    method: b.method === "bitpapa" ? "bitpapa" : "xrocket",
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

// Счёт xRocket на оплату сделки
app.post("/api/deals/:id/invoice", auth, async (req, res) => {
  const deal = findDeal(req.params.id);
  if (!deal || !isParty(deal, req.tgUser)) {
    return res.status(404).json({ error: "Сделка не найдена" });
  }
  if (deal.status !== "new" || deal.method !== "xrocket") {
    return res.status(400).json({ error: "Счёт для этой сделки недоступен" });
  }
  try {
    const invoice = await createXRocketInvoice(deal);
    deal.xrocketInvoiceId = invoice.id;
    persist();
    res.json({ link: invoice.link });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "Не удалось создать счёт xRocket" });
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
    deal.status = "paid";
    deal.history.push({ status: "paid", ts: Date.now() });
  }
  persist();
  res.json(deal);
});

// Ручное подтверждение оплаты гарантом (защитите этот маршрут: сверяйте
// req.tgUser.id со списком администраторов)
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter(Boolean);

app.post("/api/deals/:id/mark-paid", auth, (req, res) => {
  if (!ADMIN_IDS.includes(req.tgUser.id)) {
    return res.status(403).json({ error: "Только для гаранта" });
  }
  const deal = findDeal(req.params.id);
  if (!deal || deal.status !== "new") {
    return res.status(400).json({ error: "Сделка не найдена или уже оплачена" });
  }
  deal.status = "paid";
  deal.history.push({ status: "paid", ts: Date.now() });
  persist();
  res.json(deal);
});

// Webhook xRocket об оплате счёта
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

  // Тип события invoicePay, payload счёта содержит ID сделки
  const data = event && event.data;
  const dealId = data && (data.payload || (data.invoice && data.invoice.payload));
  const deal = dealId && findDeal(dealId);
  if (deal && deal.status === "new") {
    deal.status = "paid";
    deal.history.push({ status: "paid", ts: Date.now() });
    persist();
    console.log(`[xrocket] Сделка ${deal.id} оплачена`);
  }
  res.json({ ok: true });
});

// Отдаём фронтенд, если он лежит рядом (можно хостить всё одним сервисом)
app.use(express.static(path.join(__dirname, "..")));

app.listen(PORT, () => {
  console.log(`NORTHCAT Гарант backend запущен на порту ${PORT}`);
  if (!BOT_TOKEN) console.warn("⚠️  BOT_TOKEN не задан — авторизация запросов работать не будет");
  if (!XROCKET_API_KEY) console.warn("⚠️  XROCKET_API_KEY не задан — счета xRocket создаваться не будут");
});
