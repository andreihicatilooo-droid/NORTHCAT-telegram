// Конфигурация NORTHCAT Гарант
window.NORTHCAT_CONFIG = {
  // URL бэкенда (backend/server.js). Пустая строка = демо-режим:
  // сделки хранятся локально, оплата симулируется.
  API_URL: "",

  // Комиссия гаранта в процентах
  FEE_PERCENT: 5,

  // Username поддержки / арбитра (без @)
  SUPPORT_USERNAME: "northcat_support",

  // Username аккаунта Bitpapa, на который покупатель отправляет перевод
  // (сделку подтверждает гарант вручную или бэкенд по API Bitpapa)
  BITPAPA_ACCOUNT: "northcat_garant"
};
