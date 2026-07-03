(function () {
  "use strict";

  var CFG = window.NORTHCAT_CONFIG || {};
  var FEE_PERCENT = CFG.FEE_PERCENT != null ? CFG.FEE_PERCENT : 5;
  var METHODS = CFG.PAY_METHODS || [];

  // API_URL: "" — демо; "auto" — тот же домен (если бэкенд отвечает); иначе адрес бэкенда
  var API_BASE = "";
  var apiAvailable = false;

  function resolveApi() {
    var raw = (CFG.API_URL || "").replace(/\/+$/, "");
    if (!raw) return Promise.resolve(false);
    API_BASE = raw === "auto" ? "" : raw;
    return fetch(API_BASE + "/api/health", { method: "GET" })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }

  // Демо-режим: бэкенда нет или пользователь вошёл как гость
  function isDemo() {
    return !apiAvailable || (user && user.demo);
  }

  var tg = window.Telegram && window.Telegram.WebApp;

  var STORAGE_DEALS = "northcat_deals_v1";
  var STORAGE_AUTH = "northcat_auth_v1";

  var STATUS = {
    new:       { label: "Ожидает оплаты", cls: "status--new" },
    paid:      { label: "В гаранте", cls: "status--paid" },
    fulfilled: { label: "Исполнена", cls: "status--fulfilled" },
    completed: { label: "Завершена", cls: "status--completed" },
    dispute:   { label: "Спор", cls: "status--dispute" },
    cancelled: { label: "Отменена", cls: "status--cancelled" }
  };

  var TIMELINE_STEPS = [
    { status: "new",       label: "Сделка создана" },
    { status: "paid",      label: "Оплата получена — средства заблокированы у гаранта" },
    { status: "fulfilled", label: "Продавец исполнил условия" },
    { status: "completed", label: "Приёмка подтверждена — выплата продавцу" }
  ];

  var deals = [];
  var currentFilter = "all";
  var currentDealId = null;
  var createRole = "seller";

  var user = null;       // { id, first_name, last_name?, username?, photo_url? }
  var authToken = null;  // токен сессии для входа через Login Widget

  /* ---------- Telegram init ---------- */

  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.setHeaderColor) tg.setHeaderColor("secondary_bg_color");
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

  /* ---------- Авторизация ---------- */

  function getStoredAuth() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_AUTH));
    } catch (e) {
      return null;
    }
  }

  function setAuth(u, token) {
    user = u;
    authToken = token || null;
    localStorage.setItem(STORAGE_AUTH, JSON.stringify({ user: u, token: authToken }));
    $("screen-auth").hidden = true;
    $("logout-button").hidden = false;
    renderUser();
    loadDeals();
    checkAdmin();
  }

  function initAuth() {
    // 1. Запуск внутри Telegram — авторизация по initData
    var tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (tgUser) {
      user = tgUser;
      renderUser();
      loadDeals();
      checkAdmin();
      return;
    }

    // 2. Сохранённая сессия (вход через Login Widget или демо)
    var stored = getStoredAuth();
    if (stored && stored.user) {
      user = stored.user;
      authToken = stored.token || null;
      $("logout-button").hidden = false;
      renderUser();
      loadDeals();
      checkAdmin();
      return;
    }

    // 3. Браузер без сессии — экран входа
    showAuthScreen();
  }

  function showAuthScreen() {
    $("screen-auth").hidden = false;

    // Telegram Login Widget (нужен BOT_USERNAME и /setdomain у @BotFather)
    if (CFG.BOT_USERNAME && !$("tg-login-widget").hasChildNodes()) {
      window.onTelegramAuth = function (widgetUser) {
        if (isDemo()) {
          setAuth(widgetUser, null);
          return;
        }
        // Бэкенд проверяет подпись виджета и выдаёт токен сессии
        fetch(API_BASE + "/api/auth/telegram", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(widgetUser)
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (res && res.token) setAuth(res.user, res.token);
          else showAlert("Не удалось подтвердить вход через Telegram.");
        }).catch(function () {
          showAlert("Ошибка входа. Попробуйте позже.");
        });
      };
      var s = document.createElement("script");
      s.src = "https://telegram.org/js/telegram-widget.js?22";
      s.setAttribute("data-telegram-login", CFG.BOT_USERNAME);
      s.setAttribute("data-size", "medium");
      s.setAttribute("data-radius", "8");
      s.setAttribute("data-onauth", "onTelegramAuth(user)");
      s.setAttribute("data-request-access", "write");
      $("tg-login-widget").appendChild(s);
    }
  }

  $("guest-login").addEventListener("click", function () {
    setAuth({ id: 0, first_name: "Гость", demo: true }, null);
  });

  $("logout-button").addEventListener("click", function () {
    localStorage.removeItem(STORAGE_AUTH);
    location.reload();
  });

  function myUsername() {
    if (user && user.username) return "@" + user.username;
    if (user) return user.first_name || "Я";
    return "Я";
  }

  function renderUser() {
    if (!user) return;
    var name = user.first_name + (user.last_name ? " " + user.last_name : "");
    $("username").textContent = name;
    $("profile-name").textContent = name;
    $("profile-id").textContent = user.demo
      ? "Демо-режим"
      : (user.username ? "@" + user.username + " · " : "") + "ID " + user.id;

    var initials = (user.first_name || "N").slice(0, 1).toUpperCase() +
      (user.last_name ? user.last_name.slice(0, 1).toUpperCase() : "");
    ["avatar", "profile-avatar"].forEach(function (id) {
      var el = $(id);
      if (user.photo_url) {
        el.innerHTML = "";
        var img = document.createElement("img");
        img.src = user.photo_url;
        img.alt = "";
        el.appendChild(img);
      } else {
        el.textContent = initials || "NC";
      }
    });
  }

  /* ---------- Хранилище ---------- */

  function loadDeals() {
    if (isDemo()) {
      try {
        deals = JSON.parse(localStorage.getItem(STORAGE_DEALS)) || [];
      } catch (e) {
        deals = [];
      }
      renderDeals();
      renderStats();
      return;
    }
    api("GET", "/api/deals").then(function (list) {
      deals = list || [];
      renderDeals();
      renderStats();
    }).catch(function () {
      showAlert("Не удалось загрузить сделки. Проверьте соединение.");
    });
  }

  function saveDeals() {
    if (isDemo()) {
      localStorage.setItem(STORAGE_DEALS, JSON.stringify(deals));
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

  /* ---------- Утилиты ---------- */

  function $(id) { return document.getElementById(id); }

  function methodById(id) {
    for (var i = 0; i < METHODS.length; i++) {
      if (METHODS[i].id === id) return METHODS[i];
    }
    return { id: id, name: id, kind: "manual", mark: "—" };
  }

  function fmt(n, currency) {
    var v = Math.round(n * 100) / 100;
    return v.toLocaleString("ru-RU", { maximumFractionDigits: 8 }) + (currency ? " " + currency : "");
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString("ru-RU") + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
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

  function openExternal(link) {
    if (tg && tg.openLink) tg.openLink(link);
    else window.open(link, "_blank");
  }

  function findDeal(id) {
    for (var i = 0; i < deals.length; i++) {
      if (deals[i].id === id) return deals[i];
    }
    return null;
  }

  /* ---------- Навигация ---------- */

  function showScreen(id) {
    var screens = document.querySelectorAll(".screen");
    for (var i = 0; i < screens.length; i++) {
      screens[i].classList.toggle("screen--active", screens[i].id === id);
    }
    var tabs = document.querySelectorAll(".tab");
    for (var j = 0; j < tabs.length; j++) {
      tabs[j].classList.toggle("tab--active", tabs[j].getAttribute("data-screen") === id);
    }
    if (tg && tg.BackButton) {
      if (id === "screen-deal") tg.BackButton.show();
      else tg.BackButton.hide();
    }
  }

  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      haptic("light");
      var id = tab.getAttribute("data-screen");
      showScreen(id);
      if (id === "screen-admin") loadAdminDeals();
    });
  });

  if (tg && tg.BackButton) {
    tg.BackButton.onClick(function () {
      showScreen("screen-deals");
    });
  }

  /* ---------- Список сделок ---------- */

  function dealMatchesFilter(deal) {
    if (currentFilter === "all") return true;
    if (currentFilter === "active") return deal.status === "new" || deal.status === "paid" || deal.status === "fulfilled";
    if (currentFilter === "completed") return deal.status === "completed" || deal.status === "cancelled";
    if (currentFilter === "dispute") return deal.status === "dispute";
    return true;
  }

  function renderDeals() {
    var list = $("deal-list");
    list.innerHTML = "";
    var visible = deals.filter(dealMatchesFilter);

    $("deals-empty").classList.toggle("empty-state--visible", visible.length === 0);

    visible
      .slice()
      .sort(function (a, b) { return b.createdAt - a.createdAt; })
      .forEach(function (deal) {
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
        var meta = document.createElement("span");
        meta.textContent = (deal.role === "seller" ? "Продажа · " : "Покупка · ") + deal.counterparty;
        var amount = document.createElement("span");
        amount.className = "deal-item-amount";
        amount.textContent = fmt(deal.amount, deal.currency);
        bottom.appendChild(meta);
        bottom.appendChild(amount);

        li.appendChild(top);
        li.appendChild(bottom);
        li.addEventListener("click", function () {
          haptic("light");
          openDeal(deal.id);
        });
        list.appendChild(li);
      });
  }

  document.querySelectorAll("#filter-row .chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      haptic("light");
      currentFilter = chip.getAttribute("data-filter");
      document.querySelectorAll("#filter-row .chip").forEach(function (c) {
        c.classList.toggle("chip--active", c === chip);
      });
      renderDeals();
    });
  });

  /* ---------- Создание сделки ---------- */

  function renderPayMethods() {
    var box = $("pay-methods");
    box.innerHTML = "";
    METHODS.forEach(function (m, i) {
      var label = document.createElement("label");
      label.className = "pay-method";

      var input = document.createElement("input");
      input.type = "radio";
      input.name = "pay-method";
      input.value = m.id;
      if (i === 0) input.checked = true;

      var card = document.createElement("span");
      card.className = "pay-method-card";

      var mark = document.createElement("span");
      mark.className = "pay-method-mark";
      mark.textContent = m.mark || m.name.slice(0, 2).toUpperCase();

      var body = document.createElement("span");
      body.className = "pay-method-body";
      var name = document.createElement("span");
      name.className = "pay-method-name";
      name.textContent = m.name;
      var hint = document.createElement("span");
      hint.className = "pay-method-hint";
      hint.textContent = m.hint || "";
      body.appendChild(name);
      body.appendChild(document.createElement("br"));
      body.appendChild(hint);

      card.appendChild(mark);
      card.appendChild(body);
      label.appendChild(input);
      label.appendChild(card);
      box.appendChild(label);
    });
  }

  $("new-deal-button").addEventListener("click", function () {
    haptic("light");
    showScreen("screen-create");
  });

  $("create-cancel").addEventListener("click", function () {
    showScreen("screen-deals");
  });

  document.querySelectorAll("#role-segment .segment-item").forEach(function (btn) {
    btn.addEventListener("click", function () {
      haptic("light");
      createRole = btn.getAttribute("data-role");
      document.querySelectorAll("#role-segment .segment-item").forEach(function (b) {
        b.classList.toggle("segment-item--active", b === btn);
      });
    });
  });

  function recalcFee() {
    var amount = parseFloat($("deal-amount").value);
    var currency = $("deal-currency").value;
    $("fee-percent").textContent = FEE_PERCENT;
    if (!isFinite(amount) || amount <= 0) {
      $("fee-amount").textContent = "—";
      $("fee-value").textContent = "—";
      $("fee-total").textContent = "—";
      return;
    }
    var fee = amount * FEE_PERCENT / 100;
    $("fee-amount").textContent = fmt(amount, currency);
    $("fee-value").textContent = fmt(fee, currency);
    $("fee-total").textContent = fmt(amount + fee, currency);
  }

  $("deal-amount").addEventListener("input", recalcFee);
  $("deal-currency").addEventListener("change", recalcFee);

  $("create-form").addEventListener("submit", function (e) {
    e.preventDefault();

    var counterparty = $("counterparty").value.trim();
    if (counterparty && counterparty[0] !== "@") counterparty = "@" + counterparty;
    var amount = parseFloat($("deal-amount").value);
    if (!isFinite(amount) || amount <= 0) {
      showAlert("Укажите корректную сумму сделки.");
      return;
    }

    var checked = document.querySelector('input[name="pay-method"]:checked');
    var method = checked ? checked.value : METHODS[0].id;
    var fee = amount * FEE_PERCENT / 100;

    var deal = {
      id: "CRB-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(),
      title: $("deal-title").value.trim(),
      terms: $("deal-terms").value.trim(),
      amount: amount,
      currency: $("deal-currency").value,
      method: method,
      role: createRole,
      counterparty: counterparty,
      feePercent: FEE_PERCENT,
      fee: fee,
      total: amount + fee,
      status: "new",
      createdAt: Date.now(),
      history: [{ status: "new", ts: Date.now() }]
    };

    if (isDemo()) {
      deals.push(deal);
      saveDeals();
      afterCreate(deal);
    } else {
      api("POST", "/api/deals", deal).then(function (saved) {
        deals.push(saved);
        afterCreate(saved);
      }).catch(function () {
        showAlert("Не удалось создать сделку. Попробуйте ещё раз.");
      });
    }
  });

  function afterCreate(deal) {
    haptic("success");
    $("create-form").reset();
    renderPayMethods();
    recalcFee();
    renderDeals();
    renderStats();
    openDeal(deal.id);
    showAlert("Сделка " + deal.id + " создана. Передайте её ID контрагенту (" + deal.counterparty + ").");
  }

  /* ---------- Экран сделки ---------- */

  function openDeal(id) {
    var deal = findDeal(id);
    if (!deal) return;
    currentDealId = id;

    var st = STATUS[deal.status] || STATUS.new;
    $("deal-view-title").textContent = deal.title;
    var chip = $("deal-view-status");
    chip.textContent = st.label;
    chip.className = "status-chip " + st.cls;
    $("deal-view-code").textContent = "ID " + deal.id;

    var seller = deal.role === "seller" ? myUsername() : deal.counterparty;
    var buyer = deal.role === "buyer" ? myUsername() : deal.counterparty;
    $("deal-view-seller").textContent = seller;
    $("deal-view-buyer").textContent = buyer;
    $("deal-view-amount").textContent = fmt(deal.amount, deal.currency);
    $("deal-view-fee").textContent = fmt(deal.fee, deal.currency) + " (" + deal.feePercent + "%)";
    $("deal-view-total").textContent = fmt(deal.total, deal.currency);
    $("deal-view-method").textContent = methodById(deal.method).name;
    $("deal-view-terms").textContent = deal.terms;

    renderTimeline(deal);
    renderActions(deal);
    showScreen("screen-deal");
  }

  function renderTimeline(deal) {
    var ol = $("deal-timeline");
    ol.innerHTML = "";

    if (deal.status === "cancelled" || deal.status === "dispute") {
      var li = document.createElement("li");
      li.className = "done";
      li.textContent = deal.status === "cancelled" ? "Сделка отменена" : "Открыт спор — рассматривает арбитр";
      var when = historyTs(deal, deal.status);
      if (when) {
        var d = document.createElement("span");
        d.className = "timeline-date";
        d.textContent = fmtDate(when);
        li.appendChild(d);
      }
      ol.appendChild(li);
      return;
    }

    var reached = true;
    TIMELINE_STEPS.forEach(function (step) {
      var li = document.createElement("li");
      li.textContent = step.label;
      var ts = historyTs(deal, step.status);
      if (ts) {
        li.className = deal.status === step.status && step.status !== "completed" ? "current" : "done";
        var d = document.createElement("span");
        d.className = "timeline-date";
        d.textContent = fmtDate(ts);
        li.appendChild(d);
      } else if (reached) {
        li.className = "current";
        reached = false;
      }
      if (ts && deal.status === step.status) reached = false;
      ol.appendChild(li);
    });
  }

  function historyTs(deal, status) {
    for (var i = 0; i < (deal.history || []).length; i++) {
      if (deal.history[i].status === status) return deal.history[i].ts;
    }
    return null;
  }

  function renderActions(deal) {
    var box = $("deal-actions");
    box.innerHTML = "";

    function button(label, cls, handler) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn " + (cls || "btn--primary");
      b.textContent = label;
      b.addEventListener("click", handler);
      box.appendChild(b);
      return b;
    }

    function note(text) {
      var p = document.createElement("p");
      p.className = "action-note";
      p.textContent = text;
      box.appendChild(p);
    }

    var isSeller = deal.role === "seller";

    switch (deal.status) {
      case "new":
        if (!isSeller) {
          button("Оплатить через " + methodById(deal.method).name, "btn--primary", function () {
            payDeal(deal);
          });
        } else {
          note("Ожидается оплата от покупателя " + deal.counterparty + ". Средства будут заблокированы у гаранта.");
        }
        button("Отменить сделку", "btn--danger", function () {
          showConfirm("Отменить сделку " + deal.id + "?", function () {
            setStatus(deal, "cancelled");
          });
        });
        break;

      case "paid":
        if (isSeller) {
          button("Условия исполнены", "btn--green", function () {
            showConfirm("Подтвердить, что товар передан и условия исполнены?", function () {
              setStatus(deal, "fulfilled");
            });
          });
        } else {
          note("Оплата заблокирована у гаранта. Ожидается исполнение условий продавцом.");
        }
        button("Открыть спор", "btn--danger", function () {
          showConfirm("Открыть спор по сделке? Арбитр изучит условия и переписку.", function () {
            setStatus(deal, "dispute");
          });
        });
        break;

      case "fulfilled":
        if (!isSeller) {
          button("Подтвердить приёмку", "btn--green", function () {
            showConfirm("Подтвердить приёмку? Гарант выплатит продавцу " + fmt(deal.amount, deal.currency) + ".", function () {
              setStatus(deal, "completed");
            });
          });
        } else {
          note("Ожидается подтверждение приёмки покупателем. После подтверждения гарант выплатит " + fmt(deal.amount, deal.currency) + ".");
        }
        button("Открыть спор", "btn--danger", function () {
          showConfirm("Открыть спор по сделке?", function () {
            setStatus(deal, "dispute");
          });
        });
        break;

      case "dispute":
        note("Спор рассматривает арбитр. Подготовьте переписку и доказательства.");
        button("Связаться с арбитром", "btn--outline", function () {
          openSupport();
        });
        break;

      case "completed":
        note("Сделка завершена.");
        break;

      case "cancelled":
        note("Сделка отменена." + (historyTs(deal, "paid") ? " Внесённые средства возвращает гарант." : ""));
        break;
    }

    // Демо-режим: симуляция действий контрагента для проверки флоу
    if (isDemo() && (deal.status === "new" || deal.status === "paid" || deal.status === "fulfilled")) {
      var simLabel = {
        new: "Демо: контрагент оплатил",
        paid: "Демо: продавец исполнил условия",
        fulfilled: "Демо: покупатель подтвердил приёмку"
      }[deal.status];
      var next = { new: "paid", paid: "fulfilled", fulfilled: "completed" }[deal.status];
      var ownAction =
        (deal.status === "new" && !isSeller) ||
        (deal.status === "paid" && isSeller) ||
        (deal.status === "fulfilled" && !isSeller);
      if (!ownAction) {
        button(simLabel, "btn--outline", function () { setStatus(deal, next); });
      }
    }
  }

  function setStatus(deal, status) {
    function apply() {
      saveDeals();
      haptic(status === "dispute" || status === "cancelled" ? "warning" : "success");
      renderDeals();
      renderStats();
      openDeal(deal.id);
    }
    if (isDemo()) {
      deal.status = status;
      deal.history = deal.history || [];
      deal.history.push({ status: status, ts: Date.now() });
      apply();
    } else {
      api("POST", "/api/deals/" + deal.id + "/status", { status: status }).then(function (saved) {
        deal.status = saved.status;
        deal.history = saved.history;
        apply();
      }).catch(function () {
        showAlert("Не удалось обновить сделку.");
      });
    }
  }

  /* ---------- Оплата ---------- */

  function payDeal(deal) {
    haptic("medium");
    var m = methodById(deal.method);

    // Bitpapa и другие ручные переводы: реквизиты + код сделки
    if (m.kind === "manual") {
      var msg =
        "Оплата через " + m.name + ":\n\n" +
        "1. Переведите " + fmt(deal.total, deal.currency) + " на аккаунт @" + (CFG.BITPAPA_ACCOUNT || "гаранта") + ".\n" +
        "2. В комментарии укажите код сделки: " + deal.id + "\n" +
        "3. После проверки перевода гарант отметит сделку оплаченной.";
      if (isDemo()) {
        showConfirm(msg + "\n\nДемо-режим: отметить сделку оплаченной?", function () {
          setStatus(deal, "paid");
        });
      } else {
        showAlert(msg);
        api("POST", "/api/deals/" + deal.id + "/bitpapa-claim", {}).catch(function () { /* необязательно */ });
      }
      return;
    }

    // xRocket (счёт в Telegram) и шлюзы PGon / NicePay / RuKassa (ссылка на оплату)
    if (isDemo()) {
      showConfirm(
        "Демо-режим: будет симулирована оплата " + fmt(deal.total, deal.currency) +
        " через " + m.name + ". В боевом режиме откроется страница оплаты.",
        function () { setStatus(deal, "paid"); }
      );
      return;
    }

    api("POST", "/api/deals/" + deal.id + "/invoice", {}).then(function (res) {
      if (res && res.link) {
        if (m.kind === "telegram" && tg && tg.openTelegramLink) tg.openTelegramLink(res.link);
        else openExternal(res.link);
      } else {
        showAlert("Не удалось создать счёт " + m.name + ".");
      }
    }).catch(function () {
      showAlert("Не удалось создать счёт " + m.name + ". Попробуйте позже.");
    });
  }

  /* ---------- Профиль и статистика ---------- */

  function renderStats() {
    var total = deals.length;
    var completed = deals.filter(function (d) { return d.status === "completed"; }).length;
    var turnover = deals.reduce(function (sum, d) {
      return d.status === "completed" && d.currency === "USDT" ? sum + d.amount : sum;
    }, 0);
    $("stat-total").textContent = total;
    $("stat-completed").textContent = completed;
    $("stat-turnover").textContent = fmt(turnover);
    $("stat-fee").textContent = FEE_PERCENT + "%";
  }

  function openSupport() {
    var link = "https://t.me/" + (CFG.SUPPORT_USERNAME || "northcat_support");
    if (tg && tg.openTelegramLink) tg.openTelegramLink(link);
    else window.open(link, "_blank");
  }

  $("support-button").addEventListener("click", openSupport);
  $("deal-back").addEventListener("click", function () { showScreen("screen-deals"); });

  /* ---------- Админ-панель ---------- */

  var isAdmin = false;

  // После входа в боевом режиме узнаём права: гаранту открывается вкладка «Админ»
  function checkAdmin() {
    if (isDemo()) return;
    api("GET", "/api/me").then(function (me) {
      isAdmin = !!(me && me.isAdmin);
      $("tab-admin").hidden = !isAdmin;
    }).catch(function () { /* не критично */ });
  }

  function loadAdminDeals() {
    if (!isAdmin) return;
    api("GET", "/api/admin/deals").then(renderAdmin).catch(function () {
      showAlert("Не удалось загрузить сделки.");
    });
  }

  function renderAdmin(all) {
    all = all || [];
    var active = all.filter(function (d) { return d.status === "new" || d.status === "paid" || d.status === "fulfilled"; });
    var disputes = all.filter(function (d) { return d.status === "dispute"; });
    var awaiting = all.filter(function (d) { return d.status === "new"; });

    $("admin-stat-total").textContent = all.length;
    $("admin-stat-active").textContent = active.length;
    $("admin-stat-disputes").textContent = disputes.length;
    $("admin-stat-awaiting").textContent = awaiting.length;
    $("admin-empty").classList.toggle("empty-state--visible", all.length === 0);

    var list = $("admin-list");
    list.innerHTML = "";

    // Сначала споры и ожидающие оплаты, затем остальные по дате
    var order = { dispute: 0, new: 1, paid: 2, fulfilled: 3, completed: 4, cancelled: 5 };
    all.slice().sort(function (a, b) {
      return (order[a.status] - order[b.status]) || (b.createdAt - a.createdAt);
    }).forEach(function (deal) {
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
      var meta = document.createElement("span");
      meta.textContent = deal.id + " · " + deal.counterparty + " · " + methodById(deal.method).name;
      var amount = document.createElement("span");
      amount.className = "deal-item-amount";
      amount.textContent = fmt(deal.total, deal.currency);
      bottom.appendChild(meta);
      bottom.appendChild(amount);

      li.appendChild(top);
      li.appendChild(bottom);

      if (deal.status === "new" && deal.bitpapaClaimedAt) {
        var note = document.createElement("div");
        note.className = "admin-note";
        note.textContent = "Покупатель сообщил о переводе Bitpapa — проверьте поступление.";
        li.appendChild(note);
      }

      var actions = document.createElement("div");
      actions.className = "admin-actions";

      function adminButton(label, cls, handler) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "btn btn--xs " + cls;
        b.textContent = label;
        b.addEventListener("click", function (e) {
          e.stopPropagation();
          handler();
        });
        actions.appendChild(b);
      }

      if (deal.status === "new") {
        adminButton("Подтвердить оплату", "btn--green", function () {
          showConfirm("Подтвердить получение " + fmt(deal.total, deal.currency) + " по сделке " + deal.id + "?", function () {
            api("POST", "/api/deals/" + deal.id + "/mark-paid", {}).then(function () {
              haptic("success");
              loadAdminDeals();
              loadDeals();
            }).catch(function () { showAlert("Не удалось подтвердить оплату."); });
          });
        });
      }

      if (deal.status === "dispute") {
        adminButton("В пользу продавца", "btn--green", function () {
          resolveDispute(deal, "seller");
        });
        adminButton("В пользу покупателя", "btn--danger", function () {
          resolveDispute(deal, "buyer");
        });
      }

      if (actions.childNodes.length) li.appendChild(actions);
      list.appendChild(li);
    });
  }

  function resolveDispute(deal, resolution) {
    var text = resolution === "seller"
      ? "Решить спор в пользу продавца? Гарант выплатит " + fmt(deal.amount, deal.currency) + "."
      : "Решить спор в пользу покупателя? Гарант вернёт " + fmt(deal.total, deal.currency) + ".";
    showConfirm(text, function () {
      api("POST", "/api/admin/deals/" + deal.id + "/resolve", { resolution: resolution }).then(function () {
        haptic("success");
        loadAdminDeals();
        loadDeals();
      }).catch(function () { showAlert("Не удалось решить спор."); });
    });
  }

  $("admin-refresh").addEventListener("click", function () {
    haptic("light");
    loadAdminDeals();
  });

  /* ---------- Инициализация ---------- */

  renderPayMethods();
  recalcFee();
  resolveApi().then(function (ok) {
    apiAvailable = ok;
    initAuth();
  });
})();
