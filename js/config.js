// Конфигурация CRB GA — гарант сделок
window.NORTHCAT_CONFIG = {
  // URL бэкенда (backend/server.js).
  // "auto" — бэкенд на том же домене (проверяется /api/health, иначе демо-режим);
  // ""     — принудительный демо-режим (сделки локально, оплата симулируется);
  // иначе  — полный адрес бэкенда, например "https://garant.example.com".
  API_URL: "auto",

  // Username бота (без @) — нужен для Telegram Login Widget при входе из браузера.
  // Домен приложения должен быть привязан к боту: @BotFather → /setdomain.
  BOT_USERNAME: "CRBGABOT",

  // Комиссия гаранта в процентах
  FEE_PERCENT: 5,

  // Username поддержки / арбитра (без @)
  SUPPORT_USERNAME: "northcat_support",

  // Username аккаунта Bitpapa, на который покупатель отправляет перевод
  BITPAPA_ACCOUNT: "northcat_garant",

  // Способы оплаты.
  // kind: "telegram" — счёт открывается внутри Telegram (xRocket);
  //       "manual"   — перевод по реквизитам с кодом сделки (Bitpapa);
  //       "redirect" — бэкенд создаёт счёт в платёжном шлюзе и возвращает ссылку.
  PAY_METHODS: [
    { id: "xrocket", name: "xRocket",  mark: "XR", hint: "Крипто-счёт в Telegram",            kind: "telegram" },
    { id: "bitpapa", name: "Bitpapa",  mark: "BP", hint: "P2P-перевод с кодом сделки",        kind: "manual" },
    { id: "pgon",    name: "PGon",     mark: "PG", hint: "Платёжный шлюз",                    kind: "redirect" },
    { id: "nicepay", name: "NicePay",  mark: "NP", hint: "Карты и криптовалюта",              kind: "redirect" },
    { id: "rukassa", name: "RuKassa",  mark: "RK", hint: "Карты, СБП, криптовалюта",          kind: "redirect" }
  ]
};
