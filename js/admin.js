/* Отдельная страница админ-панели гаранта (admin.html).
   Авторизация: initData внутри Telegram, токен Login Widget из localStorage,
   на localhost/в демо — локальные сделки без сервера. */
(function () {
  "use strict";

  var DEFAULT_CFG = window.NORTHCAT_CONFIG || {};
  var STORAGE_DEALS = "northcat_deals_v1";
  var STORAGE_AUTH = "northcat_auth_v1";
  var STORAGE_SETTINGS = "northcat_runtime_config_v1";
  var REFRESH_INTERVAL = 30000;

  var tg = window.Telegram && window.Telegram.WebApp;
  var API_BASE = "";
  var apiAvailable = false;
  var authToken = null;
  var user = null;
  var isDemoAdmin = false;

  var adminDeals = [];
  var adminFilter = "pending";
  var searchQuery = "";

  var STATUS = {
    new:       { label: "Ожидает оплаты", cls: "status--new" },
    paid:      { label: "В гаранте", cls: "status--paid" },
    fulfilled: { label: "Исполнена", cls: "status--fulfilled" },
    completed: { label: "Завершена", cls: "status--completed" },
    dispute:   { label: "Спор", cls: "status--dispute" },
    cancelled: { label: "Отменена", cls: "status--cancelled" }
  };

  function $(id) { return document.getElementById(id); }

  function isLocalHost() {
    var host = window.location.hostname;
    return host === "127.0.0.1" || host === "localhost";
  }

  function getRuntimeConfig() {
    var cfg = {};
    Object.keys(DEFAULT_CFG).forEach(function (k) { cfg[k] = DEFAULT_CFG[k]; });
    try {
      var extra = JSON.parse(localStorage.getItem(STORAGE_SETTINGS)) || {};
      Object.keys(extra).forEach(function (k) { cfg[k] = extra[k]; });
    } catch (e) { /* нет overrides */ }
    return cfg;
  }

  function fmt(n, currency) {
    var v = Math.round(n * 100) / 100;
    return v.toLocaleString("ru-RU", { maximumFractionDigits: 8 }) + (currency ? " " + currency : "");
  }

  var toastTimer = null;
  function showToast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("toast--visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("toast--visible"); }, 2400);
  }

  function showAlert(msg) {
    if (tg && tg.showAlert) tg.showAlert(msg);
    else alert(msg);
  }

  function showConfirm(msg, cb) {
    if (tg && tg.showConfirm) {
      tg.showConfirm(msg, function (ok) { if (ok) cb(); });
    } else if (confirm(msg)) {
      cb();
    }
  }

  function haptic(type) {
    if (tg && tg.HapticFeedback) {
      try {
        if (type === "success" || type === "error" || type === "warning") {
          tg.HapticFeedback.notificationOccurred(type);
        } else {
          tg.HapticFeedback.impactOccurred(type || "light");
        }
      } catch (e) { /* не критично */ }
    }
  }

  function api(method, path, body) {
    var headers = { "Content-Type": "application/json" };
    if (tg && tg.initData) headers["X-Telegram-Init-Data"] = tg.initData;
    if (authToken) headers["X-Auth-Token"] = authToken;
    return fetch(API_BASE + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function checkApiHealth(base) {
    return fetch(base + "/api/health", { method: "GET" })
      .then(function (r) { return !!r.ok; })
      .catch(function () { return false; });
  }

  function resolveApi() {
    var cfg = getRuntimeConfig();
    var raw = String(cfg.API_URL == null ? "auto" : cfg.API_URL).trim().replace(/\/+$/, "");
    var candidates = [];

    if (!raw) return Promise.resolve(false);
    if (raw === "auto") {
      if (isLocalHost() && window.location.port !== "3001") {
        candidates.push(window.location.protocol + "//" + (window.location.hostname || "127.0.0.1") + ":3001");
      }
      candidates.push("");
    } else {
      candidates.push(raw);
    }

    function tryNext(index) {
      if (index >= candidates.length) {
        API_BASE = raw === "auto" ? "" : raw;
        return false;
      }
      return checkApiHealth(candidates[index]).then(function (ok) {
        if (ok) {
          API_BASE = candidates[index];
          return true;
        }
        return tryNext(index + 1);
      });
    }
    return tryNext(0);
  }

  /* ---------- Рендер ---------- */

  function renderUser() {
    var name = user
      ? (user.first_name || "") + (user.last_name ? " " + user.last_name : "")
      : "Гарант";
    $("admin-username").textContent = name || "Гарант";
    var avatar = $("admin-avatar");
    if (user && user.photo_url) {
      avatar.innerHTML = "";
      var img = document.createElement("img");
      img.src = user.photo_url;
      img.alt = "";
      avatar.appendChild(img);
    } else {
      avatar.textContent = (name || "GA").slice(0, 1).toUpperCase() || "GA";
    }
    $("admin-mode-badge").textContent = isDemoAdmin ? "Демо" : "Админ";
  }

  function renderStats() {
    var box = $("admin-stats");
    var pending = adminDeals.filter(function (d) { return d.status === "new" && d.bitpapaClaimedAt; }).length;
    var disputes = adminDeals.filter(function (d) { return d.status === "dispute"; }).length;
    var active = adminDeals.filter(function (d) { return ["new", "paid", "fulfilled"].indexOf(d.status) >= 0; }).length;
    var completed = adminDeals.filter(function (d) { return d.status === "completed"; }).length;
    var tiles = [
      ["Всего", adminDeals.length],
      ["Активных", active],
      ["Ожидают оплату", pending],
      ["Споры", disputes],
      ["Завершено", completed]
    ];
    box.innerHTML = "";
    tiles.forEach(function (t) {
      var card = document.createElement("div");
      card.className = "stat-card";
      var v = document.createElement("div");
      v.className = "stat-value";
      v.textContent = t[1];
      var l = document.createElement("div");
      l.className = "stat-label";
      l.textContent = t[0];
      card.appendChild(v);
      card.appendChild(l);
      box.appendChild(card);
    });
  }

  function dealMatchesFilter(d) {
    if (adminFilter === "pending") return d.status === "new" && d.bitpapaClaimedAt;
    if (adminFilter === "dispute") return d.status === "dispute";
    if (adminFilter === "active") return ["new", "paid", "fulfilled"].indexOf(d.status) >= 0;
    if (adminFilter === "completed") return d.status === "completed";
    return true;
  }

  function dealMatchesSearch(d) {
    if (!searchQuery) return true;
    var haystack = [d.id, d.title, d.counterparty, d.ownerUsername, d.ownerName]
      .join(" ").toLowerCase();
    return haystack.indexOf(searchQuery) >= 0;
  }

  function renderList() {
    var list = $("admin-list");
    list.innerHTML = "";
    var visible = adminDeals
      .filter(dealMatchesFilter)
      .filter(dealMatchesSearch)
      .sort(function (a, b) { return b.createdAt - a.createdAt; });

    $("admin-empty").classList.toggle("empty-state--visible", visible.length === 0);

    var meta = $("admin-search-meta");
    if (searchQuery) {
      meta.hidden = false;
      meta.textContent = "Поиск «" + searchQuery + "»: найдено " + visible.length;
    } else {
      meta.hidden = true;
    }

    visible.forEach(function (deal) {
      var li = document.createElement("li");
      li.className = "deal-item";

      var st = STATUS[deal.status] || STATUS.new;
      var top = document.createElement("div");
      top.className = "deal-item-top";
      var title = document.createElement("span");
      title.className = "deal-item-title";
      title.textContent = deal.title;
      var chip = document.createElement("span");
      chip.className = "status-chip " + st.cls;
      chip.textContent = st.label;
      top.appendChild(title);
      top.appendChild(chip);

      var bottom = document.createElement("div");
      bottom.className = "deal-item-bottom";
      var info = document.createElement("span");
      info.textContent = deal.id + " · " + (deal.counterparty || "—");
      var amount = document.createElement("span");
      amount.className = "deal-item-amount";
      amount.textContent = fmt(deal.total, deal.currency);
      bottom.appendChild(info);
      bottom.appendChild(amount);

      li.appendChild(top);
      li.appendChild(bottom);

      var actions = buildActions(deal);
      if (actions) li.appendChild(actions);

      list.appendChild(li);
    });
  }

  function buildActions(deal) {
    var row = document.createElement("div");
    row.className = "deal-item-actions";

    function actionBtn(label, cls, handler) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn--small " + cls;
      b.textContent = label;
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        handler();
      });
      row.appendChild(b);
    }

    if (deal.status === "new") {
      actionBtn("Подтвердить оплату", "btn--green", function () { markPaid(deal); });
    } else if (deal.status === "dispute") {
      actionBtn("Продавцу", "btn--green", function () { resolveDispute(deal, "seller"); });
      actionBtn("Покупателю", "btn--danger", function () { resolveDispute(deal, "buyer"); });
    } else {
      return null;
    }
    return row;
  }

  /* ---------- Действия гаранта ---------- */

  function markPaid(deal) {
    if (isDemoAdmin) {
      showAlert("Демо-режим: подтверждение оплаты доступно при подключённом бэкенде.");
      return;
    }
    showConfirm("Подтвердить оплату по сделке " + deal.id + "? Средства будут считаться заблокированными у гаранта.", function () {
      api("POST", "/api/deals/" + deal.id + "/mark-paid", {}).then(function () {
        haptic("success");
        showToast("Оплата по " + deal.id + " подтверждена");
        loadDeals();
      }).catch(function () {
        showAlert("Не удалось подтвердить оплату (возможно, сделка уже оплачена).");
      });
    });
  }

  function resolveDispute(deal, resolution) {
    if (isDemoAdmin) {
      showAlert("Демо-режим: решение споров доступно при подключённом бэкенде.");
      return;
    }
    var label = resolution === "seller" ? "в пользу продавца (выплата)" : "в пользу покупателя (возврат)";
    showConfirm("Решить спор " + deal.id + " " + label + "?", function () {
      api("POST", "/api/admin/deals/" + deal.id + "/resolve", { resolution: resolution }).then(function () {
        haptic("success");
        showToast("Спор " + deal.id + " решён");
        loadDeals();
      }).catch(function () {
        showAlert("Не удалось решить спор.");
      });
    });
  }

  /* ---------- Данные ---------- */

  function loadDeals() {
    if (isDemoAdmin) {
      try {
        adminDeals = JSON.parse(localStorage.getItem(STORAGE_DEALS)) || [];
      } catch (e) {
        adminDeals = [];
      }
      renderStats();
      renderList();
      return;
    }
    api("GET", "/api/admin/deals").then(function (list) {
      adminDeals = Array.isArray(list) ? list : [];
      renderStats();
      renderList();
    }).catch(function () {
      showAlert("Не удалось загрузить сделки. Нужны права гаранта.");
    });
  }

  function showDenied(text) {
    if (text) $("admin-denied-text").textContent = text;
    $("admin-denied").hidden = false;
  }

  function startPanel() {
    renderUser();
    if (isDemoAdmin) {
      $("admin-subtitle").textContent =
        "Демо-режим: показаны локальные сделки этого устройства. Действия гаранта работают при подключённом бэкенде.";
    }
    loadDeals();
    setInterval(function () {
      if (!isDemoAdmin && !document.hidden) loadDeals();
    }, REFRESH_INTERVAL);
  }

  /* ---------- Авторизация ---------- */

  function initAuth() {
    // 1. Внутри Telegram — initData
    var tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (tgUser && apiAvailable) {
      user = tgUser;
      api("GET", "/api/me").then(function (res) {
        if (res && res.isAdmin) {
          startPanel();
        } else {
          renderUser();
          showDenied("У вашего аккаунта нет прав гаранта. Доступ выдаётся по Telegram ID в ADMIN_IDS.");
        }
      }).catch(function () {
        renderUser();
        showDenied("Не удалось проверить права. Попробуйте позже.");
      });
      return;
    }

    // 2. Сессия Login Widget из основного приложения
    var stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_AUTH));
    } catch (e) { /* нет сессии */ }
    if (stored && stored.user && !stored.user.demo && stored.token && apiAvailable) {
      user = stored.user;
      authToken = stored.token;
      api("GET", "/api/me").then(function (res) {
        if (res && res.isAdmin) startPanel();
        else {
          renderUser();
          showDenied("У вашего аккаунта нет прав гаранта.");
        }
      }).catch(function () {
        renderUser();
        showDenied("Сессия устарела. Войдите заново через основное приложение.");
      });
      return;
    }

    // 3. Локальный запуск или демо: панель с локальными данными
    if (isLocalHost() || tgUser || (stored && stored.user)) {
      user = tgUser || (stored && stored.user) || { id: 0, first_name: "Local Admin" };
      isDemoAdmin = true;
      startPanel();
      return;
    }

    // 4. Браузер без сессии
    showDenied("Откройте админ-панель из Telegram (бот → «Открыть админ-панель») или войдите в основном приложении.");
  }

  /* ---------- Обработчики ---------- */

  document.querySelectorAll("#admin-filter-row .chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      haptic("light");
      adminFilter = chip.getAttribute("data-admin-filter");
      document.querySelectorAll("#admin-filter-row .chip").forEach(function (c) {
        c.classList.toggle("chip--active", c === chip);
      });
      renderList();
    });
  });

  $("admin-search-form").addEventListener("submit", function (e) {
    e.preventDefault();
    searchQuery = $("admin-search-input").value.trim().toLowerCase();
    renderList();
  });

  $("admin-search-input").addEventListener("input", function () {
    if (!this.value.trim()) {
      searchQuery = "";
      renderList();
    }
  });

  $("admin-refresh").addEventListener("click", function () {
    haptic("light");
    loadDeals();
    showToast("Обновлено");
  });

  $("admin-settings-link").addEventListener("click", function () {
    window.location.href = "settings.html";
  });

  ["admin-app-link", "admin-goto-app"].forEach(function (id) {
    var btn = $(id);
    if (btn) btn.addEventListener("click", function () {
      window.location.href = "index.html";
    });
  });

  /* ---------- Инициализация ---------- */

  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor("secondary_bg_color");
  }

  resolveApi().then(function (ok) {
    apiAvailable = ok;
    initAuth();
  });
})();
