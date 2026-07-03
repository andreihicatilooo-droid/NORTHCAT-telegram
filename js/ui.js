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

}());
