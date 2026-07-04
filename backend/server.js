/**
 * CRB GA (гарант сделок) — бэкенд.
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

loadEnvFiles([
  path.join(__dirname, ".env"),
  path.join(__dirname, "..", ".env")
]);

function loadEnvFiles(files) {
  for (const file of files) {
    try {
      applyEnvFile(fs.readFileSync(file, "utf8"));
    } catch (e) {
      // файл не обязателен
    }
  }
}

function applyEnvFile(text) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value || value === "replace-me" || /^123456:ABC-DEF/.test(value)) {
      continue;
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function normalizedSecret(value) {
  const v = String(value || "").trim();
  if (!v || v === "replace-me" || /^123456:ABC-DEF/.test(v)) return "";
  return v;
}

function normalizeBotCommands(value) {
  let commands = value;
  if (typeof commands === "string") {
    const raw = commands.trim();
    if (!raw) commands = [];
    else {
      try {
        commands = JSON.parse(raw);
      } catch (e) {
        commands = raw.split(/\r?\n/).map((line) => {
          const trimmed = String(line || "").trim();
          if (!trimmed) return null;
          const parts = trimmed.split(/[\-|–|—]/);
          const command = String(parts.shift() || "").trim().replace(/^\//, "");
          const description = String(parts.join("-") || command).trim();
          return command ? { command, description } : null;
        }).filter(Boolean);
      }
    }
  }
  if (!Array.isArray(commands)) commands = [];
  return commands
    .map((item) => {
      const command = String(item && item.command ? item.command : "").trim().replace(/^\//, "").slice(0, 32);
      const description = String(item && item.description ? item.description : "").trim().slice(0, 256);
      return command && description ? { command, description } : null;
    })
    .filter(Boolean);
}

function getDefaultBotCommands() {
  return [
    { command: "start", description: "Открыть CRB GA" },
    { command: "app", description: "Кнопка запуска приложения" },
    { command: "post", description: "Пост с кнопками на шаблоны сделок" },
    { command: "deal", description: "Проверить сделку: /deal ID" },
    { command: "support", description: "Поддержка" }
  ];
}

function normalizeBotProfile(profile) {
  const src = profile || {};
  const shortDescription = String(src.shortDescription || src.short_description || "").trim() ||
    "CRB GA — гарант безопасных сделок. Escrow, споры, арбитраж.";
  const description = String(src.description || "").trim() ||
    "CRB GA — гарант-сервис безопасных сделок.\n\n" +
    "Средства покупателя блокируются у гаранта и выплачиваются продавцу только после подтверждения приёмки. Разногласия решает арбитр.\n\n" +
    "Оплата: xRocket, Bitpapa, PGon, NicePay, RuKassa.";
  const menuButtonText = String(src.menuButtonText || src.menu_button_text || "Открыть CRB GA").trim() || "Открыть CRB GA";
  const menuButtonUrl = String(src.menuButtonUrl || src.menu_button_url || (PUBLIC_URL ? PUBLIC_URL + "/" : "")).trim();
  const name = String(src.name || src.botName || src.bot_name || "").trim();
  const commands = normalizeBotCommands(src.commands || src.commandsJson || src.commands_json);
  return {
    name: name.slice(0, 64),
    shortDescription: shortDescription.slice(0, 120),
    description: description.slice(0, 512),
    menuButtonText: menuButtonText.slice(0, 64),
    menuButtonUrl,
    commands: commands.length ? commands : getDefaultBotCommands()
  };
}

// Конфиг перечитывается из process.env, чтобы правки через админ-панель
// (/api/admin/env) вступали в силу без перезапуска процесса.
let XROCKET_API_KEY, XROCKET_API_URL, PUBLIC_URL, FEE_PERCENT;
let PGON_API_URL, PGON_API_KEY, NICEPAY_MERCHANT_ID, NICEPAY_SECRET;
let RUKASSA_SHOP_ID, RUKASSA_TOKEN, WEBHOOK_SECRET, BITPAPA_API_TOKEN;
let ADMIN_IDS;

function applyConfigFromEnv() {
  XROCKET_API_KEY = process.env.XROCKET_API_KEY || "";
  XROCKET_API_URL = (process.env.XROCKET_API_URL || "https://pay.xrocket.tg").replace(/\/+$/, "");
  PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
  const fee = parseFloat(process.env.FEE_PERCENT || "5");
  FEE_PERCENT = Number.isFinite(fee) && fee >= 0 && fee < 100 ? fee : 5;

  // Платёжные шлюзы
  PGON_API_URL = (process.env.PGON_API_URL || "").replace(/\/+$/, "");
  PGON_API_KEY = process.env.PGON_API_KEY || "";
  NICEPAY_MERCHANT_ID = process.env.NICEPAY_MERCHANT_ID || "";
  NICEPAY_SECRET = process.env.NICEPAY_SECRET || "";
  RUKASSA_SHOP_ID = process.env.RUKASSA_SHOP_ID || "";
  RUKASSA_TOKEN = process.env.RUKASSA_TOKEN || "";

  // Секрет, который добавляется query-параметром к URL вебхуков шлюзов
  // (укажите его при настройке webhook в кабинете шлюза: /webhook/rukassa?secret=...)
  WEBHOOK_SECRET = normalizedSecret(process.env.WEBHOOK_SECRET);

  // Токен API Bitpapa для автопроверки входящих переводов
  BITPAPA_API_TOKEN = process.env.BITPAPA_API_TOKEN || "";

  ADMIN_IDS = (process.env.ADMIN_IDS || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter(Boolean);
}
applyConfigFromEnv();

const PORT = parseInt(process.env.PORT || "3000", 10);
const ADMIN_GROUP_ID = parseInt(process.env.ADMIN_GROUP_ID || "", 10);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Максимальный возраст initData Mini App (защита от повторного использования)
const INITDATA_MAX_AGE_SECONDS = parseInt(process.env.INITDATA_MAX_AGE || "86400", 10);

// Локальный админ-доступ без авторизации (для разработки). В production
// выключен по умолчанию; включается только явным LOCAL_ADMIN=1.
const LOCAL_ADMIN_ENABLED = process.env.LOCAL_ADMIN === "1" ||
  (process.env.LOCAL_ADMIN !== "0" && !IS_PRODUCTION);

// Каталог данных (deals.json и т.п.) — вынесите на постоянный том в проде
const DATA_DIR = process.env.DATA_DIR || __dirname;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error("[db] Не удалось создать каталог данных DATA_DIR:", e.message);
}

const RUNTIME_SETTINGS_FILE = path.join(DATA_DIR, "runtime_settings.json");
const DEFAULT_BOT_TOKEN = normalizedSecret(process.env.BOT_TOKEN);
const DEFAULT_BOT_PROFILE = normalizeBotProfile({
  name: process.env.BOT_NAME,
  shortDescription: process.env.BOT_SHORT_DESCRIPTION,
  description: process.env.BOT_DESCRIPTION,
  menuButtonText: process.env.BOT_MENU_BUTTON_TEXT,
  menuButtonUrl: process.env.BOT_MENU_BUTTON_URL,
  commandsJson: process.env.BOT_COMMANDS_JSON
});

let runtimeSettings = {
  botToken: DEFAULT_BOT_TOKEN,
  botProfile: normalizeBotProfile(DEFAULT_BOT_PROFILE),
  updatedAt: DEFAULT_BOT_TOKEN ? Date.now() : 0
};

try {
  const storedRuntime = JSON.parse(fs.readFileSync(RUNTIME_SETTINGS_FILE, "utf8"));
  const storedBotToken = normalizedSecret(storedRuntime && storedRuntime.botToken);
  if (storedBotToken) {
    runtimeSettings = {
      botToken: storedBotToken,
      botProfile: normalizeBotProfile(storedRuntime.botProfile),
      updatedAt: Number.isFinite(Number(storedRuntime.updatedAt)) ? Number(storedRuntime.updatedAt) : Date.now()
    };
  }
} catch (e) {
  // ignore missing runtime settings
}

// Атомарная запись: tmp-файл + rename, чтобы не потерять данные при падении
function writeFileAtomic(file, content) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file, data) {
  writeFileAtomic(file, JSON.stringify(data, null, 2));
}

function persistRuntimeSettings() {
  try {
    if (!runtimeSettings.botToken) {
      if (fs.existsSync(RUNTIME_SETTINGS_FILE)) fs.unlinkSync(RUNTIME_SETTINGS_FILE);
      return;
    }
    const payload = {
      botToken: runtimeSettings.botToken,
      botProfile: normalizeBotProfile(runtimeSettings.botProfile),
      updatedAt: runtimeSettings.updatedAt || Date.now()
    };
    writeJsonAtomic(RUNTIME_SETTINGS_FILE, payload);
  } catch (e) {
    console.error("[admin] Не удалось сохранить runtime_settings:", e.message);
  }
}

function getBotToken() {
  return runtimeSettings.botToken || "";
}

function getBotProfile() {
  if (!runtimeSettings.botProfile) runtimeSettings.botProfile = normalizeBotProfile(DEFAULT_BOT_PROFILE);
  return normalizeBotProfile(runtimeSettings.botProfile);
}



const DB_FILE = path.join(DATA_DIR, "deals.json");
const ADMIN_GROUP_FILE = path.join(DATA_DIR, "admin_group.json");

/* ---------- Хранилище ---------- */

let deals = [];
try {
  deals = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
} catch (e) {
  deals = [];
}

function persist() {
  try {
    writeJsonAtomic(DB_FILE, deals);
  } catch (e) {
    console.error("[db] Не удалось сохранить deals.json:", e.message);
  }
}

function findDeal(id) {
  return deals.find((d) => d.id === id);
}

function dealAmount(amount) {
  const v = parseFloat(amount);
  return Number.isFinite(v) ? Math.round(v * 1e8) / 1e8 : NaN;
}

function formatAmount(amount, currency) {
  const normalized = dealAmount(amount);
  if (!Number.isFinite(normalized)) return `— ${currency || ""}`.trim();
  return `${normalized.toLocaleString("ru-RU")} ${currency || ""}`.trim();
}

function normalizeChatId(value) {
  return Number.isInteger(value) && value !== 0 ? value : null;
}

let adminGroup = {
  chatId: normalizeChatId(ADMIN_GROUP_ID),
  title: "",
  type: "group",
  setBy: null,
  updatedAt: ADMIN_GROUP_ID ? Date.now() : 0
};

try {
  const stored = JSON.parse(fs.readFileSync(ADMIN_GROUP_FILE, "utf8"));
  if (stored && normalizeChatId(Number(stored.chatId))) {
    adminGroup = {
      chatId: Number(stored.chatId),
      title: String(stored.title || ""),
      type: stored.type === "supergroup" ? "supergroup" : "group",
      setBy: Number.isFinite(Number(stored.setBy)) ? Number(stored.setBy) : null,
      updatedAt: Number.isFinite(Number(stored.updatedAt)) ? Number(stored.updatedAt) : Date.now()
    };
  }
} catch (e) {
  // ignore missing file
}

function persistAdminGroup() {
  try {
    if (!adminGroup.chatId) {
      if (fs.existsSync(ADMIN_GROUP_FILE)) fs.unlinkSync(ADMIN_GROUP_FILE);
      return;
    }
    writeJsonAtomic(ADMIN_GROUP_FILE, adminGroup);
  } catch (e) {
    console.error("[bot] Не удалось сохранить admin_group:", e.message);
  }
}

function registerAdminGroup(chat, actorId) {
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return false;
  const nextId = normalizeChatId(Number(chat.id));
  if (!nextId) return false;
  adminGroup = {
    chatId: nextId,
    title: String(chat.title || "Админ-группа").slice(0, 128),
    type: chat.type,
    setBy: Number.isFinite(Number(actorId)) ? Number(actorId) : null,
    updatedAt: Date.now()
  };
  persistAdminGroup();
  return true;
}

function clearAdminGroup(chatId) {
  if (!adminGroup.chatId || Number(adminGroup.chatId) !== Number(chatId)) return false;
  adminGroup = { chatId: null, title: "", type: "group", setBy: null, updatedAt: Date.now() };
  persistAdminGroup();
  return true;
}

function adminGroupLabel() {
  if (!adminGroup.chatId) return "не привязана";
  const title = adminGroup.title || "Админ-группа";
  return `${title} (${adminGroup.chatId})`;
}

/* ---------- Хранилище chat_id пользователей ---------- */

const USER_CHATS_FILE = path.join(DATA_DIR, "user_chats.json");
let userChats = {};
try {
  userChats = JSON.parse(fs.readFileSync(USER_CHATS_FILE, "utf8"));
} catch (e) {
  userChats = {};
}

function persistChats() {
  try { writeJsonAtomic(USER_CHATS_FILE, userChats); } catch (e) {
    console.error("[bot] Не удалось сохранить user_chats:", e.message);
  }
}

// Запоминаем соответствие id/username → chatId при любом обращении пользователя
function registerUser(from, chatId) {
  let changed = false;
  if (userChats[String(from.id)] !== chatId) {
    userChats[String(from.id)] = chatId;
    changed = true;
  }
  if (from.username) {
    const key = "@" + from.username.toLowerCase();
    if (userChats[key] !== chatId) { userChats[key] = chatId; changed = true; }
  }
  if (changed) persistChats();
}

/* ---------- Авторизация ---------- */

// Mini App: проверка подписи initData
function validateInitData(initData) {
  const botToken = getBotToken();
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (expected.length !== hash.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return null;

  // Защита от повторного использования украденного initData
  const authDate = Number(params.get("auth_date") || 0);
  if (!Number.isFinite(authDate) ||
      Math.floor(Date.now() / 1000) - authDate > INITDATA_MAX_AGE_SECONDS) {
    return null;
  }

  try {
    const user = JSON.parse(params.get("user"));
    return user && Number.isFinite(Number(user.id)) ? user : null;
  } catch (e) {
    return null;
  }
}

// Login Widget: проверка подписи полей виджета
// https://core.telegram.org/widgets/login#checking-authorization
function validateWidgetAuth(data) {
  const botToken = getBotToken();
  if (!data || !data.hash || !botToken) return null;
  const { hash, ...fields } = data;
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secretKey = crypto.createHash("sha256").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (expected !== hash) return null;
  // Данные не старше суток
  if (Math.floor(Date.now() / 1000) - Number(fields.auth_date || 0) > 86400) return null;
  return fields;
}

// Токен сессии: base64url(payload).hmac
function issueToken(user) {
  const botToken = getBotToken();
  const payload = Buffer.from(JSON.stringify({
    id: user.id,
    first_name: user.first_name,
    last_name: user.last_name,
    username: user.username,
    photo_url: user.photo_url,
    exp: Date.now() + 30 * 24 * 3600 * 1000
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", botToken).update(payload).digest("base64url");
  return payload + "." + sig;
}

function validateToken(token) {
  const botToken = getBotToken();
  if (!token || !botToken) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", botToken).update(payload).digest("base64url");
  if (expected.length !== sig.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!user.id || !Number.isFinite(Number(user.exp)) || user.exp < Date.now()) return null;
    return user;
  } catch (e) {
    return null;
  }
}

function auth(req, res, next) {
  const encodedInitData = req.header("X-Telegram-Init-Data-B64") || req.query.initDataB64;
  let initData = req.header("X-Telegram-Init-Data") || req.query.initData || "";
  if (!initData && encodedInitData) {
    try {
      initData = Buffer.from(String(encodedInitData), "base64url").toString("utf8");
    } catch (e) {
      initData = "";
    }
  }
  // ?auth= несёт base64url либо initData, либо токен сессии — пробуем оба
  let queryAuth = "";
  if (req.query.auth) {
    try {
      queryAuth = Buffer.from(String(req.query.auth), "base64url").toString("utf8");
    } catch (e) {
      queryAuth = "";
    }
  }
  const user =
    validateInitData(initData) ||
    validateInitData(queryAuth) ||
    validateToken(req.header("X-Auth-Token")) ||
    validateToken(queryAuth);
  if (!user) {
    return res.status(401).json({ error: "Требуется авторизация через Telegram" });
  }
  req.tgUser = user;
  next();
}

/* ---------- Счета: xRocket ---------- */

// xRocket работает только с криптовалютами (RUB и подобное — через фиатные шлюзы)
const XROCKET_CURRENCY = { USDT: "USDT", TON: "TONCOIN", TONCOIN: "TONCOIN", BTC: "BTC" };

function xrocketCurrency(currency) {
  return XROCKET_CURRENCY[String(currency || "").toUpperCase()] || null;
}

async function createXRocketInvoice(deal) {
  if (!XROCKET_API_KEY) throw new Error("xRocket не настроен (XROCKET_API_KEY)");
  const currency = xrocketCurrency(deal.currency);
  if (!currency) {
    throw new Error(`xRocket не поддерживает валюту ${deal.currency} — выберите крипто-валюту или фиатный шлюз`);
  }
  const res = await fetch(XROCKET_API_URL + "/tg-invoices", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Rocket-Pay-Key": XROCKET_API_KEY
    },
    body: JSON.stringify({
      amount: deal.total,
      currency,
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
  if (!BITPAPA_API_TOKEN) return false;
  try {
    const res = await fetch("https://bitpapa.com/api/v1/transfers?type=incoming", {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + BITPAPA_API_TOKEN,
        "Accept": "application/json"
      }
    });
    if (!res.ok) {
      console.error(`[bitpapa] Ошибка запроса к API Bitpapa: ${res.status}`);
      return false;
    }
    const body = await res.json();
    const transfers = body.transfers || body.data || [];
    if (!Array.isArray(transfers)) return false;

    for (const tx of transfers) {
      const txAmount = parseFloat(tx.amount || tx.value);
      const txCurrency = String(tx.currency || "").toUpperCase();
      const txComment = String(tx.comment || tx.memo || tx.description || "");

      const isAmountMatch = Math.abs(txAmount - deal.total) < 0.01;
      const isCurrencyMatch = txCurrency === deal.currency.toUpperCase();
      const isCommentMatch = txComment.includes(deal.id);

      if (isAmountMatch && isCurrencyMatch && isCommentMatch) {
        console.log(`[bitpapa] Сделка ${deal.id}: найден перевод от Bitpapa. ID транзакции: ${tx.id}`);
        deal.bitpapaTxId = tx.id;
        return true;
      }
    }
  } catch (e) {
    console.error(`[bitpapa] Ошибка при проверке перевода Bitpapa:`, e.message);
  }
  return false;
}

// Автовыплата продавцу по завершенной сделке через xRocket Pay API
async function payoutSeller(deal) {
  if (deal.payoutId) {
    console.log(`[payout] Сделка ${deal.id}: выплата уже проведена (${deal.payoutId}), пропуск`);
    return true;
  }
  const sellerId = deal.role === "seller" ? deal.ownerId : deal.counterpartyId;
  if (!sellerId) {
    console.warn(`[payout] Сделка ${deal.id}: не удалось выплатить продавцу, т.к. его Telegram ID не известен`);
    notifyAdmins(`⚠️ Сделка <b>${deal.id}</b> завершена, но не удалось произвести автовыплату, так как Telegram ID продавца не найден. Требуется ручное вмешательство.`).catch(() => {});
    return false;
  }

  // Фиатные шлюзы (RuKassa/NicePay/PGon) и Bitpapa — выплата продавцу вручную.
  // Уведомляем гаранта, чтобы завершённая сделка не осталась без выплаты.
  if (deal.method !== "xrocket" || !xrocketCurrency(deal.currency)) {
    console.log(`[payout] Сделка ${deal.id}: метод ${deal.method}/${deal.currency} требует ручной выплаты продавцу ID ${sellerId}`);
    notifyAdmins(
      `💸 Сделка <b>${deal.id}</b> завершена. Метод «${deal.method}» (${deal.currency}) не поддерживает автовыплату.\n` +
      `Выплатите продавцу (ID ${sellerId}) <b>${formatAmount(deal.amount, deal.currency)}</b> вручную.`
    ).catch(() => {});
    return false;
  }

  if (!XROCKET_API_KEY) {
    console.warn(`[payout] Сделка ${deal.id}: xRocket API ключ не настроен для автовыплаты`);
    notifyAdmins(
      `⚠️ Сделка <b>${deal.id}</b> завершена, но XROCKET_API_KEY не настроен — ` +
      `выплатите продавцу (ID ${sellerId}) <b>${formatAmount(deal.amount, deal.currency)}</b> вручную.`
    ).catch(() => {});
    return false;
  }

  try {
    const currency = deal.currency === "USDT" ? "USDT" : deal.currency === "TON" ? "TONCOIN" : deal.currency;
    const amount = deal.amount; // Выплата продавцу (без комиссии гаранта)

    console.log(`[payout] Сделка ${deal.id}: инициация выплаты продавцу (ID: ${sellerId}) на сумму ${amount} ${currency}`);

    const res = await fetch(XROCKET_API_URL + "/app/transfer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Rocket-Pay-Key": XROCKET_API_KEY
      },
      body: JSON.stringify({
        tgUserId: sellerId,
        amount: amount,
        currency: currency,
        comment: `Выплата по сделке ${deal.id}: ${deal.title}`.slice(0, 500)
      })
    });

    const body = await res.json();
    if (!res.ok || !body.success) {
      throw new Error("xRocket Transfer error: " + JSON.stringify(body));
    }

    console.log(`[payout] Сделка ${deal.id}: выплата успешно проведена. ID перевода: ${body.data.id}`);
    deal.payoutId = body.data.id;
    persist();
    return true;
  } catch (e) {
    console.error(`[payout] Сделка ${deal.id}: ошибка при автовыплате:`, e.message);
    notifyAdmins(`❌ Ошибка автовыплаты по сделке <b>${deal.id}</b> продавцу (ID: ${sellerId}):\n<code>${e.message}</code>`).catch(() => {});
    return false;
  }
}

/* ---------- Уведомления ---------- */

// Отправить сообщение обеим сторонам сделки (огонь-и-забыть)
async function notifyParties(deal, text) {
  const ids = new Set();
  const ownerChat = userChats[String(deal.ownerId)];
  if (ownerChat) ids.add(ownerChat);
  if (deal.counterpartyId) {
    const cpChatById = userChats[String(deal.counterpartyId)];
    if (cpChatById) ids.add(cpChatById);
  }
  const cp = String(deal.counterparty || "").trim().toLowerCase();
  if (cp.startsWith("@")) {
    const cpChat = userChats[cp];
    if (cpChat) ids.add(cpChat);
  }
  for (const chatId of ids) {
    await tgCall("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: appButton("Открыть в приложении")
    }).catch(() => {});
  }
}

function groupLinkButton(text) {
  if (!PUBLIC_URL) return undefined;
  return { inline_keyboard: [[{ text, url: PUBLIC_URL + "/?admin=1" }]] };
}

// Инлайн-кнопки для управления сделкой прямо из Telegram
function payConfirmKeyboard(deal) {
  return { inline_keyboard: [[
    { text: "✅ Подтвердить оплату", callback_data: "apay:" + deal.id }
  ]] };
}

function disputeKeyboard(deal) {
  return { inline_keyboard: [[
    { text: "✅ Продавцу", callback_data: `ars:${deal.id}:seller` },
    { text: "🔄 Покупателю", callback_data: `ars:${deal.id}:buyer` }
  ]] };
}

async function notifyAdminGroup(text, keyboard) {
  if (!adminGroup.chatId) return false;
  const res = await tgCall("sendMessage", {
    chat_id: adminGroup.chatId,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard || groupLinkButton("Открыть сервис")
  }).catch(() => ({ ok: false }));
  return !!(res && res.ok);
}

// Оповестить всех гарантов/арбитров (с опциональными кнопками действий).
// Уведомление уходит в привязанную админ-группу, иначе — каждому админу лично.
async function notifyAdmins(text, keyboard) {
  if (await notifyAdminGroup(text, keyboard)) return;
  const markup = keyboard || appButton("Открыть админ-панель");
  for (const adminId of ADMIN_IDS) {
    await tgCall("sendMessage", {
      chat_id: adminId,
      text,
      parse_mode: "HTML",
      reply_markup: markup
    }).catch(() => {});
  }
}

/* ---------- HTTP API ---------- */

let BOT_INFO = null;
let botLoopStarted = false;
const app = express();

// За reverse-proxy укажите TRUST_PROXY (например, 1 или loopback),
// чтобы req.ip отражал реального клиента, а не адрес прокси.
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set("trust proxy", /^\d+$/.test(tp) ? parseInt(tp, 10) : tp);
}

// Сырое тело нужно для проверки подписи webhook xRocket
app.use("/webhook/xrocket", express.raw({ type: "*/*", limit: "256kb" }));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "256kb" }));

// CORS для Mini App (страница может жить на другом домене)
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data, X-Telegram-Init-Data-B64, X-Auth-Token");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Простой rate-limit по IP (RATE_LIMIT_PER_MIN=0 — отключить)
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || "300", 10);
const rateBuckets = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [key, bucket] of rateBuckets) {
    if (bucket.start < cutoff) rateBuckets.delete(key);
  }
}, 30000).unref();

function rateLimit(req, res, next) {
  if (!(RATE_LIMIT_PER_MIN > 0)) return next();
  const key = String(req.ip || req.socket.remoteAddress || "?");
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start >= 60000) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_PER_MIN) {
    return res.status(429).json({ error: "Слишком много запросов, повторите позже" });
  }
  next();
}

app.use("/api", rateLimit);
app.use("/webhook", rateLimit);

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "crb-ga-garant" });
});

// Текущий пользователь и его права
app.get("/api/me", auth, (req, res) => {
  res.json({ user: req.tgUser, isAdmin: ADMIN_IDS.includes(req.tgUser.id) });
});

function isLocalRequest(req) {
  if (!LOCAL_ADMIN_ENABLED) return false;
  // Запрос, прошедший через reverse-proxy, локальным не считается:
  // иначе за nginx на этой же машине каждый внешний запрос выглядел бы как 127.0.0.1.
  if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers["forwarded"]) {
    return false;
  }
  const ip = String(req.socket.remoteAddress || "");
  return ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
}

function adminRuntimeAccess(req, res, next) {
  if (isLocalRequest(req)) {
    req.tgUser = { id: 0, first_name: "Local Admin", username: "local_admin" };
    return next();
  }
  return auth(req, res, function authDone() {
    if (!ADMIN_IDS.includes(req.tgUser.id)) {
      return res.status(403).json({ error: "Только для гаранта" });
    }
    next();
  });
}

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
  if (deal.ownerId === user.id) return true;
  if (deal.counterpartyId === user.id) return true;
  if (uname && String(deal.counterparty || "").toLowerCase() === uname) {
    deal.counterpartyId = user.id;
    persist();
    return true;
  }
  return false;
}

// Роль пользователя в сделке: "seller" | "buyer" | null (не участник)
function partyRole(deal, user) {
  if (deal.ownerId === user.id) return deal.role;
  const uname = user.username ? "@" + String(user.username).toLowerCase() : null;
  const isCounterparty = deal.counterpartyId === user.id ||
    (uname && String(deal.counterparty || "").toLowerCase() === uname);
  if (isCounterparty) return deal.role === "seller" ? "buyer" : "seller";
  return null;
}

// Сделки текущего пользователя
app.get("/api/deals", auth, (req, res) => {
  res.json(deals.filter((d) => isParty(d, req.tgUser)));
});

const KNOWN_METHODS = ["xrocket", "bitpapa", "pgon", "nicepay", "rukassa"];

// Создание сделки (сумму и комиссию пересчитываем на сервере — клиенту не доверяем)
app.post("/api/deals", auth, (req, res) => {
  const b = req.body || {};
  const amount = dealAmount(b.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) {
    return res.status(400).json({ error: "Некорректная сумма" });
  }
  if (!b.title || !b.terms || !b.counterparty) {
    return res.status(400).json({ error: "Заполните все поля" });
  }
  const fee = dealAmount((amount * FEE_PERCENT) / 100);
  const parsedCounterpartyId = parseInt(b.counterpartyId, 10);
  const counterpartyId = Number.isFinite(parsedCounterpartyId) && parsedCounterpartyId > 0
    ? parsedCounterpartyId
    : undefined;
  const deal = {
    id: "CRB-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase(),
    ownerId: req.tgUser.id,
    ownerUsername: req.tgUser.username ? String(req.tgUser.username).replace(/^@+/, "") : "",
    ownerName: [req.tgUser.first_name, req.tgUser.last_name].filter(Boolean).join(" ").slice(0, 120),
    role: b.role === "buyer" ? "buyer" : "seller",
    counterparty: String(b.counterparty).slice(0, 64),
    counterpartyId,
    title: String(b.title).slice(0, 120),
    terms: String(b.terms).slice(0, 1000),
    amount,
    currency: ["USDT", "TON", "BTC", "RUB"].includes(b.currency) ? b.currency : "USDT",
    method: KNOWN_METHODS.includes(b.method) ? b.method : "xrocket",
    feePercent: FEE_PERCENT,
    fee,
    total: dealAmount(amount + fee),
    status: "new",
    createdAt: Date.now(),
    history: [{ status: "new", ts: Date.now() }]
  };
  deals.push(deal);
  persist();
  // Запомнить chat_id создателя и уведомить обе стороны (контрагента — если взаимодействовал с ботом)
  registerUser(req.tgUser, req.tgUser.id);
  const seller = deal.role === "seller" ? req.tgUser.first_name || "создатель" : deal.counterparty;
  const buyer  = deal.role === "buyer"  ? req.tgUser.first_name || "создатель" : deal.counterparty;
  notifyParties(deal,
    `🤝 <b>Новая сделка ${deal.id}</b>\n` +
    `📌 ${deal.title}\n\n` +
    `Продавец: ${seller}\n` +
    `Покупатель: ${buyer}\n` +
    `К оплате: <b>${deal.total} ${deal.currency}</b>\n\n` +
    `Для проверки статуса: /deal ${deal.id}`
  ).catch(() => {});
  res.json(deal);
});

// Допустимые переходы статусов (оплату ставит только webhook/гарант)
const TRANSITIONS = {
  new: ["cancelled"],
  paid: ["fulfilled", "dispute"],
  fulfilled: ["completed", "dispute"]
};

// Кто вправе выполнить переход: исполнение подтверждает продавец,
// приёмку — только покупатель (иначе продавец сам запускал бы выплату себе).
const TRANSITION_ROLES = {
  fulfilled: "seller",
  completed: "buyer"
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
  const requiredRole = TRANSITION_ROLES[next];
  if (requiredRole && partyRole(deal, req.tgUser) !== requiredRole) {
    return res.status(403).json({
      error: requiredRole === "seller"
        ? "Исполнение условий подтверждает продавец"
        : "Приёмку подтверждает покупатель"
    });
  }
  deal.status = next;
  deal.history.push({ status: next, ts: Date.now() });
  persist();

  const notifyMap = {
    fulfilled: `📦 <b>Сделка ${deal.id}</b>: продавец исполнил условия.\n<i>Покупатель, подтвердите приёмку в приложении.</i>`,
    completed: `🎉 <b>Сделка ${deal.id}</b>: завершена. Средства выплачены продавцу.`,
    dispute:   `⚠️ <b>Сделка ${deal.id}</b>: открыт спор. Арбитр рассмотрит обращение — подготовьте доказательства.`,
    cancelled: `❌ <b>Сделка ${deal.id}</b>: отменена.`
  };
  if (notifyMap[next]) {
    notifyParties(deal, notifyMap[next]).catch(() => {});
    if (next === "dispute") {
      notifyAdmins(
        `⚠️ Новый спор: <b>${deal.id}</b> «${deal.title}»\nСумма: ${deal.total} ${deal.currency}\n` +
        `Решите спор кнопкой ниже или в админ-панели.`,
        disputeKeyboard(deal)
      ).catch(() => {});
    }
  }
  if (next === "completed") {
    // Инициируем автовыплату продавцу через xRocket, если применимо
    payoutSeller(deal).catch((err) => {
      console.error(`[payout] Ошибка при автовыплате по сделке ${deal.id}:`, err);
    });
  }
  res.json(deal);
});

// Счёт на оплату сделки (xRocket / PGon / NicePay / RuKassa)
app.post("/api/deals/:id/invoice", auth, async (req, res) => {
  const deal = findDeal(req.params.id);
  if (!deal || !isParty(deal, req.tgUser)) {
    return res.status(404).json({ error: "Сделка не найдена" });
  }
  if (partyRole(deal, req.tgUser) !== "buyer") {
    return res.status(403).json({ error: "Счёт оплачивает покупатель" });
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
  if (partyRole(deal, req.tgUser) !== "buyer") {
    return res.status(403).json({ error: "Об оплате сообщает покупатель" });
  }
  if (deal.status !== "new") {
    return res.status(400).json({ error: "Сделка уже оплачена или закрыта" });
  }
  deal.bitpapaClaimedAt = Date.now();
  if (await verifyBitpapaTransfer(deal)) {
    markPaid(deal, "bitpapa-api");
    notifyParties(deal, `✅ <b>Сделка ${deal.id}</b>: оплата через Bitpapa подтверждена автоматически. Средства у гаранта.`).catch(() => {});
  } else {
    notifyAdmins(
      `💳 Покупатель по сделке <b>${deal.id}</b> «${deal.title}» сообщил об оплате через Bitpapa.\n` +
      `Сумма: ${deal.total} ${deal.currency} — проверьте поступление и подтвердите кнопкой ниже.`,
      payConfirmKeyboard(deal)
    ).catch(() => {});
  }
  persist();
  res.json(deal);
});

function adminOnly(req, res, next) {
  if (!ADMIN_IDS.includes(req.tgUser.id)) {
    return res.status(403).json({ error: "Только для гаранта" });
  }
  next();
}

function maskSecret(value) {
  const raw = String(value || "").trim();
  if (!raw) return "не задан";
  if (raw.length <= 10) return "••••••";
  return raw.slice(0, 6) + "••••••" + raw.slice(-4);
}

function userLabelFromParts(name, username, fallbackId) {
  if (name) return username ? `${name} (@${username})` : name;
  if (username) return `@${username}`;
  return `ID ${fallbackId}`;
}

function collectUserStats() {
  const users = new Map();

  function ensureUser(key, seed) {
    if (!users.has(key)) {
      users.set(key, {
        key,
        id: seed.id || null,
        username: seed.username || "",
        label: seed.label || (seed.id ? `ID ${seed.id}` : "Неизвестный"),
        totalDeals: 0,
        sellerDeals: 0,
        buyerDeals: 0,
        activeDeals: 0,
        completedDeals: 0,
        disputeDeals: 0,
        completedTurnover: 0,
        lastDealAt: 0
      });
    }
    return users.get(key);
  }

  function applyDeal(user, role, deal) {
    user.totalDeals += 1;
    if (role === "seller") user.sellerDeals += 1;
    if (role === "buyer") user.buyerDeals += 1;
    if (["new", "paid", "fulfilled"].includes(deal.status)) user.activeDeals += 1;
    if (deal.status === "completed") {
      user.completedDeals += 1;
      user.completedTurnover += Number(deal.amount) || 0;
    }
    if (deal.status === "dispute") user.disputeDeals += 1;
    user.lastDealAt = Math.max(user.lastDealAt || 0, Number(deal.createdAt) || 0);
  }

  for (const deal of deals) {
    const ownerUsername = String(deal.ownerUsername || "").replace(/^@+/, "");
    const ownerKey = `owner:${deal.ownerId}`;
    const owner = ensureUser(ownerKey, {
      id: deal.ownerId,
      username: ownerUsername,
      label: userLabelFromParts(deal.ownerName, ownerUsername, deal.ownerId)
    });
    applyDeal(owner, deal.role, deal);

    const counterpartyUsername = String(deal.counterparty || "").trim().replace(/^@+/, "");
    const counterpartyKey = deal.counterpartyId
      ? `user:${deal.counterpartyId}`
      : `handle:${String(deal.counterparty || "").trim().toLowerCase()}`;
    const counterparty = ensureUser(counterpartyKey, {
      id: deal.counterpartyId || null,
      username: counterpartyUsername,
      label: String(deal.counterparty || (deal.counterpartyId ? `ID ${deal.counterpartyId}` : "Контрагент")).slice(0, 120)
    });
    applyDeal(counterparty, deal.role === "seller" ? "buyer" : "seller", deal);
  }

  const list = Array.from(users.values()).sort((a, b) =>
    (b.totalDeals - a.totalDeals) ||
    (b.completedTurnover - a.completedTurnover) ||
    (b.lastDealAt - a.lastDealAt)
  );

  return {
    summary: {
      totalUsers: list.length,
      activeUsers: list.filter((u) => u.activeDeals > 0).length,
      disputedUsers: list.filter((u) => u.disputeDeals > 0).length,
      completedUsers: list.filter((u) => u.completedDeals > 0).length
    },
    users: list
  };
}

function searchService(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    return { query: "", counts: { deals: 0, users: 0 }, deals: [], users: [] };
  }

  const userStats = collectUserStats();
  const dealResults = deals.filter((deal) => {
    const haystack = [
      deal.id,
      deal.title,
      deal.terms,
      deal.counterparty,
      deal.ownerName,
      deal.ownerUsername,
      deal.method,
      deal.status,
      String(deal.ownerId || ""),
      String(deal.counterpartyId || "")
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  }).slice(0, 12).map((deal) => ({
    type: "deal",
    id: deal.id,
    title: deal.title,
    counterparty: deal.counterparty,
    status: deal.status,
    amount: deal.amount,
    currency: deal.currency,
    method: deal.method,
    createdAt: deal.createdAt
  }));

  const userResults = userStats.users.filter((entry) => {
    const haystack = [entry.label, entry.username, entry.id, entry.key].join(" ").toLowerCase();
    return haystack.includes(q);
  }).slice(0, 12).map((entry) => ({
    type: "user",
    key: entry.key,
    label: entry.label,
    username: entry.username,
    totalDeals: entry.totalDeals,
    completedDeals: entry.completedDeals,
    disputeDeals: entry.disputeDeals,
    completedTurnover: entry.completedTurnover
  }));

  return {
    query: q,
    counts: { deals: dealResults.length, users: userResults.length },
    deals: dealResults,
    users: userResults
  };
}

async function tgCallWithToken(botToken, method, payload) {
  const token = normalizedSecret(botToken);
  if (!token) return { ok: false, description: "BOT_TOKEN не задан" };
  try {
    const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    return await res.json();
  } catch (e) {
    console.error(`[bot] ${method}:`, e.message);
    return { ok: false, description: e.message };
  }
}

async function getRuntimeSnapshot() {
  let botInfo = BOT_INFO;
  const botToken = getBotToken();
  if (botToken && (!botInfo || !botInfo.username)) {
    const me = await tgCallWithToken(botToken, "getMe");
    if (me && me.ok) {
      botInfo = me.result;
      BOT_INFO = botInfo;
    }
  }

  return {
    botTokenConfigured: !!botToken,
    botTokenMasked: maskSecret(botToken),
    bot: botInfo ? {
      id: botInfo.id,
      username: botInfo.username,
      first_name: botInfo.first_name,
      can_join_groups: !!botInfo.can_join_groups
    } : null,
    botProfile: getBotProfile(),
    adminGroup: {
      chatId: adminGroup.chatId,
      title: adminGroup.title || "",
      label: adminGroupLabel(),
      type: adminGroup.type,
      updatedAt: adminGroup.updatedAt || 0
    },
    updatedAt: runtimeSettings.updatedAt || 0
  };
}

// --- Управление .env переменными ---

const ENV_KEYS = [
  "BOT_TOKEN", "BOT_NAME", "BOT_SHORT_DESCRIPTION", "BOT_DESCRIPTION",
  "BOT_MENU_BUTTON_TEXT", "BOT_MENU_BUTTON_URL", "BOT_COMMANDS_JSON",
  "ADMIN_IDS", "ADMIN_GROUP_ID",
  "XROCKET_API_KEY", "XROCKET_API_URL",
  "PGON_API_URL", "PGON_API_KEY",
  "NICEPAY_MERCHANT_ID", "NICEPAY_SECRET",
  "RUKASSA_SHOP_ID", "RUKASSA_TOKEN",
  "BITPAPA_API_TOKEN",
  "WEBHOOK_SECRET", "PUBLIC_URL",
  "FEE_PERCENT", "PORT"
];

const SECRET_KEYS = new Set([
  "BOT_TOKEN", "XROCKET_API_KEY", "PGON_API_KEY",
  "NICEPAY_SECRET", "RUKASSA_TOKEN", "BITPAPA_API_TOKEN",
  "WEBHOOK_SECRET"
]);

function getEnvSnapshot() {
  const result = {};
  for (const key of ENV_KEYS) {
    const raw = (process.env[key] || "").trim();
    const isMasked = SECRET_KEYS.has(key);
    result[key] = {
      value: isMasked ? maskSecret(raw) : raw,
      masked: isMasked,
      configured: !!raw && raw !== "replace-me"
    };
  }
  return result;
}

function readEnvFile() {
  try {
    return fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  } catch (e) {
    return "";
  }
}

function writeEnvFile(content) {
  fs.writeFileSync(path.join(__dirname, ".env"), content, "utf8");
}

/**
 * Обновляет .env файл: читает, меняет указанные ключи, сохраняет.
 * Комментарии и структура сохраняются.
 */
function updateEnvFile(updates) {
  const raw = readEnvFile();
  const lines = raw.split(/\r?\n/);
  const remaining = { ...updates };

  // Обновляем существующие строки
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in remaining) {
      lines[i] = key + "=" + remaining[key];
      delete remaining[key];
    }
  }

  // Добавляем новые ключи, которых не было в файле
  for (const [key, val] of Object.entries(remaining)) {
    lines.push(key + "=" + val);
  }

  writeEnvFile(lines.join("\n"));
}

async function ensureBotRuntime() {
  if (!getBotToken()) return;
  BOT_INFO = null;
  await setupBot();
  if (!botLoopStarted) {
    botLoopStarted = true;
    botLoop().catch((e) => console.error("[bot] loop:", e.message));
  }
}

// Админ: все сделки сервиса
app.get("/api/admin/deals", auth, adminOnly, (req, res) => {
  res.json(deals);
});

app.get("/api/admin/users", auth, adminOnly, (req, res) => {
  res.json(collectUserStats());
});

app.get("/api/admin/search", auth, adminOnly, (req, res) => {
  res.json(searchService(req.query && req.query.q));
});

app.get("/api/admin/runtime", adminRuntimeAccess, async (req, res) => {
  const snapshot = await getRuntimeSnapshot();
  snapshot.env = getEnvSnapshot();
  res.json(snapshot);
});

app.post("/api/admin/runtime", adminRuntimeAccess, async (req, res) => {
  const nextToken = normalizedSecret(req.body && req.body.botToken);
  if (!nextToken) {
    return res.status(400).json({ error: "Укажите корректный BOT_TOKEN" });
  }

  const me = await tgCallWithToken(nextToken, "getMe");
  if (!me || !me.ok || !me.result) {
    return res.status(400).json({ error: "Telegram отклонил BOT_TOKEN. Проверьте токен и повторите попытку." });
  }

  runtimeSettings = {
    botToken: nextToken,
    botProfile: runtimeSettings.botProfile || DEFAULT_BOT_PROFILE,
    updatedAt: Date.now()
  };
  persistRuntimeSettings();
  BOT_INFO = me.result;

  try {
    await ensureBotRuntime();
  } catch (e) {
    console.error("[admin] setup bot runtime:", e.message);
  }

  res.json(await getRuntimeSnapshot());
});

// Админ: чтение всех .env переменных
app.get("/api/admin/env", adminRuntimeAccess, (req, res) => {
  res.json({ env: getEnvSnapshot() });
});

// Админ: запись .env переменных
app.post("/api/admin/env", adminRuntimeAccess, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Ожидается JSON-объект с ключами для обновления" });
  }

  // Фильтруем: принимаем только известные ключи
  const updates = {};
  for (const key of ENV_KEYS) {
    if (key in body) {
      updates[key] = String(body[key] ?? "").trim();
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Нет известных ключей для обновления" });
  }

  // Валидация BOT_TOKEN через Telegram API
  if ("BOT_TOKEN" in updates) {
    const nextToken = normalizedSecret(updates.BOT_TOKEN);
    if (nextToken) {
      const me = await tgCallWithToken(nextToken, "getMe");
      if (!me || !me.ok || !me.result) {
        return res.status(400).json({ error: "Telegram отклонил BOT_TOKEN. Проверьте токен и повторите попытку." });
      }
      BOT_INFO = me.result;
    }
  }

  const profileKeys = [
    "BOT_NAME",
    "BOT_SHORT_DESCRIPTION",
    "BOT_DESCRIPTION",
    "BOT_MENU_BUTTON_TEXT",
    "BOT_MENU_BUTTON_URL",
    "BOT_COMMANDS_JSON"
  ];
  const hasProfileUpdates = profileKeys.some((key) => key in updates);
  if (hasProfileUpdates) {
    const currentProfile = getBotProfile();
    runtimeSettings.botProfile = normalizeBotProfile({
      name: updates.BOT_NAME != null ? updates.BOT_NAME : currentProfile.name,
      shortDescription: updates.BOT_SHORT_DESCRIPTION != null ? updates.BOT_SHORT_DESCRIPTION : currentProfile.shortDescription,
      description: updates.BOT_DESCRIPTION != null ? updates.BOT_DESCRIPTION : currentProfile.description,
      menuButtonText: updates.BOT_MENU_BUTTON_TEXT != null ? updates.BOT_MENU_BUTTON_TEXT : currentProfile.menuButtonText,
      menuButtonUrl: updates.BOT_MENU_BUTTON_URL != null ? updates.BOT_MENU_BUTTON_URL : currentProfile.menuButtonUrl,
      commandsJson: updates.BOT_COMMANDS_JSON != null ? updates.BOT_COMMANDS_JSON : currentProfile.commands
    });
  }

  // Записываем изменения в .env файл
  try {
    updateEnvFile(updates);
  } catch (e) {
    console.error("[admin] Не удалось записать .env:", e.message);
    return res.status(500).json({ error: "Не удалось сохранить .env файл" });
  }

  // Обновляем process.env и перечитываем зависящий от него конфиг,
  // чтобы новые ключи шлюзов/комиссия/ADMIN_IDS применились без рестарта
  for (const [key, val] of Object.entries(updates)) {
    process.env[key] = val;
  }
  applyConfigFromEnv();

  // Перезапуск бота при смене BOT_TOKEN
  if ("BOT_TOKEN" in updates || hasProfileUpdates) {
    const nextToken = normalizedSecret(updates.BOT_TOKEN);
    runtimeSettings = {
      botToken: nextToken || runtimeSettings.botToken,
      botProfile: runtimeSettings.botProfile || DEFAULT_BOT_PROFILE,
      updatedAt: Date.now()
    };
    persistRuntimeSettings();
    try {
      await ensureBotRuntime();
    } catch (e) {
      console.error("[admin] setup bot runtime:", e.message);
    }
  }

  res.json({ env: getEnvSnapshot() });
});

// Общая логика решения спора — используется и HTTP-роутом, и Telegram-кнопками.
// Возвращает true при успешном решении.
function resolveDispute(deal, resolution, actorId) {
  if (!deal || deal.status !== "dispute") return false;
  if (resolution !== "seller" && resolution !== "buyer") return false;
  deal.status = resolution === "seller" ? "completed" : "cancelled";
  deal.resolvedBy = Number.isFinite(Number(actorId)) ? Number(actorId) : null;
  deal.history.push({ status: deal.status, ts: Date.now() });
  persist();
  if (resolution === "seller") {
    payoutSeller(deal).catch((err) => {
      console.error(`[payout] Ошибка при автовыплате по сделке ${deal.id}:`, err);
    });
  }
  const resolveText = resolution === "seller"
    ? `✅ <b>Спор по сделке ${deal.id}</b> решён в пользу продавца. Средства выплачены.`
    : `🔄 <b>Спор по сделке ${deal.id}</b> решён в пользу покупателя. Средства возвращены.`;
  notifyParties(deal, resolveText).catch(() => {});
  console.log(`[arbitr] Сделка ${deal.id}: спор решён в пользу ${resolution === "seller" ? "продавца" : "покупателя"} (актор ${actorId})`);
  return true;
}

// Общая логика ручного подтверждения оплаты гарантом.
// Возвращает true при успешном переходе new → paid.
function confirmDealPaidByAdmin(deal, actorId) {
  if (!deal || deal.status !== "new") return false;
  markPaid(deal, "admin:" + actorId);
  persist();
  notifyParties(deal, `✅ <b>Сделка ${deal.id}</b>: оплата подтверждена гарантом. Средства заблокированы.\n<i>Продавец, исполните условия сделки.</i>`).catch(() => {});
  return true;
}

// Админ: решение спора — "seller" (выплата продавцу) или "buyer" (возврат покупателю)
app.post("/api/admin/deals/:id/resolve", auth, adminOnly, (req, res) => {
  const deal = findDeal(req.params.id);
  if (!deal || deal.status !== "dispute") {
    return res.status(400).json({ error: "Сделка не найдена или спора нет" });
  }
  const resolution = req.body && req.body.resolution;
  if (resolution !== "seller" && resolution !== "buyer") {
    return res.status(400).json({ error: "resolution: seller | buyer" });
  }
  resolveDispute(deal, resolution, req.tgUser.id);
  res.json(deal);
});

// Ручное подтверждение оплаты гарантом
app.post("/api/deals/:id/mark-paid", auth, adminOnly, (req, res) => {
  const deal = findDeal(req.params.id);
  if (!deal || deal.status !== "new") {
    return res.status(400).json({ error: "Сделка не найдена или уже оплачена" });
  }
  confirmDealPaidByAdmin(deal, req.tgUser.id);
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
  // Реагируем только на событие оплаты счёта
  if (event && event.type && event.type !== "invoicePay") {
    return res.json({ ok: true });
  }
  const data = event && event.data;
  const dealId = data && (data.payload || (data.invoice && data.invoice.payload));
  const deal = dealId && findDeal(dealId);
  if (deal) {
    markPaid(deal, "xrocket");
    persist();
    notifyParties(deal, `✅ <b>Сделка ${deal.id}</b>: оплата через xRocket получена. Средства у гаранта.\n<i>Продавец, исполните условия сделки.</i>`).catch(() => {});
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

    // Сверка подписи NicePay (при настроенном секрете подпись обязательна)
    if (provider === "nicepay" && NICEPAY_SECRET) {
      const sign = b.signature || b.sign || b.hash;
      if (!sign) {
        console.warn(`[nicepay] Вебхук без подписи по сделке ${deal.id}`);
        return res.status(401).json({ error: "Отсутствует подпись NicePay" });
      }
      const amountStr = String(b.amount ?? b.sum ?? b.value);
      const expectedSignMd5 = crypto.createHash("md5")
        .update(`${NICEPAY_MERCHANT_ID}${NICEPAY_SECRET}${amountStr}${deal.id}`)
        .digest("hex");
      const expectedSignSha256 = crypto.createHash("sha256")
        .update(`${NICEPAY_MERCHANT_ID}${amountStr}${deal.id}${NICEPAY_SECRET}`)
        .digest("hex");
      const received = String(sign).toLowerCase();
      if (received !== expectedSignMd5 && received !== expectedSignSha256) {
        console.warn(`[nicepay] Неверная подпись вебхука по сделке ${deal.id}`);
        return res.status(401).json({ error: "Неверная подпись NicePay" });
      }
    }

    // Сверка подписи RuKassa (при настроенном токене подпись обязательна)
    if (provider === "rukassa" && RUKASSA_TOKEN) {
      const sign = b.signature || b.sign;
      if (!sign) {
        console.warn(`[rukassa] Вебхук без подписи по сделке ${deal.id}`);
        return res.status(401).json({ error: "Отсутствует подпись RuKassa" });
      }
      const amountStr = String(b.amount ?? b.sum ?? b.value);
      const expectedSign = crypto.createHash("md5")
        .update(`${RUKASSA_SHOP_ID}${amountStr}${deal.id}${RUKASSA_TOKEN}`)
        .digest("hex");
      if (String(sign).toLowerCase() !== expectedSign) {
        console.warn(`[rukassa] Неверная подпись вебхука по сделке ${deal.id}`);
        return res.status(401).json({ error: "Неверная подпись RuKassa" });
      }
    }

    // Сверка валюты (если шлюз её сообщает)
    const paidCurrency = String(b.currency || b.currency_code || "").trim().toUpperCase();
    if (paidCurrency && paidCurrency !== String(deal.currency).toUpperCase()) {
      console.warn(`[${provider}] Сделка ${deal.id}: валюта ${paidCurrency} ≠ ${deal.currency}`);
      return res.status(400).json({ error: "Валюта платежа не совпадает" });
    }

    const paidAmount = parseFloat(b.amount ?? b.sum ?? b.value);
    if (isFinite(paidAmount) && paidAmount + 1e-9 < deal.total) {
      console.warn(`[${provider}] Сделка ${deal.id}: оплачено ${paidAmount} < ${deal.total}`);
      return res.status(400).json({ error: "Сумма меньше требуемой" });
    }
    markPaid(deal, provider);
    persist();
    notifyParties(deal, `✅ <b>Сделка ${deal.id}</b>: оплата через ${provider} получена. Средства у гаранта.\n<i>Продавец, исполните условия сделки.</i>`).catch(() => {});
    res.json({ ok: true });
  };
}

app.post("/webhook/pgon", gatewayWebhook("pgon"));
app.post("/webhook/nicepay", gatewayWebhook("nicepay"));
app.post("/webhook/rukassa", gatewayWebhook("rukassa"));

/* ---------- Telegram-бот ---------- */

async function tgCall(method, payload) {
  return tgCallWithToken(getBotToken(), method, payload);
}

function appButton(text) {
  if (!PUBLIC_URL) return undefined;
  return { inline_keyboard: [[{ text, web_app: { url: PUBLIC_URL + "/" } }]] };
}

function dealTemplateButtonText(deal) {
  const amountText = formatAmount(deal.amount, deal.currency);
  const reserve = Math.max(0, 64 - amountText.length - 3);
  const title = String(deal.title || "Сделка").slice(0, reserve);
  return `${title} · ${amountText}`.slice(0, 64);
}

function getDealTemplates(ownerId, query) {
  const q = String(query || "").trim().toLowerCase();
  return deals
    .filter((d) => d.ownerId === ownerId && d.role === "seller")
    .filter((d) => {
      if (!q) return true;
      return String(d.title || "").toLowerCase().includes(q) ||
        String(d.terms || "").toLowerCase().includes(q);
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10);
}

function buildPostKeyboard(templates) {
  return {
    inline_keyboard: templates.map((deal) => [
      { text: dealTemplateButtonText(deal), callback_data: `tpl:${deal.id}` }
    ])
  };
}

function createDealFromTemplate(template, buyer) {
  if (!buyer || !Number.isFinite(Number(buyer.id))) return null;
  if (!Number.isFinite(Number(template.ownerId)) || Number(template.ownerId) <= 0) return null;
  const amount = dealAmount(template.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const fee = dealAmount((amount * FEE_PERCENT) / 100);
  const buyerUsername = buyer.username && String(buyer.username).trim()
    ? `@${String(buyer.username).trim()}`
    : "";
  const buyerLabel = buyerUsername || `ID ${buyer.id}`;
  return {
    id: "CRB-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase(),
    ownerId: Number(template.ownerId),
    role: "seller",
    counterparty: String(buyerLabel).slice(0, 64),
    counterpartyId: buyer.id,
    title: String(template.title || "").slice(0, 120),
    terms: String(template.terms || "").slice(0, 1000),
    amount,
    currency: ["USDT", "TON", "BTC", "RUB"].includes(template.currency) ? template.currency : "USDT",
    method: KNOWN_METHODS.includes(template.method) ? template.method : "xrocket",
    feePercent: FEE_PERCENT,
    fee,
    total: dealAmount(amount + fee),
    status: "new",
    sourceTemplateId: template.id,
    createdAt: Date.now(),
    history: [{ status: "new", ts: Date.now() }]
  };
}

// Разовая настройка бота: описание, команды, админ-команды
async function setupBot() {
  const profile = getBotProfile();
  const me = await tgCall("getMe");
  if (me && me.ok) BOT_INFO = me.result;

  if (profile.name) {
    await tgCall("setMyName", { name: profile.name });
  }

  await tgCall("setMyShortDescription", {
    short_description: profile.shortDescription
  });
  await tgCall("setMyDescription", {
    description: profile.description
  });
  await tgCall("setMyCommands", {
    commands: profile.commands
  });
  for (const adminId of ADMIN_IDS) {
    await tgCall("setMyCommands", {
      scope: { type: "chat", chat_id: adminId },
      commands: [
        { command: "start", description: "Открыть CRB GA" },
        { command: "app", description: "Кнопка запуска приложения" },
        { command: "post", description: "Пост с кнопками на шаблоны сделок" },
        { command: "admin", description: "Админ-меню: оплаты и споры" },
        { command: "group", description: "Привязать текущую группу как админскую" },
        { command: "setup", description: "Перенастроить профиль и команды бота" },
        { command: "deal", description: "Проверить сделку: /deal ID" },
        { command: "support", description: "Поддержка" }
      ]
    });
  }
  if (profile.menuButtonUrl) {
    await tgCall("setChatMenuButton", {
      menu_button: { type: "web_app", text: profile.menuButtonText, web_app: { url: profile.menuButtonUrl } }
    });
  }
  console.log("[bot] Команды и описание настроены");
}

async function handleInlineQuery(inline) {
  const templates = getDealTemplates(inline.from.id, inline.query);
  const results = templates.map((deal) => ({
    type: "article",
    id: String(deal.id),
    title: deal.title,
    description: String(deal.terms || "Оформление сделки через гаранта").slice(0, 90),
    input_message_content: {
      message_text:
        "📌 Объявление гаранта CRB GA\n" +
        `${deal.title}\n` +
        `Сумма: ${formatAmount(deal.amount, deal.currency)}\n` +
        "Нажмите кнопку ниже, чтобы создать сделку по шаблону."
    },
    reply_markup: {
      inline_keyboard: [[
        { text: `Оформить: ${String(deal.title || "Сделка").slice(0, 24)}`, callback_data: `tpl:${deal.id}` }
      ]]
    }
  }));

  if (!results.length) {
    results.push({
      type: "article",
      id: "no-templates",
      title: "Нет шаблонов для инлайн-приглашения",
      description: "Создайте хотя бы одну сделку продавца и повторите запрос.",
      input_message_content: {
        message_text:
          "Нет доступных шаблонов сделок для инлайн-приглашения.\n" +
          "Создайте сделку в CRB GA как продавец, затем повторите запрос."
      },
      reply_markup: appButton("Открыть CRB GA")
    });
  }

  await tgCall("answerInlineQuery", {
    inline_query_id: inline.id,
    cache_time: 0,
    is_personal: true,
    results
  });
}

// Роутер callback-кнопок: инлайн-приглашения и админ-действия
async function handleCallback(cq) {
  const data = String(cq.data || "");
  if (data.startsWith("tpl:")) return handleTemplateCallback(cq);
  if (data.startsWith("apay:") || data.startsWith("ars:")) return handleAdminCallback(cq);
  await tgCall("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
}

// Убрать кнопки у сообщения, чтобы действие нельзя было повторить
async function clearMessageButtons(cq) {
  if (!cq.message || !cq.message.chat) return;
  await tgCall("editMessageReplyMarkup", {
    chat_id: cq.message.chat.id,
    message_id: cq.message.message_id,
    reply_markup: { inline_keyboard: [] }
  }).catch(() => {});
}

// Управление сделкой из Telegram: подтверждение оплаты и решение споров (только ADMIN_IDS)
async function handleAdminCallback(cq) {
  const fromId = cq.from && Number(cq.from.id);
  if (!ADMIN_IDS.includes(fromId)) {
    await tgCall("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "Действие доступно только гаранту.",
      show_alert: true
    }).catch(() => {});
    return;
  }
  const data = String(cq.data || "");

  if (data.startsWith("apay:")) {
    const deal = findDeal(data.slice(5));
    if (!deal) {
      await tgCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Сделка не найдена.", show_alert: true });
      return;
    }
    const ok = confirmDealPaidByAdmin(deal, fromId);
    await tgCall("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: ok ? `Оплата по ${deal.id} подтверждена.` : "Сделка уже оплачена или закрыта.",
      show_alert: !ok
    });
    if (ok) {
      await clearMessageButtons(cq);
      await notifyAdmins(`✅ Оплата по сделке <b>${deal.id}</b> подтверждена гарантом (ID ${fromId}).`);
    }
    return;
  }

  if (data.startsWith("ars:")) {
    const parts = data.split(":"); // ars:<id>:<resolution>
    const deal = findDeal(parts[1]);
    const resolution = parts[2];
    if (!deal) {
      await tgCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Сделка не найдена.", show_alert: true });
      return;
    }
    const ok = resolveDispute(deal, resolution, fromId);
    await tgCall("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: ok
        ? `Спор по ${deal.id} решён в пользу ${resolution === "seller" ? "продавца" : "покупателя"}.`
        : "Спор уже закрыт или сделка не в статусе спора.",
      show_alert: !ok
    });
    if (ok) {
      await clearMessageButtons(cq);
      await notifyAdmins(`⚖️ Спор по сделке <b>${deal.id}</b> решён гарантом (ID ${fromId}) в пользу ${resolution === "seller" ? "продавца" : "покупателя"}.`);
    }
    return;
  }
}

async function handleTemplateCallback(cq) {
  const data = String(cq.data || "");
  if (!data.startsWith("tpl:")) return;
  const templateId = data.slice(4);
  const template = findDeal(templateId);
  if (!template || template.role !== "seller") {
    await tgCall("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "Шаблон сделки не найден.",
      show_alert: true
    });
    return;
  }
  if (!cq.from || !cq.from.id) return;
  if (Number(cq.from.id) === Number(template.ownerId)) {
    await tgCall("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "Нельзя принять собственный шаблон.",
      show_alert: true
    });
    return;
  }

  // Повторное нажатие не плодит дубли: возвращаем уже открытую сделку
  const existing = deals.find((d) =>
    d.sourceTemplateId === template.id &&
    Number(d.counterpartyId) === Number(cq.from.id) &&
    ["new", "paid", "fulfilled"].includes(d.status)
  );
  if (existing) {
    await tgCall("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: `У вас уже есть сделка ${existing.id} по этому объявлению.`,
      show_alert: true
    });
    return;
  }

  const deal = createDealFromTemplate(template, cq.from);
  if (!deal) {
    await tgCall("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "Не удалось создать сделку из шаблона.",
      show_alert: true
    });
    return;
  }
  deals.push(deal);
  persist();

  await tgCall("answerCallbackQuery", {
    callback_query_id: cq.id,
    text: `Сделка ${deal.id} создана`,
    show_alert: false
  });

  await tgCall("sendMessage", {
    chat_id: cq.from.id,
    text:
      `✅ Сделка ${deal.id} создана по шаблону.\n` +
      `Продавец: ID ${template.ownerId}\n` +
      `Сумма: ${formatAmount(deal.amount, deal.currency)}\n` +
      "Откройте CRB GA, чтобы продолжить.",
    reply_markup: appButton("Открыть CRB GA")
  });

  await tgCall("sendMessage", {
    chat_id: template.ownerId,
    text:
      `📥 Новый отклик на объявление: создана сделка ${deal.id}.\n` +
      `Покупатель: ${deal.counterparty}\n` +
      `Сумма: ${formatAmount(deal.amount, deal.currency)}`,
    reply_markup: appButton("Открыть CRB GA")
  });
}

// Пользователи, ожидающие ответа поддержки. Автоматически истекает через 10 минут.
const supportMode = new Map(); // chatId → timestamp

function enterSupportMode(chatId) {
  supportMode.set(chatId, Date.now());
}

function inSupportMode(chatId) {
  const ts = supportMode.get(chatId);
  if (!ts) return false;
  if (Date.now() - ts > 10 * 60 * 1000) { supportMode.delete(chatId); return false; }
  return true;
}

function formatUserLabel(from) {
  return `${from.first_name}${from.last_name ? " " + from.last_name : ""}` +
    (from.username ? ` (@${from.username})` : "") + ` [${from.id}]`;
}

async function sendDealSummary(chatId, deal, viewer, useAppButton) {
  const stLabels = {
    new: "Ожидает оплаты", paid: "В гаранте (оплачена)", fulfilled: "Исполнена",
    completed: "Завершена", dispute: "Спор", cancelled: "Отменена"
  };
  const isOwner = deal.ownerId === viewer.id;
  const viewerRole = isOwner ? deal.role : (deal.role === "seller" ? "buyer" : "seller");
  const sellerLabel = viewerRole === "seller" ? "вы" : deal.counterparty;
  const buyerLabel = viewerRole === "buyer" ? "вы" : deal.counterparty;
  await tgCall("sendMessage", {
    chat_id: chatId,
    text:
      `🔖 <b>Сделка ${deal.id}</b>\n` +
      `📌 ${deal.title}\n\n` +
      `Статус: <b>${stLabels[deal.status] || deal.status}</b>\n` +
      `Сумма: ${deal.amount} ${deal.currency}\n` +
      `К оплате: ${deal.total} ${deal.currency} (комиссия ${deal.feePercent}%)\n` +
      `Продавец: ${sellerLabel}\n` +
      `Покупатель: ${buyerLabel}`,
    parse_mode: "HTML",
    reply_markup: useAppButton ? appButton("Открыть в приложении") : groupLinkButton("Открыть сервис")
  });
}

// Отправить в чат карточки с кнопками действий по всем открытым задачам гаранта:
// заявки об оплате Bitpapa (кнопка подтверждения) и споры (кнопки решения).
async function sendPendingAdminItems(chatId) {
  const pendingPay = deals
    .filter((d) => d.status === "new" && d.bitpapaClaimedAt)
    .sort((a, b) => (b.bitpapaClaimedAt || 0) - (a.bitpapaClaimedAt || 0))
    .slice(0, 10);
  const disputes = deals
    .filter((d) => d.status === "dispute")
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 10);

  if (!pendingPay.length && !disputes.length) {
    await tgCall("sendMessage", { chat_id: chatId, text: "Открытых задач нет: подтверждений оплаты и споров не найдено." });
    return;
  }

  for (const deal of pendingPay) {
    await tgCall("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `💳 <b>${deal.id}</b> «${deal.title}»\n` +
        `Покупатель сообщил об оплате (${deal.method}). Сумма: ${formatAmount(deal.total, deal.currency)}.`,
      reply_markup: payConfirmKeyboard(deal)
    }).catch(() => {});
  }
  for (const deal of disputes) {
    await tgCall("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `⚠️ <b>${deal.id}</b> «${deal.title}»\n` +
        `Спор на арбитраже. Сумма: ${formatAmount(deal.total, deal.currency)}.`,
      reply_markup: disputeKeyboard(deal)
    }).catch(() => {});
  }
}

async function handleGroupMessage(msg) {
  const chat = msg.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;

  const cmd = msg.text ? msg.text.trim().split(/[\s@]/)[0] : "";
  const isAdmin = !!(msg.from && ADMIN_IDS.includes(msg.from.id));
  const botAdded = !!(
    BOT_INFO &&
    Array.isArray(msg.new_chat_members) &&
    msg.new_chat_members.some((member) => member.id === BOT_INFO.id)
  );
  const botRemoved = !!(
    BOT_INFO &&
    msg.left_chat_member &&
    msg.left_chat_member.id === BOT_INFO.id
  );

  if (botRemoved) {
    clearAdminGroup(chat.id);
    return;
  }

  if (botAdded) {
    if (isAdmin && registerAdminGroup(chat, msg.from.id)) {
      await tgCall("sendMessage", {
        chat_id: chat.id,
        text:
          `✅ Группа «${chat.title || "Админ-группа"}» привязана как основная админ-группа.\n` +
          `Теперь оповещения по спорам, поддержке и ручным проверкам будут приходить сюда.`,
        reply_markup: groupLinkButton("Открыть сервис")
      });
    } else {
      await tgCall("sendMessage", {
        chat_id: chat.id,
        text:
          "Я добавлен в группу, но привязать её может только Telegram ID из ADMIN_IDS.\n" +
          "Пусть администратор выполнит здесь команду /group.",
        reply_markup: groupLinkButton("Открыть сервис")
      });
    }
    return;
  }

  if (!cmd) return;

  if (cmd === "/group") {
    if (!isAdmin) {
      await tgCall("sendMessage", {
        chat_id: chat.id,
        text: "Привязать админ-группу может только Telegram ID из ADMIN_IDS."
      });
      return;
    }
    registerAdminGroup(chat, msg.from.id);
    await tgCall("sendMessage", {
      chat_id: chat.id,
      text:
        `✅ Админ-группа привязана: ${adminGroupLabel()}\n` +
        "Теперь служебные уведомления бота будут приходить сюда.",
      reply_markup: groupLinkButton("Открыть сервис")
    });
    return;
  }

  if (!isAdmin) return;

  if (cmd === "/admin") {
    const active = deals.filter((d) => ["new", "paid", "fulfilled"].includes(d.status)).length;
    const disputes = deals.filter((d) => d.status === "dispute").length;
    const awaiting = deals.filter((d) => d.status === "new" && d.bitpapaClaimedAt).length;
    await tgCall("sendMessage", {
      chat_id: chat.id,
      text:
        "Админ-группа CRB GA\n\n" +
        `Сделок всего: ${deals.length}\n` +
        `Активных: ${active}\n` +
        `Споров: ${disputes}\n` +
        `Ожидают подтверждения оплаты: ${awaiting}\n` +
        `Текущая группа: ${adminGroupLabel()}`,
      reply_markup: groupLinkButton("Открыть админ-панель")
    });
    await sendPendingAdminItems(chat.id);
    return;
  }

  if (cmd === "/deal") {
    const parts = msg.text.trim().split(/\s+/);
    const dealId = parts[1] ? parts[1].toUpperCase() : null;
    if (!dealId) {
      await tgCall("sendMessage", { chat_id: chat.id, text: "Укажите ID сделки: /deal CRB-..." });
      return;
    }
    const deal = findDeal(dealId);
    if (!deal) {
      await tgCall("sendMessage", { chat_id: chat.id, text: "Сделка не найдена." });
      return;
    }
    await sendDealSummary(chat.id, deal, msg.from, false);
  }
}

async function handleUpdate(upd) {
  const msg = upd.message;
  if (upd.inline_query) {
    await handleInlineQuery(upd.inline_query);
    return;
  }
  if (upd.callback_query) {
    await handleCallback(upd.callback_query);
    return;
  }
  if (!msg) return;
  if (msg.chat.type !== "private") {
    await handleGroupMessage(msg);
    return;
  }
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const isAdmin = ADMIN_IDS.includes(msg.from.id);
  const cmd = msg.text.trim().split(/[\s@]/)[0];

  // Запоминаем соответствие username/id → chatId
  registerUser(msg.from, chatId);

  if (cmd === "/start" || cmd === "/app") {
    if (PUBLIC_URL) {
      await tgCall("setChatMenuButton", {
        chat_id: chatId,
        menu_button: { type: "web_app", text: "CRB GA", web_app: { url: PUBLIC_URL + "/" } }
      });
    }
    await tgCall("sendMessage", {
      chat_id: chatId,
      text:
        "CRB GA — гарант безопасных сделок.\n\n" +
        "Средства покупателя блокируются у гаранта и выплачиваются продавцу после " +
        "подтверждения приёмки. Оплата: xRocket, Bitpapa, PGon, NicePay, RuKassa." +
        (isAdmin ? "\n\nВам доступно админ-меню: /admin" : ""),
      reply_markup: appButton("Открыть CRB GA")
    });
  } else if (cmd === "/admin") {
    if (!isAdmin) {
      await tgCall("sendMessage", { chat_id: chatId, text: "Команда доступна только гаранту." });
      return;
    }
    const active = deals.filter((d) => ["new", "paid", "fulfilled"].includes(d.status)).length;
    const disputes = deals.filter((d) => d.status === "dispute").length;
    const awaiting = deals.filter((d) => d.status === "new" && d.bitpapaClaimedAt).length;
    await tgCall("sendMessage", {
      chat_id: chatId,
      text:
        "Админ-меню CRB GA\n\n" +
        `Сделок всего: ${deals.length}\n` +
        `Активных: ${active}\n` +
        `Споров на арбитраже: ${disputes}\n` +
        `Ожидают подтверждения оплаты: ${awaiting}\n\n` +
        "Подтверждайте оплаты и решайте споры прямо здесь кнопками ниже или во вкладке «Админ» приложения.",
      reply_markup: appButton("Открыть админ-панель")
    });
    await sendPendingAdminItems(chatId);
  } else if (cmd === "/setup") {
    if (!isAdmin) {
      await tgCall("sendMessage", { chat_id: chatId, text: "Команда доступна только гаранту." });
      return;
    }
    await setupBot();
    await tgCall("sendMessage", {
      chat_id: chatId,
      text:
        "🔧 Бот перенастроен: имя, описание, команды и кнопка меню обновлены из текущего профиля.\n" +
        (PUBLIC_URL ? `Mini App: ${PUBLIC_URL}/` : "PUBLIC_URL не задан — кнопка меню Mini App не установлена."),
      reply_markup: appButton("Открыть CRB GA")
    });
  } else if (cmd === "/post") {
    const templates = getDealTemplates(msg.from.id);
    if (!templates.length) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text:
          "Нет шаблонов сделок для поста.\n" +
          "Создайте хотя бы одну сделку с ролью продавца в CRB GA."
      });
      return;
    }
    await tgCall("sendMessage", {
      chat_id: chatId,
      text:
        "📣 Готовый пост-объявление с кнопками на разные сделки.\n" +
        "Перешлите это сообщение в канал/чат или используйте инлайн-режим @бота.",
      reply_markup: buildPostKeyboard(templates)
    });
  } else if (cmd === "/deal") {
    const parts = msg.text.trim().split(/\s+/);
    const dealId = parts[1] ? parts[1].toUpperCase() : null;
    if (!dealId) {
      await tgCall("sendMessage", { chat_id: chatId, text: "Укажите ID сделки: /deal CRB-..." });
      return;
    }
    const deal = findDeal(dealId);
    if (!deal) {
      await tgCall("sendMessage", { chat_id: chatId, text: "Сделка не найдена." });
      return;
    }
    const uname = msg.from.username ? "@" + msg.from.username.toLowerCase() : null;
    const party = deal.ownerId === msg.from.id ||
      (uname && String(deal.counterparty || "").toLowerCase() === uname);
    if (!party && !isAdmin) {
      await tgCall("sendMessage", { chat_id: chatId, text: "Вы не являетесь участником этой сделки." });
      return;
    }
    await sendDealSummary(chatId, deal, msg.from, true);
  } else if (cmd === "/support") {
    enterSupportMode(chatId);
    await tgCall("sendMessage", {
      chat_id: chatId,
      text: "Опишите ваш вопрос одним сообщением — гарант ответит вам здесь."
    });
  } else if (inSupportMode(chatId)) {
    // Пересылаем вопрос всем гарантам
    supportMode.delete(chatId);
    for (const adminId of ADMIN_IDS) {
      await tgCall("sendMessage", {
        chat_id: adminId,
        text: `💬 <b>Вопрос поддержки</b>\nОт: ${formatUserLabel(msg.from)}\n\n${msg.text}`,
        parse_mode: "HTML"
      }).catch(() => {});
    }
    await tgCall("sendMessage", {
      chat_id: chatId,
      text: "Ваш вопрос передан гаранту. Ожидайте ответа здесь."
    });
  }
}

// Long polling: не требует публичного URL и переживает смену туннеля
async function botLoop() {
  // Пропускаем накопившийся бэклог, чтобы не спамить старыми ответами
  let offset = 0;
  const last = await tgCall("getUpdates", { offset: -1, limit: 1 });
  if (last.ok && last.result.length) offset = last.result[0].update_id + 1;

  let backoff = 1000;
  for (;;) {
    const res = await tgCall("getUpdates", { offset, timeout: 50 });
    if (!res.ok) {
      // Неверный/отозванный токен — нет смысла крутить цикл, ждём смены токена
      if (res.error_code === 401 || res.error_code === 404) {
        console.error("[bot] BOT_TOKEN отклонён Telegram — long-polling остановлен. Обновите токен в админ-панели или /setup.");
        botLoopStarted = false;
        return;
      }
      // 409 (конфликт с другим getUpdates/webhook) и сетевые ошибки — экспоненциальный бэкофф
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
      continue;
    }
    backoff = 1000;
    for (const upd of res.result) {
      offset = upd.update_id + 1;
      handleUpdate(upd).catch((e) => console.error("[bot] update:", e.message));
    }
  }
}

// Отдаём фронтенд, если он лежит рядом (можно хостить всё одним сервисом).
// Только allowlist путей: раздача всего корня репозитория открывала бы
// backend/.env, runtime_settings.json (токен бота), deals.json и .git.
const FRONTEND_ROOT = path.join(__dirname, "..");
const PUBLIC_PATH_RE = /^\/(?:$|index\.html$|settings\.html$|favicon\.ico$|css\/|js\/)/;
const staticHandler = express.static(FRONTEND_ROOT, { index: "index.html", dotfiles: "deny" });

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  // Проверяем декодированный путь: ".." (в т.ч. как %2e%2e) в пути
  // не имеет легитимного применения — режем обходы вида /js/../backend/
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(req.path);
  } catch (e) {
    return next();
  }
  if (decodedPath.includes("..") || decodedPath.includes("\\") || decodedPath.includes("\0")) return next();
  if (!PUBLIC_PATH_RE.test(decodedPath)) return next();
  return staticHandler(req, res, next);
});

// Ссылки вида PUBLIC_URL/deal/<id> из счетов ведут на главную Mini App
app.get("/deal/:id", (req, res) => res.redirect("/"));

function startServer(port = PORT) {
  const server = app.listen(port, () => {
    console.log(`CRB GA backend запущен на порту ${port}`);
    if (!getBotToken()) console.warn("⚠️  BOT_TOKEN не задан — авторизация и бот работать не будут");
    if (!XROCKET_API_KEY) console.warn("⚠️  XROCKET_API_KEY не задан — счета xRocket создаваться не будут");
    if (!WEBHOOK_SECRET) console.warn("⚠️  WEBHOOK_SECRET не задан — вебхуки шлюзов отключены");
    if (LOCAL_ADMIN_ENABLED) console.warn("⚠️  Локальный админ-доступ включён (LOCAL_ADMIN); в production задайте NODE_ENV=production или LOCAL_ADMIN=0");
    if (getBotToken()) {
      ensureBotRuntime().catch((e) => console.error("[bot] setup:", e.message));
    }
  });
  return server;
}

if (require.main === module) {
  const server = startServer();

  function shutdown(signal) {
    console.log(`[server] Получен ${signal}, останавливаемся...`);
    persist();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Экспорт для тестов
module.exports = {
  app,
  startServer,
  applyConfigFromEnv,
  validateInitData,
  validateToken,
  issueToken
};
