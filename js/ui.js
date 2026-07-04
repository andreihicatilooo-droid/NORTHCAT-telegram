(function () {
  "use strict";

  /* ---- Ripple на кнопках ---- */
  document.addEventListener("pointerdown", function (e) {
    var btn = e.target.closest(".btn");
    if (!btn) return;
    var r = document.createElement("span");
    r.className = "ripple";
    var rect = btn.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height);
    r.style.cssText = [
      "width:" + size + "px",
      "height:" + size + "px",
      "left:" + (e.clientX - rect.left - size / 2) + "px",
      "top:" + (e.clientY - rect.top - size / 2) + "px"
    ].join(";");
    btn.appendChild(r);
    r.addEventListener("animationend", function () { r.remove(); });
  });

  /* ---- Индикатор таббара ---- */
  var indicator = document.getElementById("tabbar-indicator");

  function updateIndicator() {
    if (!indicator) return;
    var activeTab = document.querySelector(".tab--active:not([hidden])");
    if (!activeTab) return;
    var tabbar = activeTab.closest(".tabbar");
    if (!tabbar) return;
    var tabRect = activeTab.getBoundingClientRect();
    var barRect = tabbar.getBoundingClientRect();
    indicator.style.left = (tabRect.left - barRect.left) + "px";
    indicator.style.width = tabRect.width + "px";
  }

  /* Следим за изменением классов .tab--active через MutationObserver */
  var tabbar = document.querySelector(".tabbar");
  if (tabbar && indicator) {
    new MutationObserver(function () {
      requestAnimationFrame(updateIndicator);
    }).observe(tabbar, { attributes: true, subtree: true, attributeFilter: ["class", "hidden"] });
  }

  /* Инициализация после отрисовки */
  window.addEventListener("load", function () {
    requestAnimationFrame(updateIndicator);
  });

  /* Обновить при ресайзе */
  window.addEventListener("resize", updateIndicator);

  /* ---- Тост ---- */
  var toastEl = document.getElementById("toast");
  var toastTimer = null;

  window.showToast = function (text, duration) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add("toast--visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("toast--visible");
    }, duration || 2400);
  };

  /* ---- Анимация появления карточек сделок при добавлении ---- */
  var dealLists = [
    document.getElementById("deal-list"),
    document.getElementById("admin-list")
  ];

  dealLists.forEach(function (list) {
    if (!list) return;
    new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (node.nodeType === 1 && node.classList.contains("deal-item")) {
            node.style.animationDelay = "0ms";
            node.style.animation = "none";
            requestAnimationFrame(function () {
              node.style.animation = "";
            });
          }
        });
      });
    }).observe(list, { childList: true });
  });

  /* ---- Нативный скролл для filter-row без горизонтального snap ---- */
  document.querySelectorAll(".filter-row").forEach(function (row) {
    var isDown = false, startX, scrollLeft;
    row.addEventListener("pointerdown", function (e) {
      isDown = true;
      startX = e.pageX - row.offsetLeft;
      scrollLeft = row.scrollLeft;
    });
    row.addEventListener("pointermove", function (e) {
      if (!isDown) return;
      var x = e.pageX - row.offsetLeft;
      row.scrollLeft = scrollLeft - (x - startX);
    });
    ["pointerup", "pointerleave"].forEach(function (ev) {
      row.addEventListener(ev, function () { isDown = false; });
    });
  });

  /* ---- Плавный скролл к активному чипу ---- */
  document.querySelectorAll(".chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      chip.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    });
  });

  /* ---- Spotlight / tilt на карточках ---- */
  var appRoot = document.getElementById("app");
  var finePointer = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
  var interactiveSelector = [
    ".hero-panel",
    ".deal-item",
    ".detail-card",
    ".profile-card",
    ".stat-card",
    ".info-card",
    ".guide-step",
    ".guide-panel",
    ".guide-tip",
    ".fee-card",
    ".pay-method-card"
  ].join(", ");

  function updateCardPointer(card, x, y) {
    var rect = card.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var px = (x - rect.left) / rect.width;
    var py = (y - rect.top) / rect.height;
    card.style.setProperty("--spotlight-x", (px * 100).toFixed(2) + "%");
    card.style.setProperty("--spotlight-y", (py * 100).toFixed(2) + "%");
    if (finePointer) {
      card.style.setProperty("--card-rotate-x", ((0.5 - py) * 8).toFixed(2) + "deg");
      card.style.setProperty("--card-rotate-y", ((px - 0.5) * 10).toFixed(2) + "deg");
    }
  }

  function resetCardPointer(card) {
    card.classList.remove("is-tilting");
    card.style.removeProperty("--card-rotate-x");
    card.style.removeProperty("--card-rotate-y");
    card.style.removeProperty("--spotlight-x");
    card.style.removeProperty("--spotlight-y");
  }

  function bindInteractiveCard(card) {
    if (!card || card.dataset.ambientBound === "1") return;
    card.dataset.ambientBound = "1";

    card.addEventListener("pointermove", function (e) {
      updateCardPointer(card, e.clientX, e.clientY);
      if (finePointer) card.classList.add("is-tilting");
    });

    card.addEventListener("pointerdown", function (e) {
      updateCardPointer(card, e.clientX, e.clientY);
    });

    card.addEventListener("pointerleave", function () {
      resetCardPointer(card);
    });
  }

  function bindInteractiveCards(root) {
    (root || document).querySelectorAll(interactiveSelector).forEach(bindInteractiveCard);
  }

  function syncScreenState(screenId) {
    var activeId = screenId || "";
    if (!activeId) {
      var activeScreen = document.querySelector(".screen--active");
      activeId = activeScreen ? activeScreen.id : "screen-deals";
    }
    document.body.setAttribute("data-screen", activeId);
    if (appRoot) appRoot.setAttribute("data-screen", activeId);
    requestAnimationFrame(updateIndicator);
  }

  bindInteractiveCards(document);
  syncScreenState();

  if (appRoot) {
    new MutationObserver(function () {
      bindInteractiveCards(appRoot);
    }).observe(appRoot, { childList: true, subtree: true });
  }

  window.addEventListener("northcat:screenchange", function (event) {
    syncScreenState(event && event.detail && event.detail.screen);
  });

}());
