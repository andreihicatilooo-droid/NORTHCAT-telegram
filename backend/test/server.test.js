/**
 * Интеграционные тесты бэкенда CRB GA (node:test, без внешних зависимостей).
 * Запуск: npm test (из каталога backend/).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("node:events");

// Изолируем данные и включаем production-режим (без локального админ-обхода).
// SKIP_DOTENV не даёт локальному backend/.env с реальными ключами протечь в тесты.
process.env.SKIP_DOTENV = "1";
const BOT_TOKEN = "12345678:TEST-TOKEN-abcdefghijklmnop";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "crb-test-"));
process.env.BOT_TOKEN = BOT_TOKEN;
process.env.WEBHOOK_SECRET = "test-webhook-secret";
process.env.ADMIN_IDS = "999";
process.env.NODE_ENV = "production";
process.env.FEE_PERCENT = "5";
process.env.RATE_LIMIT_PER_MIN = "10000";

const { app } = require("../server.js");

let server;
let base;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
});

/* ---------- Хелперы ---------- */

function buildInitData(user, authDate) {
  const params = new URLSearchParams();
  params.set("user", JSON.stringify(user));
  params.set("auth_date", String(authDate != null ? authDate : Math.floor(Date.now() / 1000)));
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

const SELLER = { id: 111, first_name: "Seller", username: "seller_user" };
const BUYER = { id: 222, first_name: "Buyer", username: "buyer_user" };
const ADMIN = { id: 999, first_name: "Admin", username: "admin_user" };
const STRANGER = { id: 333, first_name: "Stranger", username: "stranger_user" };

function api(method, p, { user, body, headers } = {}) {
  const h = { "Content-Type": "application/json", ...(headers || {}) };
  if (user) h["X-Telegram-Init-Data"] = buildInitData(user);
  return fetch(base + p, {
    method,
    headers: h,
    body: body != null ? JSON.stringify(body) : undefined
  });
}

/* ---------- Базовые проверки ---------- */

test("health отвечает без авторизации", async () => {
  const res = await fetch(base + "/api/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test("API без авторизации отклоняется", async () => {
  const res = await fetch(base + "/api/deals");
  assert.equal(res.status, 401);
});

test("валидный initData принимается", async () => {
  const res = await api("GET", "/api/deals", { user: BUYER });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test("initData с испорченной подписью отклоняется", async () => {
  const tampered = buildInitData(BUYER).replace(/hash=\w{6}/, "hash=000000");
  const res = await fetch(base + "/api/deals", {
    headers: { "X-Telegram-Init-Data": tampered }
  });
  assert.equal(res.status, 401);
});

test("устаревший initData отклоняется (защита от replay)", async () => {
  const stale = buildInitData(BUYER, Math.floor(Date.now() / 1000) - 3 * 86400);
  const res = await fetch(base + "/api/deals", {
    headers: { "X-Telegram-Init-Data": stale }
  });
  assert.equal(res.status, 401);
});

/* ---------- Статика: секреты недоступны ---------- */

test("файлы бэкенда и служебные пути не раздаются", async () => {
  for (const p of [
    "/backend/.env",
    "/backend/server.js",
    "/backend/deals.json",
    "/backend/runtime_settings.json",
    "/.git/config",
    "/server.log",
    "/cli.js",
    "/start.sh"
  ]) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, `ожидался 404 для ${p}, получен ${res.status}`);
  }
});

test("path traversal в статике не работает", async () => {
  const net = require("node:net");
  function rawGet(p) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, "127.0.0.1", () => {
        socket.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      });
      let data = "";
      socket.on("data", (chunk) => { data += chunk; });
      socket.on("end", () => resolve(parseInt(data.split(" ")[1], 10)));
      socket.on("error", reject);
    });
  }
  for (const p of [
    "/js/../backend/server.js",
    "/js/%2e%2e/backend/server.js",
    "/js/..%2f..%2fbackend/server.js",
    "/css/../cli.js"
  ]) {
    assert.equal(await rawGet(p), 404, `ожидался 404 для ${p}`);
  }
});

test("фронтенд раздаётся", async () => {
  const index = await fetch(base + "/");
  assert.equal(index.status, 200);
  assert.match(await index.text(), /<html/i);
  const js = await fetch(base + "/js/app.js");
  assert.equal(js.status, 200);
});

/* ---------- Флоу сделки и ролевая модель ---------- */

let deal;

test("создание сделки: сумма и комиссия считаются на сервере", async () => {
  const res = await api("POST", "/api/deals", {
    user: SELLER,
    body: {
      title: "Тестовый товар",
      terms: "Условия тестовой сделки",
      counterparty: "@" + BUYER.username,
      amount: 100,
      currency: "USDT",
      method: "rukassa",
      role: "seller",
      // клиентские значения комиссии должны игнорироваться
      fee: 0,
      total: 1
    }
  });
  assert.equal(res.status, 200);
  deal = await res.json();
  assert.equal(deal.amount, 100);
  assert.equal(deal.fee, 5);
  assert.equal(deal.total, 105);
  assert.equal(deal.status, "new");
});

test("посторонний не видит чужую сделку", async () => {
  const res = await api("POST", `/api/deals/${deal.id}/status`, {
    user: STRANGER,
    body: { status: "cancelled" }
  });
  assert.equal(res.status, 404);
});

test("оплату нельзя проставить через /status", async () => {
  const res = await api("POST", `/api/deals/${deal.id}/status`, {
    user: BUYER,
    body: { status: "paid" }
  });
  assert.equal(res.status, 400);
});

test("вебхук без секрета отклоняется", async () => {
  const res = await fetch(base + "/webhook/rukassa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: deal.id, amount: deal.total })
  });
  assert.equal(res.status, 401);
});

test("вебхук с неверной валютой отклоняется", async () => {
  const res = await fetch(base + "/webhook/rukassa?secret=test-webhook-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: deal.id, amount: deal.total, currency: "RUB" })
  });
  assert.equal(res.status, 400);
});

test("вебхук с недоплатой отклоняется", async () => {
  const res = await fetch(base + "/webhook/rukassa?secret=test-webhook-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: deal.id, amount: 1, currency: "USDT" })
  });
  assert.equal(res.status, 400);
});

test("корректный вебхук переводит сделку в paid", async () => {
  const res = await fetch(base + "/webhook/rukassa?secret=test-webhook-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: deal.id, amount: deal.total, currency: "USDT" })
  });
  assert.equal(res.status, 200);
});

test("покупатель не может отметить исполнение (fulfilled — только продавец)", async () => {
  const res = await api("POST", `/api/deals/${deal.id}/status`, {
    user: BUYER,
    body: { status: "fulfilled" }
  });
  assert.equal(res.status, 403);
});

test("продавец отмечает исполнение", async () => {
  const res = await api("POST", `/api/deals/${deal.id}/status`, {
    user: SELLER,
    body: { status: "fulfilled" }
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "fulfilled");
});

test("продавец не может сам подтвердить приёмку (completed — только покупатель)", async () => {
  const res = await api("POST", `/api/deals/${deal.id}/status`, {
    user: SELLER,
    body: { status: "completed" }
  });
  assert.equal(res.status, 403);
});

test("покупатель подтверждает приёмку", async () => {
  const res = await api("POST", `/api/deals/${deal.id}/status`, {
    user: BUYER,
    body: { status: "completed" }
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "completed");
});

/* ---------- Админ-доступ ---------- */

test("админ-эндпоинты закрыты для обычного пользователя", async () => {
  const res = await api("GET", "/api/admin/deals", { user: BUYER });
  assert.equal(res.status, 403);
});

test("локальный обход отключён в production: env недоступен без прав", async () => {
  const res = await fetch(base + "/api/admin/env");
  assert.equal(res.status, 401);
});

test("админ получает доступ к админ-эндпоинтам", async () => {
  const res = await api("GET", "/api/admin/deals", { user: ADMIN });
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list) && list.length >= 1);
});

/* ---------- Управление гарантом: mark-paid и решение споров ---------- */

async function createDeal(user, overrides) {
  const res = await api("POST", "/api/deals", {
    user,
    body: {
      title: "Управляемая сделка",
      terms: "Условия",
      counterparty: "@" + BUYER.username,
      amount: 200,
      currency: "USDT",
      method: "bitpapa",
      role: "seller",
      ...(overrides || {})
    }
  });
  assert.equal(res.status, 200);
  return res.json();
}

test("обычный пользователь не может подтвердить оплату (mark-paid)", async () => {
  const d = await createDeal(SELLER);
  const res = await api("POST", `/api/deals/${d.id}/mark-paid`, { user: BUYER });
  assert.equal(res.status, 403);
});

test("гарант подтверждает оплату через mark-paid", async () => {
  const d = await createDeal(SELLER);
  const res = await api("POST", `/api/deals/${d.id}/mark-paid`, { user: ADMIN });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "paid");
});

test("гарант решает спор в пользу продавца → completed", async () => {
  const d = await createDeal(SELLER);
  // довести до спора: оплата (mark-paid) → покупатель открывает спор
  await api("POST", `/api/deals/${d.id}/mark-paid`, { user: ADMIN });
  const disp = await api("POST", `/api/deals/${d.id}/status`, {
    user: BUYER,
    body: { status: "dispute" }
  });
  assert.equal(disp.status, 200);
  const res = await api("POST", `/api/admin/deals/${d.id}/resolve`, {
    user: ADMIN,
    body: { resolution: "seller" }
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "completed");
});

test("решение спора обычным пользователем отклоняется", async () => {
  const d = await createDeal(SELLER);
  await api("POST", `/api/deals/${d.id}/mark-paid`, { user: ADMIN });
  await api("POST", `/api/deals/${d.id}/status`, { user: BUYER, body: { status: "dispute" } });
  const res = await api("POST", `/api/admin/deals/${d.id}/resolve`, {
    user: BUYER,
    body: { resolution: "buyer" }
  });
  assert.equal(res.status, 403);
});

test("некорректный resolution отклоняется", async () => {
  const d = await createDeal(SELLER);
  await api("POST", `/api/deals/${d.id}/mark-paid`, { user: ADMIN });
  await api("POST", `/api/deals/${d.id}/status`, { user: BUYER, body: { status: "dispute" } });
  const res = await api("POST", `/api/admin/deals/${d.id}/resolve`, {
    user: ADMIN,
    body: { resolution: "nobody" }
  });
  assert.equal(res.status, 400);
});

/* ---------- Login Widget → токен сессии ---------- */

test("вход через Login Widget выдаёт рабочий токен", async () => {
  const fields = {
    id: 555,
    first_name: "Widget",
    username: "widget_user",
    auth_date: Math.floor(Date.now() / 1000)
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const loginRes = await fetch(base + "/api/auth/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...fields, hash })
  });
  assert.equal(loginRes.status, 200);
  const { token, user } = await loginRes.json();
  assert.equal(user.id, 555);
  assert.ok(token);

  const meRes = await fetch(base + "/api/me", {
    headers: { "X-Auth-Token": token }
  });
  assert.equal(meRes.status, 200);
  assert.equal((await meRes.json()).user.id, 555);
});

test("вход с неверной подписью Login Widget отклоняется", async () => {
  const res = await fetch(base + "/api/auth/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: 556,
      first_name: "Evil",
      auth_date: Math.floor(Date.now() / 1000),
      hash: "0".repeat(64)
    })
  });
  assert.equal(res.status, 401);
});
