/* ============================================================================
   GoldenHour desk — shared helpers (window.GH).
   Plain browser JavaScript, no build step.
   ========================================================================== */
(function () {
  'use strict';

  var SESSION_KEY = 'goldenhour.session';
  var API = location.origin.replace(/\/$/, '') + '/api/v1';
  var onSignedOut = null;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── session ─────────────────────────────────────────────────────────── */
  function readSession() {
    try { var raw = localStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; }
    catch (_) { return null; }
  }
  var session = readSession();
  function saveSession(s) {
    session = s;
    try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch (_) {}
  }
  function getSession() { return session; }

  /* ── API ─────────────────────────────────────────────────────────────── */
  function api(path, options) {
    var opts = options || {};
    var headers = { 'Accept': 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (session && session.token && !opts.anonymous) headers['Authorization'] = 'Bearer ' + session.token;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, opts.timeoutMs || 12000) : null;
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller ? controller.signal : undefined,
      cache: 'no-store',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (timer) clearTimeout(timer);
        if (res.status === 401 && !opts.anonymous) {
          saveSession(null);
          if (onSignedOut) onSignedOut(body && body.message);
        }
        if (!res.ok) {
          var err = new Error((body && body.message) || ('Request failed (' + res.status + ')'));
          err.status = res.status; err.body = body || {}; err.reason = body && body.reason;
          throw err;
        }
        return body;
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      var e = new Error(err && err.name === 'AbortError' ? 'The server did not answer in time.' : 'Could not reach the server.');
      e.network = true;
      throw e;
    });
  }

  /* ── formatting ──────────────────────────────────────────────────────── */
  function timeOf(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function dateTime(iso) {
    if (!iso) return 'Never';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    var today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today ' + timeOf(iso);
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + timeOf(iso);
  }
  function ago(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return '';
    if (ms < 45000) return 'just now';
    if (ms < 3600000) return Math.round(ms / 60000) + ' min ago';
    if (ms < 86400000) return Math.round(ms / 3600000) + ' h ago';
    return Math.round(ms / 86400000) + ' d ago';
  }
  function secs(v) { return v == null ? '—' : (v < 90 ? Math.round(v) + ' s' : Math.round(v / 60) + ' min'); }

  /* Same bands as shared/age-bands.js (the ambulance app uses that file). */
  var AGE_BANDS = [
    { label: 'Baby', min: 0, max: 3 }, { label: 'Child', min: 3, max: 18 },
    { label: 'Adult', min: 18, max: 60 }, { label: 'Senior citizen', min: 60, max: 131 },
  ];
  function ageBand(age) {
    if (age === null || age === undefined || String(age).trim() === '') return 'Age unknown';
    var n = Number(age);
    if (!isFinite(n) || n < 0 || n > 130) return 'Age unknown';
    for (var i = 0; i < AGE_BANDS.length; i++) if (n >= AGE_BANDS[i].min && n < AGE_BANDS[i].max) return AGE_BANDS[i].label;
    return 'Age unknown';
  }
  var SEX = { M: 'Male', F: 'Female', O: 'Other', U: 'Sex unknown' };

  function initials(text) {
    var parts = String(text || '').replace(/^er\./, '').split(/[.\-_ ]+/).filter(Boolean);
    return ((parts[0] || 'E')[0] + ((parts[1] || parts[0] || 'R')[0])).toUpperCase();
  }

  /* ── overlays ────────────────────────────────────────────────────────── */
  var toastTimer = null;
  function toast(text, ms) {
    var el = $('#toast');
    el.textContent = text; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 3200);
  }
  var sheetOpener = null;
  function openSheet(title, html) {
    sheetOpener = document.activeElement;
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = html;
    $('#sheetBack').hidden = false;
    $('#sheetClose').focus();
  }
  function closeSheet() {
    $('#sheetBack').hidden = true;
    if (sheetOpener && sheetOpener.focus) sheetOpener.focus();
  }
  document.addEventListener('click', function (e) {
    if (e.target && (e.target.id === 'sheetClose' || e.target.id === 'sheetBack')) closeSheet();
    if (e.target && (e.target.id === 'lightboxClose' || e.target.id === 'lightbox')) $('#lightbox').hidden = true;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('#sheetBack').hidden) closeSheet();
    $('#lightbox').hidden = true;
  });

  window.GH = {
    $: $, $$: $$, esc: esc, api: api,
    session: getSession, saveSession: saveSession,
    onSignedOut: function (fn) { onSignedOut = fn; },
    timeOf: timeOf, dateTime: dateTime, ago: ago, secs: secs, ageBand: ageBand, SEX: SEX, initials: initials,
    toast: toast, openSheet: openSheet, closeSheet: closeSheet,
    cfg: window.GH_DESK_CONFIG || {},
  };
})();
