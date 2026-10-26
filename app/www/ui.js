/* ============================================================================
   GoldenHour — presentation layer (ui.js)

   Everything here is cosmetic or comfort. It reads the DOM that app.js keeps
   up to date and never calls into the case logic, so if this file failed to
   load the app would look a little flatter and work exactly the same.

     • tab lens      — the glass pill under the active tab slides between tabs
     • top bar       — gains depth once the page scrolls under it
     • new screen    — opens at the top, instead of at the old scroll offset
     • keyboard      — the floating bars step aside while a field is typed in
     • slider        — the filled part of the radius track follows the value
     • appearance    — theme (system / light / dark) and "Lighter visuals"

   No dependencies. Event listeners are passive; nothing runs per frame.
   ========================================================================== */
(function () {
  "use strict";

  var doc = document;
  var root = doc.documentElement;
  var THEME_KEY = "gh.ui.theme";
  var FX_KEY = "gh.ui.fx";

  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (_) { /* private mode or full storage: the choice lasts this session */ }
  }
  function recall(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  /* Phones that would rather not paint blur. Mirrors the inline check in
     index.html, which runs before first paint. */
  function lowEndDevice() {
    var n = navigator;
    return !!((n.deviceMemory && n.deviceMemory <= 3) || (n.hardwareConcurrency && n.hardwareConcurrency <= 4));
  }

  /* ── Tab lens ──────────────────────────────────────────────────────── */
  function initTabs() {
    var bar = doc.getElementById("tabbar");
    if (!bar) return;
    var tabs = Array.prototype.slice.call(bar.querySelectorAll(".tab"));
    function place() {
      var i = 0;
      tabs.forEach(function (t, n) { if (t.classList.contains("is-on")) i = n; });
      bar.style.setProperty("--tab-i", String(i));
    }
    place();
    bar.classList.add("has-ink");
    if (window.MutationObserver) {
      new MutationObserver(place).observe(bar, { attributes: true, attributeFilter: ["class"], subtree: true });
    }
  }

  /* ── New screen opens at the top ───────────────────────────────────── */
  function initViews() {
    if (!window.MutationObserver) return;
    var views = Array.prototype.slice.call(doc.querySelectorAll(".view"));
    var mo = new MutationObserver(function (records) {
      for (var k = 0; k < records.length; k++) {
        var r = records[k];
        /* Only a view that was hidden and now is not. Re-showing the view
           already on screen produces no record, so "Active case" from the
           Home quick list keeps its scroll-into-view. */
        if (r.oldValue !== null && !r.target.hidden) {
          window.scrollTo(0, 0);
          return;
        }
      }
    });
    views.forEach(function (v) {
      mo.observe(v, { attributes: true, attributeFilter: ["hidden"], attributeOldValue: true });
    });
  }

  /* ── Top bar depth on scroll ───────────────────────────────────────── */
  function initTopbar() {
    var bar = doc.getElementById("topbar");
    if (!bar) return;
    var ticking = false;
    function update() {
      ticking = false;
      bar.classList.toggle("is-scrolled", (window.scrollY || root.scrollTop) > 6);
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  }

  /* ── Keyboard: hide floating bars while typing ─────────────────────── */
  function isTypingField(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    var t = (el.getAttribute("type") || "text").toLowerCase();
    return ["text", "number", "search", "tel", "email", "url", "password"].indexOf(t) !== -1;
  }
  function initKeyboard() {
    var timer = null;
    doc.addEventListener("focusin", function (e) {
      if (timer) { clearTimeout(timer); timer = null; }
      if (isTypingField(e.target) && !e.target.closest(".overlay")) root.classList.add("kbd-open");
    });
    doc.addEventListener("focusout", function () {
      if (timer) clearTimeout(timer);
      /* Moving from one field to the next blurs and refocuses; wait a beat
         so the bars do not flicker in between. */
      timer = setTimeout(function () {
        timer = null;
        if (!isTypingField(doc.activeElement)) root.classList.remove("kbd-open");
      }, 120);
    });
  }

  /* ── Slider fill ───────────────────────────────────────────────────── */
  function initSliders() {
    var sliders = Array.prototype.slice.call(doc.querySelectorAll("input[type=range]"));
    if (!sliders.length) return;
    function paint() {
      sliders.forEach(function (s) {
        var min = Number(s.min) || 0, max = Number(s.max) || 100, v = Number(s.value);
        var pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
        s.style.setProperty("--pct", Math.max(0, Math.min(100, pct)).toFixed(1) + "%");
      });
    }
    /* The radius chips set the slider's value from app.js without an input
       event, so repaint after any tap as well — it is a handful of writes. */
    doc.addEventListener("input", paint, { passive: true });
    doc.addEventListener("click", function () { setTimeout(paint, 0); }, { passive: true });
    paint();
  }

  /* ── Appearance ────────────────────────────────────────────────────── */
  var mqDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function applyTheme(choice) {
    if (choice === "light" || choice === "dark") root.setAttribute("data-theme", choice);
    else root.removeAttribute("data-theme");
    var dark = choice === "dark" || (choice !== "light" && mqDark && mqDark.matches);
    /* Keep the Android status bar tint in step with the page. */
    var metas = doc.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      if (choice === "light" || choice === "dark") metas[i].setAttribute("content", dark ? "#071C23" : "#ECFAFC");
      else metas[i].setAttribute("content", metas[i].getAttribute("media") === "(prefers-color-scheme: dark)" ? "#071C23" : "#ECFAFC");
    }
  }

  function applyFx(pref) {
    var lite = pref === "lite" || (pref !== "full" && lowEndDevice());
    root.classList.toggle("fx-lite", lite);
    return lite;
  }

  function initAppearance() {
    var themeChoice = recall(THEME_KEY) || "system";
    var fxPref = recall(FX_KEY);   /* "lite" | "full" | null (= automatic) */
    applyTheme(themeChoice);
    var lite = applyFx(fxPref);

    var seg = doc.getElementById("themeSeg");
    function paintSeg() {
      if (!seg) return;
      Array.prototype.forEach.call(seg.querySelectorAll("[data-theme-choice]"), function (b) {
        var on = b.getAttribute("data-theme-choice") === themeChoice;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-checked", on ? "true" : "false");
      });
    }
    paintSeg();
    if (seg) seg.addEventListener("click", function (e) {
      var b = e.target.closest("[data-theme-choice]");
      if (!b) return;
      themeChoice = b.getAttribute("data-theme-choice");
      store(THEME_KEY, themeChoice === "system" ? null : themeChoice);
      applyTheme(themeChoice);
      paintSeg();
    });

    var sw = doc.getElementById("fxSwitch");
    var hint = doc.getElementById("fxHint");
    function paintSwitch() {
      if (sw) sw.setAttribute("aria-checked", lite ? "true" : "false");
      if (hint) {
        hint.textContent = fxPref === null && lowEndDevice()
          ? "On automatically — this phone is better off without glass blur."
          : "Turns off glass blur for older or slower phones.";
      }
    }
    paintSwitch();
    if (sw) sw.addEventListener("click", function () {
      lite = !lite;
      /* An explicit choice wins over the automatic one, both ways. */
      fxPref = lite ? "lite" : "full";
      store(FX_KEY, fxPref);
      applyFx(fxPref);
      paintSwitch();
    });

    if (mqDark) {
      var follow = function () { if (themeChoice === "system") applyTheme("system"); };
      if (mqDark.addEventListener) mqDark.addEventListener("change", follow);
      else if (mqDark.addListener) mqDark.addListener(follow);
    }
  }

  function boot() {
    [initAppearance, initTabs, initViews, initTopbar, initKeyboard, initSliders].forEach(function (fn) {
      try { fn(); } catch (err) {
        if (window.console && console.warn) console.warn("[GoldenHour ui]", fn.name, err);
      }
    });
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
