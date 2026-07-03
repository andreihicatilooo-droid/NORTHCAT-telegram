(function () {
  "use strict";

  var CFG = window.NORTHCAT_CONFIG || {};
  var API_URL = (CFG.API_URL || "").replace(/\/+$/, "");
  var FEE_PERCENT = CFG.FEE_PERCENT != null ? CFG.FEE_PERCENT : 5;
  var DEMO = !API_URL;

  var tg = window.Telegram && window.Telegram.WebApp;
  var user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;

  var STORAGE_KEY = "northcat_deals_v1";

  var STATUS = {
    new:       { label: "Ожидает оплаты", cls: "status--new" },
    paid:      { label: "Оплачена, в гаранте", cls: "status--paid" },
    fulfilled: { label: "Выполнена продавцом", cls: "status--fulfilled" },
    completed: { label: "Завершена", cls: "status--completed" },
    dispute:   { label: "Спор", cls: "status--dispute" },
    cancelled: { label: "Отменена", cls: "status--cancelled" }
  };

  var TIMELINE_STEPS = [
    { status: "new",       label: "Сделка создана" },
    { status: "paid",      label: "Покупатель оплатил — средства у гаранта" },
    { status: "fulfilled", label: "Продавец выполнил условия" },
    { status: "completed", label: "Приёмка подтверждена — выплата продавцу" }
  ];

  var deals = [];
  var currentFilter = "all";
  var currentDealId = null;
  var createRole = "seller";

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

  function myUsername() {
    if (user && user.username) return "@" + user.username;
    if (user) return user.first_name || "Я";
    return "Я";
  }

  /* ---------- Хранилище ---------- */

  function loadDeals() {
    if (DEMO) {
      try {
        deals = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
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
    if (DEMO) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(deals));
    }
  }

  function api(method, path, body) {
    return fetch(API_URL + path, {
      method: method,
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Init-Data": tg ? tg.initData : ""
      },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  /* ---------- Утилиты ---------- */

  function $(id) { return document.getElementById(id); }

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
      showScreen(tab.getAttribute("data-screen"));
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
        meta.textContent = (deal.role === "seller" ? "Продаю → " : "Покупаю ← ") + deal.counterparty;
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

    var method = document.querySelector('input[name="pay-method"]:checked').value;
    var fee = amount * FEE_PERCENT / 100;

    var deal = {
      id: "NC-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(),
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

    if (DEMO) {
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
    recalcFee();
    renderDeals();
    renderStats();
    openDeal(deal.id);
    showAlert("Сделка " + deal.id + " создана. Отправьте её ID контрагенту (" + deal.counterparty + ") и дождитесь оплаты.");
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
    $("deal-view-code").textContent = "ID: " + deal.id;

    var seller = deal.role === "seller" ? myUsername() : deal.counterparty;
    var buyer = deal.role === "buyer" ? myUsername() : deal.counterparty;
    $("deal-view-seller").textContent = seller;
    $("deal-view-buyer").textContent = buyer;
    $("deal-view-amount").textContent = fmt(deal.amount, deal.currency);
    $("deal-view-fee").textContent = fmt(deal.fee, deal.currency) + " (" + deal.feePercent + "%)";
    $("deal-view-total").textContent = fmt(deal.total, deal.currency);
    $("deal-view-method").textContent = deal.method === "xrocket" ? "🚀 xRocket" : "🅱️ Bitpapa";
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
      b.className = "primary-button " + (cls || "");
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
          button(deal.method === "xrocket" ? "🚀 Оплатить через xRocket" : "🅱️ Оплатить через Bitpapa", "", function () {
            payDeal(deal);
          });
        } else {
          note("Ожидаем оплату от покупателя " + deal.counterparty + ". Средства будут заморожены у гаранта.");
        }
        button("Отменить сделку", "primary-button--red", function () {
          showConfirm("Отменить сделку " + deal.id + "?", function () {
            setStatus(deal, "cancelled");
          });
        });
        break;

      case "paid":
        if (isSeller) {
          button("✅ Я выполнил условия сделки", "primary-button--green", function () {
            showConfirm("Подтвердить, что товар передан / условия выполнены?", function () {
              setStatus(deal, "fulfilled");
            });
          });
        } else {
          note("Оплата у гаранта. Ожидайте выполнения условий продавцом.");
        }
        button("⚠️ Открыть спор", "primary-button--red", function () {
          showConfirm("Открыть спор по сделке? Арбитр изучит переписку и условия.", function () {
            setStatus(deal, "dispute");
          });
        });
        break;

      case "fulfilled":
        if (!isSeller) {
          button("✅ Подтвердить приёмку — выплатить продавцу", "primary-button--green", function () {
            showConfirm("Подтвердить приёмку? Гарант выплатит продавцу " + fmt(deal.amount, deal.currency) + ".", function () {
              setStatus(deal, "completed");
            });
          });
        } else {
          note("Ожидаем подтверждение приёмки покупателем. После подтверждения гарант выплатит вам " + fmt(deal.amount, deal.currency) + ".");
        }
        button("⚠️ Открыть спор", "primary-button--red", function () {
          showConfirm("Открыть спор по сделке?", function () {
            setStatus(deal, "dispute");
          });
        });
        break;

      case "dispute":
        note("Спор рассматривает арбитр NORTHCAT. Подготовьте переписку и доказательства.");
        button("💬 Связаться с арбитром", "", function () {
          openSupport();
        });
        break;

      case "completed":
        note("Сделка успешно завершена. Спасибо, что пользуетесь NORTHCAT Гарант!");
        break;

      case "cancelled":
        note("Сделка отменена." + (historyTs(deal, "paid") ? " Если оплата уже прошла — средства вернёт гарант." : ""));
        break;
    }

    // Демо-режим: кнопка симуляции действий контрагента, чтобы прощёлкать весь флоу
    if (DEMO && (deal.status === "new" || deal.status === "paid" || deal.status === "fulfilled")) {
      var simLabel = {
        new: "Демо: контрагент оплатил",
        paid: "Демо: продавец выполнил условия",
        fulfilled: "Демо: покупатель подтвердил приёмку"
      }[deal.status];
      var next = { new: "paid", paid: "fulfilled", fulfilled: "completed" }[deal.status];
      // показываем только то действие, которое недоступно текущей роли
      var ownAction =
        (deal.status === "new" && !isSeller) ||
        (deal.status === "paid" && isSeller) ||
        (deal.status === "fulfilled" && !isSeller);
      if (!ownAction) {
        var b = button(simLabel, "", function () { setStatus(deal, next); });
        b.style.opacity = "0.7";
      }
    }
  }

  function setStatus(deal, status) {
    function apply() {
      deal.status = status;
      deal.history = deal.history || [];
      deal.history.push({ status: status, ts: Date.now() });
      saveDeals();
      haptic(status === "dispute" || status === "cancelled" ? "warning" : "success");
      renderDeals();
      renderStats();
      openDeal(deal.id);
    }
    if (DEMO) {
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

    if (deal.method === "xrocket") {
      if (DEMO) {
        showConfirm(
          "Демо-режим: будет симулирована оплата " + fmt(deal.total, deal.currency) +
          " через xRocket. В боевом режиме откроется счёт Rocket Pay.",
          function () { setStatus(deal, "paid"); }
        );
        return;
      }
      // Боевой режим: бэкенд создаёт счёт через xRocket Pay API и возвращает ссылку
      api("POST", "/api/deals/" + deal.id + "/invoice", {}).then(function (res) {
        if (res && res.link) {
          if (tg && tg.openTelegramLink) tg.openTelegramLink(res.link);
          else window.open(res.link, "_blank");
        } else {
          showAlert("Не удалось создать счёт xRocket.");
        }
      }).catch(function () {
        showAlert("Не удалось создать счёт xRocket. Попробуйте позже.");
      });
      return;
    }

    // Bitpapa: перевод с кодом сделки, зачисление подтверждает гарант
    var msg =
      "Оплата через Bitpapa:\n\n" +
      "1. Переведите " + fmt(deal.total, deal.currency) + " пользователю @" + (CFG.BITPAPA_ACCOUNT || "гаранту") + " на Bitpapa.\n" +
      "2. В комментарии укажите код сделки: " + deal.id + "\n" +
      "3. После проверки перевода гарант отметит сделку оплаченной.";
    if (DEMO) {
      showConfirm(msg + "\n\nДемо-режим: отметить сделку оплаченной?", function () {
        setStatus(deal, "paid");
      });
    } else {
      showAlert(msg);
      api("POST", "/api/deals/" + deal.id + "/bitpapa-claim", {}).catch(function () { /* необязательно */ });
    }
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

  /* ---------- Инициализация пользователя ---------- */

  function initUser() {
    if (!user) return;
    var name = user.first_name + (user.last_name ? " " + user.last_name : "");
    $("username").textContent = name;
    $("profile-name").textContent = name;
    $("profile-id").textContent = (user.username ? "@" + user.username + " · " : "") + "ID " + user.id;
    if (user.photo_url) {
      ["avatar", "profile-avatar"].forEach(function (id) {
        var el = $(id);
        el.innerHTML = "";
        var img = document.createElement("img");
        img.src = user.photo_url;
        img.alt = "";
        el.appendChild(img);
      });
    }
  }

  initUser();
  recalcFee();
  loadDeals();
})();
