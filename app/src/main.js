/* ============================================================================
   GoldenHour — ambulance app entry point.

   Everything with a rule in it lives in ./modules and is unit-tested in plain
   Node. What is left here is wiring: read the DOM, call a module, paint the
   result. When something in this file gets complicated enough to argue about,
   that is the signal it belongs in a module.

   The bundle is UMD on purpose. In the WebView it defines a global; under
   `node tests/test.js` it is a CommonJS module whose pure functions can be
   required directly. One artefact, both jobs.
   ========================================================================== */

import './styles.css';
import { Geolocation } from '@capacitor/geolocation';
import { watchPosition } from './modules/position-watch.js';
import { recordArrival } from './modules/arrival.js';

import {
  MAX_IMAGES, VITAL_KEYS, DEMO_CASE_TYPES, CATEGORY_LABELS,
  AGE_BANDS, ageBandById, describeAgeBand, ageBandLabel,
  getBandFor, isOutOfRange, toNumberOrNull, toTextOrNull,
  buildPayload, deriveNeeds, categoryOf,
} from './modules/logic.js';

import { resolveEnvironment, isCapacitorRuntime } from './modules/env.js';

import {
  validCoords, describeGeoError, noGeolocationMessage, describeAge,
  readLastFix, writeLastFix, SOURCE_LABELS,
} from './modules/geo.js';

import { createLiveTransport, createDemoTransport, NetworkError } from './modules/transport.js';
import { createOutbox } from './modules/outbox.js';
import { createCaseBook, describeWhen, STATUS_TEXT, STATUS_TONE } from './modules/cases.js';

/* ── The pure-logic API ─────────────────────────────────────────────────────
   Published two ways from one artefact: as `window.GH` inside the WebView,
   and as CommonJS exports when app/tests/test.js does
   `require('../www/app.js')`. Attaching it by hand rather than with `export`
   is deliberate — Vite builds an HTML entry as an application and strips its
   ES exports, which would leave the unit tests requiring an empty object. */
const PUBLIC_API = {
  MAX_IMAGES, VITAL_KEYS, DEMO_CASE_TYPES, CATEGORY_LABELS,
  AGE_BANDS, ageBandById, describeAgeBand, ageBandLabel,
  getBandFor, isOutOfRange, toNumberOrNull, toTextOrNull,
  buildPayload, deriveNeeds, categoryOf,
};
try {
  if (typeof module !== 'undefined' && module && typeof module.exports === 'object') {
    module.exports = PUBLIC_API;
  }
} catch (_) { /* not a CommonJS host */ }
if (typeof window !== 'undefined') window.GH = PUBLIC_API;

/* ── Boot guard ─────────────────────────────────────────────────────────────
   Required so `require('../www/app.js')` in the unit tests can pull the pure
   functions out without a DOM anywhere in sight. */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  /* The tag sits at the end of <body>, so by the time this runs the markup it
     needs already exists — even though readyState is still "loading". Waiting
     for DOMContentLoaded would delay the form for no reason, and would leave
     the app un-booted for any caller that inspects it synchronously. Presence
     of the root element is the honest test. */
  if (document.getElementById('app')) start();
  else document.addEventListener('DOMContentLoaded', start);
}

function start() {
  try { boot(window, document); }
  catch (err) {
    /* A crash here means a blank form for a paramedic. Say so, on screen. */
    try {
      const banner = document.getElementById('loadError');
      const text = document.getElementById('loadErrorText');
      if (text) text.textContent = 'The app failed to start: ' + ((err && err.message) || err);
      if (banner) banner.hidden = false;
    } catch (_) {}
    if (window.console && console.error) console.error('[GoldenHour] boot failed', err);
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */

function boot(win, doc) {
  const $ = id => doc.getElementById(id);
  const $$ = sel => Array.prototype.slice.call(doc.querySelectorAll(sel));
  const on = (el, evt, fn) => { if (el) el.addEventListener(evt, fn); };

  const storage = safeStorage(win);

  /* ── Environment ─────────────────────────────────────────────────────── */

  const env = resolveEnvironment({
    config: win.GH_CONFIG,
    location: win.location,
    capacitor: isCapacitorRuntime(win),
    forceDemo: typeof win.__GH_DEMO === 'boolean' ? win.__GH_DEMO : undefined,
  });

  const pollMs = () => Number(win.__GH_POLL_MS) > 0 ? Number(win.__GH_POLL_MS) : env.pollMs;

  const transport = env.demo
    ? createDemoTransport({
        caseTypes: DEMO_CASE_TYPES,
        postMs: () => Number(win.__GH_DEMO_POST_MS) || 300,
        shouldFail: () => !!win.__GH_DEMO_FAIL,
      })
    : createLiveTransport(env.apiRoot || '', (url, opts) => {
        if (typeof win.fetch !== 'function') return Promise.reject(new NetworkError('No fetch in this runtime'));
        return win.fetch(url, opts);
      });

  const outbox = createOutbox(storage, {
    onRejected: entry => toast('A queued case was refused by the server and discarded'),
  });
  const caseBook = createCaseBook(storage);

  /* ── State ───────────────────────────────────────────────────────────── */

  const state = {
    demo: env.demo,
    caseTypes: DEMO_CASE_TYPES.slice(),
    selected: { caseTypeId: null, category: null, gender: 'U', ageBand: 'unknown', bloodGroup: null, consciousness: null, radiusKm: 15 },
    /* "Has a person actually chosen this?" — distinct from the value, which
       always has a safe default so nothing can be blocked by it. */
    touched: { age: false, gender: false },
    fastState: { face: false, arm: false, speech: false },
    needs: { ventilator: false, blood: false, imaging: false, ot: false, cathlab: false },
    needsTouched: false,
    location: { lat: null, lng: null, accuracy: null, source: null, status: 'locating' },
    images: [],
    activeCaseCode: null,
    lastResponse: null,
    lastPayload: null,
    lastClientRequestId: null,
  };

  let pollTimer = null;
  let flushTimer = null;
  let socket = null;
  let geoWatch = null;

  /* ── Theme ─────────────────────────────────────────────────────────────
     There is no colour-theme control any more, in the form or in Settings.
     GoldenHour has one visual identity and a crew mid-shift should not be
     choosing palettes. The stylesheet still answers the device's own
     light/dark preference — a night shift gets the dark surfaces without
     anybody configuring anything — which is why tokens.css keeps both sets. */

  /* ── Views ───────────────────────────────────────────────────────────── */

  /* Settings used to map to 'formScroll', which meant the Settings tab
     opened the emergency form and expanded a details card inside it. Device
     configuration has no business living in the alert workflow. */
  const VIEWS = { home: 'homeView', new: 'formScroll', cases: 'casesView', settings: 'settingsView' };
  const VIEW_IDS = ['homeView', 'formScroll', 'casesView', 'settingsView'];

  function showView(name) {
    const target = VIEWS[name] || VIEWS.home;
    VIEW_IDS.forEach(id => {
      const el = $(id);
      if (el) el.hidden = (id !== target);
    });
    $$('#tabbar .tab').forEach(t => {
      const isOn = t.dataset.view === name;
      t.classList.toggle('is-on', isOn);
      if (isOn) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    if (name === 'home') renderHome();
    if (name === 'cases') renderCaseList();
    if (name === 'settings') renderSettings();
    /* A view swap should start at the top, not wherever the previous screen
       happened to be scrolled to. */
    const el = $(target);
    if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: 0 });
    else if (el) el.scrollTop = 0;
  }

  on($('tabbar'), 'click', e => {
    const t = e.target.closest('.tab');
    if (t) showView(t.dataset.view);
  });
  on($('startAlertBtn'), 'click', () => showView('new'));
  $$('.quick-row').forEach(row => on(row, 'click', () => {
    const go = row.dataset.go;
    if (go === 'active') { showView('home'); const box = $('activeCaseBox'); if (box && !box.hidden && box.scrollIntoView) box.scrollIntoView({ block: 'start' }); }
    else showView(go === 'new' ? 'new' : 'cases');
  }));
  on($('continueCaseBtn'), 'click', () => {
    if (state.lastResponse) $('successOverlay').hidden = false;
    else showView('new');
  });

  /* ── Case types ──────────────────────────────────────────────────────── */

  function renderCaseTypes() {
    const sel = $('caseType');
    const quick = $('quickCase');
    if (!sel) return;
    const keep = sel.value;

    sel.textContent = '';
    const placeholder = doc.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a case type…';
    sel.appendChild(placeholder);

    CATEGORY_LABELS.forEach(([key, label]) => {
      const inGroup = state.caseTypes.filter(t => t.category === key);
      if (!inGroup.length) return;
      const group = doc.createElement('optgroup');
      group.label = label;
      inGroup.forEach(t => {
        const opt = doc.createElement('option');
        opt.value = String(t.id);
        opt.textContent = t.label;
        group.appendChild(opt);
      });
      sel.appendChild(group);
    });
    /* Anything the server sends in a category this build does not know about
       still has to be selectable — never silently drop a case type. */
    const known = CATEGORY_LABELS.map(c => c[0]);
    const others = state.caseTypes.filter(t => known.indexOf(t.category) === -1);
    if (others.length) {
      const group = doc.createElement('optgroup');
      group.label = 'Other';
      others.forEach(t => {
        const opt = doc.createElement('option');
        opt.value = String(t.id); opt.textContent = t.label;
        group.appendChild(opt);
      });
      sel.appendChild(group);
    }
    sel.value = keep;

    if (quick) {
      quick.textContent = '';
      state.caseTypes.filter(t => t.quick).forEach(t => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'chip chip-xs';
        b.setAttribute('data-case-id', String(t.id));
        b.textContent = t.short || t.label;
        quick.appendChild(b);
      });
    }
  }

  function selectCaseType(id) {
    const n = toNumberOrNull(id);
    state.selected.caseTypeId = n;
    state.selected.category = categoryOf(state.caseTypes, n);
    const sel = $('caseType');
    if (sel) sel.value = n === null ? '' : String(n);
    $$('#quickCase .chip').forEach(c => c.classList.toggle('is-on', toNumberOrNull(c.dataset.caseId) === n));
    const stroke = $('strokeSection');
    if (stroke) stroke.hidden = state.selected.category !== 'STROKE';
    refreshNeeds();
    refreshSubmitHint();
  }

  on($('caseType'), 'change', e => selectCaseType(e.target.value));
  on($('quickCase'), 'click', e => {
    const chip = e.target.closest('.chip');
    if (chip) selectCaseType(chip.dataset.caseId);
  });

  async function loadCaseTypes() {
    try {
      const list = await transport.caseTypes();
      if (Array.isArray(list) && list.length) {
        state.caseTypes = list;
        renderCaseTypes();
        selectCaseType(state.selected.caseTypeId);
      }
      setLoadError(null);
    } catch (err) {
      /* The bundled list is already on screen, so this is a notice, not a
         failure — the crew can still send. */
      setLoadError('Using the built-in case list — the server list could not be loaded.');
    }
  }
  function setLoadError(message) {
    const banner = $('loadError');
    const text = $('loadErrorText');
    if (!banner) return;
    if (!message) { banner.hidden = true; return; }
    if (text) text.textContent = message;
    banner.hidden = false;
  }
  on($('retryListsBtn'), 'click', () => { setLoadError(null); loadCaseTypes(); });

  /* ── Simple pickers ──────────────────────────────────────────────────── */

  function bindRadioGroup(containerId, attr, onPick) {
    const container = $(containerId);
    on(container, 'click', e => {
      const b = e.target.closest('[' + attr + ']');
      if (!b || !container.contains(b)) return;
      container.querySelectorAll('[' + attr + ']').forEach(x => {
        const isOn = x === b;
        x.classList.toggle('is-on', isOn);
        if (x.hasAttribute('role')) x.setAttribute('aria-checked', isOn ? 'true' : 'false');
      });
      onPick(b.getAttribute(attr), b);
    });
  }

  bindRadioGroup('genderSeg', 'data-value', v => {
    state.selected.gender = v;
    state.touched.gender = true;
    markAnswered();
  });
  bindRadioGroup('consciousnessGroup', 'data-value', v => {
    state.selected.consciousness = v;
    refreshNeeds();
  });
  ['fastFace', 'fastArm', 'fastSpeech'].forEach(id => {
    bindRadioGroup(id, 'data-yn', v => {
      state.fastState[id.replace('fast', '').toLowerCase()] = (v === 'yes');
    });
  });
  bindRadioGroup('editGender', 'data-value', () => {});
  bindRadioGroup('editConsciousness', 'data-value', () => {});

  /* Blood group is a toggle, not a radio: "I checked and it is O+" and
     "I do not know" are different statements and both must be sayable. */
  on($('bloodChips'), 'click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const wasOn = chip.classList.contains('is-on');
    $$('#bloodChips .chip').forEach(c => c.classList.remove('is-on'));
    if (wasOn) { state.selected.bloodGroup = null; }
    else { chip.classList.add('is-on'); state.selected.bloodGroup = chip.dataset.blood; }
  });
  on($('editBloodRow'), 'click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const wasOn = chip.classList.contains('is-on');
    $$('#editBloodRow .chip').forEach(c => c.classList.remove('is-on'));
    if (!wasOn) chip.classList.add('is-on');
  });

  function bindFillChips(containerId, dataKey, targetId, after) {
    on($(containerId), 'click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      $$('#' + containerId + ' .chip').forEach(c => c.classList.toggle('is-on', c === chip));
      const target = $(targetId);
      if (target) target.value = chip.dataset[dataKey];
      if (after) after(chip.dataset[dataKey]);
    });
  }
  bindFillChips('etaChips', 'eta', 'eta');
  bindFillChips('onsetChips', 'onset', 'onsetHours');
  bindFillChips('radiusChips', 'radius', 'radiusKm', v => setRadius(v));

  function setRadius(value) {
    const n = toNumberOrNull(value);
    if (n === null) return;
    state.selected.radiusKm = n;
    const out = $('radiusOut');
    if (out) out.textContent = n + ' km';
    $$('#radiusChips .chip').forEach(c => c.classList.toggle('is-on', toNumberOrNull(c.dataset.radius) === n));
  }
  on($('radiusKm'), 'input', e => setRadius(e.target.value));

  on($('notes'), 'input', e => {
    const count = $('notesCount');
    if (count) count.textContent = String(e.target.value.length) + ' / 160';
  });
  on($('ambulanceId'), 'change', e => {
    try { storage.setItem('goldenhour.ambulanceId', e.target.value); } catch (_) {}
  });
  try {
    const savedUnit = storage.getItem('goldenhour.ambulanceId');
    if (savedUnit && $('ambulanceId')) $('ambulanceId').value = savedUnit;
  } catch (_) {}

  /* ── Age group ─────────────────────────────────────────────────────────
     Five taps instead of a number pad. A crew at a roadside knows which of
     these a patient is at a glance and often cannot know more than that; the
     representative number behind each band is what travels on the wire, so
     nothing downstream changes. */

  function renderAgeBands(containerId) {
    const wrap = $(containerId);
    if (!wrap) return;
    wrap.textContent = '';
    AGE_BANDS.forEach(band => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'band';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.setAttribute('data-age-band', band.id);
      /* Kept so the existing quick-chip contract still reads naturally, and so
         a test or a script can address a band by the value it will set. */
      if (band.value !== null) b.setAttribute('data-age', String(band.value));
      const label = doc.createElement('b');
      label.textContent = band.label;
      const hint = doc.createElement('small');
      hint.textContent = band.hint;
      b.appendChild(label);
      b.appendChild(hint);
      wrap.appendChild(b);
    });
  }

  function paintAgeBands(containerId, bandId) {
    $$('#' + containerId + ' .band').forEach(b => {
      const isOn = b.dataset.ageBand === bandId;
      b.classList.toggle('is-on', isOn);
      b.setAttribute('aria-checked', isOn ? 'true' : 'false');
      b.tabIndex = isOn ? 0 : -1;
    });
  }

  function setAgeBand(bandId, opts) {
    const band = ageBandById(bandId);
    if (!band) return;
    state.selected.ageBand = band.id;
    if (!opts || opts.touched !== false) state.touched.age = true;
    const field = $('age');
    if (field) field.value = band.value === null ? '' : String(band.value);
    paintAgeBands('ageChips', band.id);
    markAnswered();
    refreshNeeds();
  }

  on($('ageChips'), 'click', e => {
    const b = e.target.closest('.band');
    if (b) setAgeBand(b.dataset.ageBand);
  });

  ['ageChips', 'editAgeChips'].forEach(id => {
    on($(id), 'keydown', e => {
      const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      const buttons = Array.from($(id).querySelectorAll('.band'));
      const index = buttons.indexOf(e.target.closest('.band'));
      if (index < 0) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
        : (index + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click();
      buttons[next].focus();
    });
  });

  /* ── Required-but-never-blocking ───────────────────────────────────────
     Age and sex are marked Required and default to Unknown, so the form
     always carries a valid answer and the crew is nudged to improve it. They
     are deliberately NOT a hard gate: a broadcast must never be held up by a
     demographic field while somebody is doing compressions. The cue is
     visual, on the two groups, and it clears the moment either is answered. */
  function markAnswered() {
    const age = $('ageChips');
    const sex = $('genderSeg');
    if (age) age.classList.toggle('needs-answer', !state.touched.age);
    if (sex) sex.classList.toggle('needs-answer', !state.touched.gender);
  }

  /* ── Vitals ──────────────────────────────────────────────────────────── */

  const VITAL_FIELDS = [
    ['systolicBp', 'sysChip'], ['diastolicBp', 'diaChip'], ['heartRate', 'hrChip'],
    ['respRate', 'rrChip'], ['spo2', 'spo2Chip'], ['glucose', 'glcChip'],
  ];
  const BAND_WORD = { good: 'Normal', caution: 'Caution', critical: 'Critical' };

  /* The two halves of the blood-pressure pair carry their own name, because
     an unlabelled chip under a two-input row does not say which input it is
     about. They also stay hidden while that half is normal — the summary chip
     beside the label already says so. */
  const VITAL_PREFIX = { systolicBp: 'Systolic ', diastolicBp: 'Diastolic ' };
  const QUIET_WHEN_GOOD = ['systolicBp', 'diastolicBp'];

  function paintVital(inputId, chipId) {
    const input = $(inputId);
    const chip = $(chipId);
    if (!input || !chip) return;
    const raw = input.value;
    const prefix = VITAL_PREFIX[inputId] || '';
    input.classList.remove('in-good', 'in-caution', 'in-critical', 'in-range');

    if (toNumberOrNull(raw) === null) { chip.hidden = true; chip.textContent = ''; chip.className = 'chip-state'; return; }
    if (isOutOfRange(inputId, raw)) {
      chip.hidden = false;
      chip.className = 'chip-state state-range';
      chip.textContent = prefix ? prefix + 'out of range' : 'Check value';
      input.classList.add('in-range');
      return;
    }
    const band = getBandFor(inputId, raw);
    if (!band) { chip.hidden = true; chip.textContent = ''; chip.className = 'chip-state'; return; }
    input.classList.add('in-' + band);
    if (band === 'good' && QUIET_WHEN_GOOD.indexOf(inputId) !== -1) {
      chip.hidden = true; chip.textContent = ''; chip.className = 'chip-state'; return;
    }
    chip.hidden = false;
    chip.className = 'chip-state state-' + band;
    /* The word is the signal; the colour only reinforces it. Roughly one in
       twelve men has a red-green deficiency, and this is the ER's traffic
       light. */
    chip.textContent = prefix ? prefix + BAND_WORD[band].toLowerCase() : BAND_WORD[band];
  }

  function readVitals() {
    const out = {};
    VITAL_FIELDS.forEach(([inputId]) => {
      const el = $(inputId);
      out[inputId] = el ? el.value : '';
    });
    return out;
  }

  VITAL_FIELDS.forEach(([inputId, chipId]) => {
    on($(inputId), 'input', () => { paintVital(inputId, chipId); paintBpSummary(); refreshNeeds(); });
  });

  function repaintAllVitals() { VITAL_FIELDS.forEach(([i, c]) => paintVital(i, c)); paintBpSummary(); }

  /* The two readings stay separate everywhere that matters; this is the one
     chip that speaks for the pair, because a clinician reads 82/50 as a
     single fact. The per-field chips still exist and still say which half is
     out of range. */
  function paintBpSummary() {
    const chip = $('bpChip');
    if (!chip) return;
    const sys = $('systolicBp') ? $('systolicBp').value : '';
    const dia = $('diastolicBp') ? $('diastolicBp').value : '';
    if (toNumberOrNull(sys) === null && toNumberOrNull(dia) === null) {
      chip.hidden = true; chip.textContent = ''; chip.className = 'chip-state'; return;
    }
    if (isOutOfRange('systolicBp', sys) || isOutOfRange('diastolicBp', dia)) {
      chip.hidden = false; chip.className = 'chip-state state-range'; chip.textContent = 'Check value'; return;
    }
    const bands = [getBandFor('systolicBp', sys), getBandFor('diastolicBp', dia)].filter(Boolean);
    if (!bands.length) { chip.hidden = true; chip.textContent = ''; chip.className = 'chip-state'; return; }
    /* The worse of the two: a normal diastolic does not make a systolic of 82
       reassuring. */
    const worst = bands.indexOf('critical') !== -1 ? 'critical'
      : bands.indexOf('caution') !== -1 ? 'caution' : 'good';
    chip.hidden = false;
    chip.className = 'chip-state state-' + worst;
    chip.textContent = BAND_WORD[worst];
  }

  /* ── Resource needs ──────────────────────────────────────────────────── */

  const NEED_BUTTONS = { ventilator: 'needVent', blood: 'needBlood', imaging: 'needImaging', ot: 'needOt', cathlab: 'needCath' };

  function refreshNeeds() {
    if (state.needsTouched) return paintNeeds();
    const v = readVitals();
    state.needs = deriveNeeds({
      category: state.selected.category,
      consciousness: state.selected.consciousness,
      vitals: { spo2: v.spo2, systolic_bp: v.systolicBp },
    });
    paintNeeds();
  }
  function paintNeeds() {
    Object.keys(NEED_BUTTONS).forEach(key => {
      const b = $(NEED_BUTTONS[key]);
      if (!b) return;
      b.classList.toggle('is-on', !!state.needs[key]);
      b.setAttribute('aria-pressed', state.needs[key] ? 'true' : 'false');
    });
  }
  on($('needsChips'), 'click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const key = chip.dataset.need;
    if (!(key in state.needs)) return;
    state.needs[key] = !state.needs[key];
    state.needsTouched = true;
    paintNeeds();
  });

  /* ── Location ────────────────────────────────────────────────────────── */

  function setLocation(fix) {
    state.location = {
      lat: fix.lat, lng: fix.lng,
      accuracy: fix.accuracy === undefined ? null : fix.accuracy,
      source: fix.source,
      status: 'ready',
    };
    const box = $('locBox');
    const measured = fix.source === 'gps';
    if (box) box.className = 'locbox ' + (measured || fix.source === 'demo' ? 'loc-ready' : 'loc-manual');
    const status = $('locationStatus');
    const meta = $('locationMeta');
    if (status) {
      status.textContent = fix.source === 'gps' ? 'GPS fix ready'
        : fix.source === 'demo' ? 'Demo position locked'
        : fix.source === 'last-known' ? 'Using the last fix from this shift'
        : 'Using coordinates set by hand';
    }
    if (meta) {
      meta.textContent = measured && fix.accuracy != null
        ? '±' + Math.round(fix.accuracy) + ' m · ' + fix.lat.toFixed(4) + ', ' + fix.lng.toFixed(4)
        : fix.lat.toFixed(4) + ', ' + fix.lng.toFixed(4) + ' · ' + (SOURCE_LABELS[fix.source] || fix.source);
    }
    const fallback = $('locFallback');
    if (fallback) fallback.hidden = true;
    const retry = $('locRetryBtn');
    if (retry) retry.hidden = true;
    refreshSubmitHint();
  }

  function setLocationFailed(message) {
    state.location = { lat: null, lng: null, accuracy: null, source: null, status: 'unavailable' };
    const box = $('locBox');
    if (box) box.className = 'locbox loc-error';
    const status = $('locationStatus');
    if (status) status.textContent = message;
    const meta = $('locationMeta');
    if (meta) meta.textContent = 'No position yet';
    const retry = $('locRetryBtn');
    if (retry) retry.hidden = false;
    renderFallbackChips();
    const fallback = $('locFallback');
    if (fallback) fallback.hidden = false;
    refreshSubmitHint();
  }

  function renderFallbackChips() {
    const wrap = $('locFallbackChips');
    if (!wrap) return;
    wrap.textContent = '';

    /* Order matters: the most recent real measurement is the best guess the
       app has, so it is offered first. */
    const last = readLastFix(storage, Date.now());
    if (last) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'chip chip-xs';
      b.textContent = 'Last fix · ' + describeAge(last.age);
      b.addEventListener('click', () => setLocation({ lat: last.lat, lng: last.lng, accuracy: null, source: 'last-known' }));
      wrap.appendChild(b);
    }

    const preset = env.fallbackOrigin;
    if (preset && toNumberOrNull(preset.lat) !== null) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'chip chip-xs';
      b.textContent = preset.label || 'Use city centre';
      b.addEventListener('click', () => setLocation({
        lat: Number(preset.lat), lng: Number(preset.lng), accuracy: null, source: 'manual',
      }));
      wrap.appendChild(b);
    }
  }

  function useTypedCoordinates() {
    const coords = validCoords($('manualLat') && $('manualLat').value, $('manualLng') && $('manualLng').value);
    if (!coords) {
      toast('Those coordinates are not valid — check the latitude and longitude');
      return false;
    }
    setLocation({ lat: coords.lat, lng: coords.lng, accuracy: null, source: 'manual' });
    return true;
  }
  on($('useManualBtn'), 'click', useTypedCoordinates);

  function locate() {
    if (state.demo) {
      /* Demo mode never asks for a permission it cannot use, and never
         pretends the position is measured. */
      setLocation({ lat: 12.9716, lng: 77.5946, accuracy: null, source: 'demo' });
      return;
    }
    const geo = isCapacitorRuntime(win) ? {
      getCurrentPosition: (success, failure, options) => {
        Geolocation.requestPermissions({ permissions: ['location'] }).then(permission => {
          if (permission.location !== 'granted') throw new Error('Precise location permission is required');
          return Geolocation.getCurrentPosition(options);
        }).then(success, failure);
      }
    } : win.navigator && win.navigator.geolocation;
    if (!geo || typeof geo.getCurrentPosition !== 'function') {
      setLocationFailed(noGeolocationMessage());
      return;
    }
    state.location.status = 'locating';
    const status = $('locationStatus');
    if (status) status.textContent = 'Locating device…';
    try {
      geo.getCurrentPosition(
        pos => {
          const c = pos && pos.coords;
          const coords = validCoords(c && c.latitude, c && c.longitude);
          if (!coords) { setLocationFailed('The device returned an impossible position. Pick a starting point below.'); return; }
          const accuracy = toNumberOrNull(c.accuracy);
          setLocation({ lat: coords.lat, lng: coords.lng, accuracy: accuracy, source: 'gps' });
          writeLastFix(storage, { lat: coords.lat, lng: coords.lng, accuracy: accuracy });
        },
        err => setLocationFailed(describeGeoError(err)),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 }
      );
    } catch (err) {
      setLocationFailed(noGeolocationMessage());
    }
  }
  on($('locRetryBtn'), 'click', locate);

  function hasUsableLocation() {
    return state.location.status === 'ready' && state.location.lat !== null && state.location.lng !== null;
  }

  /* ── Readiness ───────────────────────────────────────────────────────── */

  function blockingReason() {
    if (state.selected.caseTypeId === null) return 'Pick a case type to broadcast';
    if (!hasUsableLocation()) return 'A position is needed before this can be sent';
    return null;
  }

  function refreshSubmitHint() {
    const hint = $('submitHint');
    const btn = $('submitBtn');
    if (!hint) return;
    const blocked = blockingReason();
    if (blocked) {
      hint.className = 'submit-hint is-bad';
      hint.textContent = blocked;
    } else {
      hint.className = 'submit-hint is-ok';
      const src = state.location.source;
      const detail = src === 'gps'
        ? 'GPS' + (state.location.accuracy != null ? ' ±' + Math.round(state.location.accuracy) + ' m' : '')
        : src === 'demo' ? 'demo position'
        : src === 'last-known' ? 'recalled fix, set by hand' : 'position set by hand';
      hint.textContent = 'Ready to broadcast · ' + detail;
    }
    if (btn) btn.disabled = false;
  }

  /* ── Photos ──────────────────────────────────────────────────────────── */

  function renderPhotos() {
    const grid = $('photoGrid');
    const count = $('photoCount');
    const add = $('addPhotoBtn');
    if (!grid) return;
    grid.querySelectorAll('.photo-tile').forEach(el => el.remove());
    state.images.forEach((src, index) => {
      const tile = doc.createElement('div');
      tile.className = 'photo-tile';
      const img = doc.createElement('img');
      img.alt = 'Attached photo ' + (index + 1);
      img.src = src;
      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'photo-remove';
      remove.setAttribute('aria-label', 'Remove photo ' + (index + 1));
      remove.textContent = '×';
      remove.addEventListener('click', () => { state.images.splice(index, 1); renderPhotos(); });
      tile.appendChild(img);
      tile.appendChild(remove);
      grid.insertBefore(tile, add || null);
    });
    if (count) count.textContent = state.images.length + ' / ' + MAX_IMAGES;
    if (add) add.hidden = state.images.length >= MAX_IMAGES;
  }

  async function addImage(dataUrl) {
    if (!dataUrl || state.images.length >= MAX_IMAGES) return false;
    state.images.push(dataUrl);
    renderPhotos();
    return true;
  }

  /* Android hands back the camera only when the input carries `capture`, and
     the gallery only when it does not — so the choice has to be made before
     the picker opens, not inside it. Hence two inputs and one small sheet. */
  on($('addPhotoBtn'), 'click', () => {
    if (state.images.length >= MAX_IMAGES) { toast('Four photos is the limit'); return; }
    openOverlay('photoSheet');
  });
  on($('photoCameraBtn'), 'click', () => { closeOverlay('photoSheet'); const i = $('cameraInput'); if (i) i.click(); });
  on($('photoGalleryBtn'), 'click', () => { closeOverlay('photoSheet'); const i = $('photoInput'); if (i) i.click(); });

  async function ingestFiles(e) {
    const files = Array.prototype.slice.call(e.target.files || []);
    let skipped = 0;
    for (const file of files) {
      if (state.images.length >= MAX_IMAGES) { skipped++; continue; }
      try { await addImage(await compressImage(file, 1280)); }
      catch (_) { toast('That photo could not be read'); }
    }
    if (skipped) toast(skipped + ' photo' + (skipped === 1 ? '' : 's') + ' skipped — four is the limit');
    /* Cleared so choosing the same file twice in a row still fires `change`. */
    e.target.value = '';
  }
  on($('photoInput'), 'change', ingestFiles);
  on($('cameraInput'), 'change', ingestFiles);

  function compressImage(file, maxSide) {
    return new Promise((resolve, reject) => {
      const reader = new win.FileReader();
      reader.onerror = () => reject(new Error('read failed'));
      reader.onload = () => {
        const raw = reader.result;
        let canvas;
        try { canvas = doc.createElement('canvas'); } catch (_) { return resolve(raw); }
        if (!canvas.getContext) return resolve(raw);
        const img = new win.Image();
        img.onerror = () => resolve(raw);
        img.onload = () => {
          try {
            const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.72));
          } catch (_) { resolve(raw); }
        };
        img.src = raw;
      };
      reader.readAsDataURL(file);
    });
  }

  /* ── Submit ──────────────────────────────────────────────────────────── */

  function collectForm() {
    const v = readVitals();
    return {
      caseTypeId: state.selected.caseTypeId,
      category: state.selected.category,
      age: $('age') ? $('age').value : '',
      gender: state.selected.gender,
      bloodGroup: state.selected.bloodGroup,
      systolicBp: v.systolicBp, diastolicBp: v.diastolicBp, heartRate: v.heartRate,
      respRate: v.respRate, spo2: v.spo2, glucose: v.glucose,
      consciousness: state.selected.consciousness,
      lat: state.location.lat, lng: state.location.lng,
      accuracy: state.location.accuracy, originSource: state.location.source,
      radiusKm: state.selected.radiusKm,
      images: state.images,
      eta: $('eta') ? $('eta').value : '',
      notes: $('notes') ? $('notes').value : '',
      ambulanceId: $('ambulanceId') ? $('ambulanceId').value : '',
      face: state.fastState.face, arm: state.fastState.arm, speech: state.fastState.speech,
      onsetHours: $('onsetHours') ? $('onsetHours').value : '',
    };
  }

  async function submitLoop() {
    const blocked = blockingReason();
    if (blocked) {
      toast(state.selected.caseTypeId === null ? 'Pick a case type first' : blocked);
      refreshSubmitHint();
      return null;
    }

    const payload = buildPayload(collectForm());
    /* Recorded before the attempt, so a failed send is still inspectable. */
    win.__GH_LAST_PAYLOAD = payload;
    state.lastPayload = payload;

    const btn = $('submitBtn');
    if (btn) { btn.disabled = true; btn.classList.add('is-loading'); }
    const crid = state.lastClientRequestId || ('cr-' + Date.now() + '-' + Math.floor(Math.random() * 1e6).toString(36));
    state.lastClientRequestId = crid;

    try {
      const res = await transport.broadcast(payload, crid);
      state.lastResponse = res;
      state.activeCaseCode = res.id;
      state.lastClientRequestId = null;
      setNetPill(state.demo ? 'demo' : 'live');
      recordCase(res, payload, 'PENDING');
      openSuccess(res, payload);
      startPolling(res.id);
      followCase(res.id);
      return res;
    } catch (err) {
      /* The outbox exists to survive a real signal gap. In demo mode there is
         no server to flush to, so queueing would promise a delivery that can
         never happen — say it failed instead. */
      if (err && err.network && !state.demo) queueForLater(payload, err);
      else showError((err && err.message) || 'The server refused this case.');
      return null;
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); }
    }
  }

  function queueForLater(payload, err) {
    const queued = outbox.enqueue(payload);
    if (!queued) {
      showError('No signal, and this case could not be queued on the device. Please retry.');
      return;
    }
    setNetPill('offline');
    renderOutbox();
    const info = $('outboxInfo');
    if (info) info.textContent = 'No signal. This case is queued and sends itself the moment you have a connection.';
    $('successOverlay').hidden = true;
    openOverlay('outboxOverlay');
    recordCase({ id: queued.id }, payload, 'QUEUED');
  }

  on($('submitBtn'), 'click', () => { submitLoop(); });

  /* ── Overlays ──────────────────────────────────────────────────────────
     Every sheet opens and closes through here so that four things are true
     of all of them without being written four times: the X works, Escape
     works, focus moves into the sheet and comes back to whatever opened it,
     and nothing typed is discarded on the way out. */

  const overlayReturn = {};

  function openOverlay(id) {
    const el = $(id);
    if (!el) return;
    overlayReturn[id] = doc.activeElement;
    el.hidden = false;
    const focusable = el.querySelector('button, [href], input, select, textarea');
    if (focusable && typeof focusable.focus === 'function') {
      try { focusable.focus({ preventScroll: true }); } catch (_) { focusable.focus(); }
    }
  }

  function closeOverlay(id) {
    const el = $(id);
    if (!el || el.hidden) return;
    el.hidden = true;
    const back = overlayReturn[id];
    overlayReturn[id] = null;
    if (back && doc.contains(back) && typeof back.focus === 'function') {
      try { back.focus({ preventScroll: true }); } catch (_) { back.focus(); }
    }
  }

  function topOverlay() {
    return $$('.overlay').filter(el => !el.hidden).pop() || null;
  }

  /* One listener for every X in the application. */
  on(doc, 'click', e => {
    const x = e.target.closest && e.target.closest('[data-close]');
    if (x) closeOverlay(x.getAttribute('data-close'));
  });

  on(doc, 'keydown', e => {
    if (e.key !== 'Escape') return;
    const open = topOverlay();
    if (open && open.id) { closeOverlay(open.id); e.preventDefault(); }
  });

  /* ── Overlay content ─────────────────────────────────────────────────── */

  function openSuccess(res, payload) {
    const overlay = $('successOverlay');
    const info = $('broadcastInfo');
    if (info) {
      const count = Number(res.hospitals_notified) || 0;
      info.textContent = 'Sent to ' + count + ' nearby hospital' + (count === 1 ? '' : 's') +
        ' within ' + payload.broadcast_radius_km + ' km.';
    }
    updateStatusChip({ status: 'PENDING' });
    const accepted = $('acceptedBox');
    if (accepted) accepted.hidden = true;
    ['callBtn', 'navBtn'].forEach(id => { const el = $(id); if (el) el.hidden = true; });
    $('errorOverlay').hidden = true;
    if (overlay) openOverlay('successOverlay');
  }

  function showError(message) {
    const el = $('errorMessage');
    if (el) el.textContent = message || 'The case could not be sent.';
    $('successOverlay').hidden = true;
    openOverlay('errorOverlay');
  }

  on($('backBtn'), 'click', () => closeOverlay('errorOverlay'));
  on($('retryBtn'), 'click', () => { closeOverlay('errorOverlay'); submitLoop(); });
  on($('newRequestBtn'), 'click', () => { closeOverlay('successOverlay'); resetForNewCase(); showView('new'); });
  on($('retryConnBtn'), 'click', () => { $('demoBanner').hidden = true; loadCaseTypes(); });
  on($('outboxPill'), 'click', () => openOverlay('outboxOverlay'));
  on($('tryFlushBtn'), 'click', () => flushOutbox());
  on($('discardQueuedBtn'), 'click', () => {
    outbox.clear(); renderOutbox(); closeOverlay('outboxOverlay');
  });

  function updateStatusChip(body) {
    const chip = $('statusChip');
    const text = $('statusChipText');
    const accepted = $('acceptedBox');
    if (!chip || !text) return;
    const status = body && body.status;

    if (status === 'ACCEPTED' || status === 'ARRIVED') {
      chip.className = 'status-chip status-accepted';
      const name = (body.accepted_hospital && body.accepted_hospital.name) || body.accepted_by || 'a hospital';
      text.textContent = status === 'ARRIVED' ? 'Arrived at ' + name : 'Accepted by ' + name;
      if (body.accepted_hospital) paintAcceptedHospital(body.accepted_hospital, body.priority);
      return;
    }
    if (status === 'EXPIRED' || status === 'REJECTED' || status === 'CANCELLED') {
      chip.className = 'status-chip status-failed';
      text.textContent = status === 'CANCELLED' ? 'Cancelled' : 'No hospital accepted';
      if (accepted) accepted.hidden = true;
      return;
    }
    chip.className = 'status-chip status-pending';
    text.textContent = 'Waiting for a hospital to accept…';
    if (accepted) accepted.hidden = true;
  }

  function paintAcceptedHospital(hospital, priority) {
    const box = $('acceptedBox');
    const name = $('acceptedName');
    const meta = $('acceptedMeta');
    if (name) name.textContent = hospital.name || '—';
    if (meta) {
      const bits = [];
      if (priority) bits.push(priority);
      if (hospital.distance_km != null) bits.push(Number(hospital.distance_km).toFixed(1) + ' km');
      if (hospital.phone) bits.push('☎ ' + hospital.phone);
      meta.textContent = bits.join(' · ');
    }
    if (box) box.hidden = false;

    const call = $('callBtn');
    if (call) {
      if (hospital.phone) { call.setAttribute('href', 'tel:' + hospital.phone); call.hidden = false; }
      else call.hidden = true;
    }
    const nav = $('navBtn');
    if (nav) {
      if (hospital.lat != null && hospital.lng != null) {
        /* geo: hands off to whatever navigation app the crew actually uses.
           GoldenHour is not trying to be a maps app. */
        nav.setAttribute('href', 'geo:' + hospital.lat + ',' + hospital.lng +
          '?q=' + hospital.lat + ',' + hospital.lng + '(' + encodeURIComponent(hospital.name || 'Hospital') + ')');
        nav.hidden = false;
      } else nav.hidden = true;
    }
  }

  /* ── Status polling ──────────────────────────────────────────────────── */

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    if (socket) { try { socket.disconnect(); } catch (_) {} socket = null; }
    if (geoWatch != null) {
      try { geoWatch(); } catch (_) {}
      geoWatch = null;
    }
  }

  function startPolling(caseCode) {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const body = await transport.status(caseCode);
        applyStatus(body);
        if (body.status === 'ARRIVED' || body.status === 'EXPIRED' ||
            body.status === 'REJECTED' || body.status === 'CANCELLED') {
          stopped = true;
          return;
        }
      } catch (_) { /* a dropped poll is not an event worth shouting about */ }
      if (!stopped) pollTimer = setTimeout(tick, pollMs());
    };
    pollTimer = setTimeout(tick, pollMs());
  }

  function applyStatus(body) {
    if (!body) return;
    updateStatusChip(body);
    if (state.activeCaseCode) {
      /* Only fields the server actually reported. Object.assign happily
         writes an `undefined` value over a real one, which is how the crew's
         own typed ETA was being erased the moment the first status arrived. */
      const extra = {};
      const acceptedBy = (body.accepted_hospital && body.accepted_hospital.name) || body.accepted_by;
      if (acceptedBy) extra.accepted_by = acceptedBy;
      if (body.live_eta_minutes != null) extra.eta_minutes = body.live_eta_minutes;
      if (body.eta_source) extra.eta_source = body.eta_source;
      caseBook.setStatus(state.activeCaseCode, body.status, extra);
    }
    if (body.status === 'ACCEPTED') startSharingPosition(body);
    if (['ARRIVED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(body.status)) stopSharingPosition();
    if (body.status === 'ACCEPTED') paintTracking(body);
    if (body.status === 'ARRIVED') {
      const banner = $('arrivedBanner');
      if (banner) banner.hidden = false;
      stopSharingPosition();
    }
    renderHome();
  }

  /* ── Realtime + position sharing ─────────────────────────────────────── */

  function followCase(caseCode) {
    if (state.demo || !env.realtime || !win.io) return;
    try {
      socket = win.io(env.serverBase || undefined, { transports: ['websocket', 'polling'] });
    } catch (_) { socket = null; return; }
    socket.on('connect', () => socket.emit('case:follow', caseCode));
    socket.on('case:status', body => applyStatus(normaliseStatus(body)));
    socket.on('case:position', body => paintTracking(body));
    socket.on('disconnect', () => { const t = $('trackingText'); if (t) t.textContent = 'Disconnected — hospital is not receiving location updates'; });
    socket.on('patient:updated', () => {
      const t = $('updateTicker');
      if (!t) return;
      t.textContent = 'Patient details updated';
      setTimeout(() => { t.textContent = ''; }, 2400);
    });
  }
  function normaliseStatus(body) { return body || {}; }

  function startSharingPosition(body) {
    const tracking = $('activeTracking');
    if (tracking) tracking.hidden = false;
    if (state.demo || geoWatch != null) return;
    const geo = win.navigator && win.navigator.geolocation;
    if (!socket) { const t = $('trackingText'); if (t) t.textContent = 'Live tracking unavailable — realtime connection is required'; return; }
    const code = state.activeCaseCode;
    const text = $('trackingText');
    if (text) text.textContent = 'Waiting for GPS and server confirmation…';
    let lastSent = 0;
    geoWatch = watchPosition({ native: isCapacitorRuntime(win), plugin: Geolocation, geolocation: geo,
      onPosition: pos => {
        if (state.activeCaseCode !== code || (caseBook.get(code) || {}).status !== 'ACCEPTED') return;
        if (!socket || !socket.connected) { if (text) text.textContent = 'Disconnected — hospital is not receiving location updates'; return; }
        const now = Date.now();
        if (now - lastSent < 10000) return;
        const c = pos && pos.coords;
        const coords = validCoords(c && c.latitude, c && c.longitude);
        const timestamp = pos && pos.timestamp;
        if (!coords || !Number.isFinite(timestamp) || now - timestamp > 30000 || timestamp > now + 30000 || c.accuracy > 200) {
          if (text) text.textContent = 'Waiting for a fresh, accurate GPS fix…';
          return;
        }
        lastSent = now;
        // Do not buffer old positions across a socket outage.
        let confirmed = false;
        const timer = setTimeout(() => { if (!confirmed && text && state.activeCaseCode === code) text.textContent = 'Location delivery unconfirmed — waiting for connection'; }, 6000);
        socket.volatile.emit('ambulance:position', {
          case_code: code, lat: coords.lat, lng: coords.lng,
          accuracy_m: toNumberOrNull(c.accuracy),
          speed_kmh: c.speed != null && c.speed >= 0 ? Math.round(c.speed * 3.6) : null,
          source: 'gps', at: new Date(timestamp).toISOString(),
        }, ack => {
          confirmed = true; clearTimeout(timer);
          if (state.activeCaseCode !== code || (caseBook.get(code) || {}).status !== 'ACCEPTED') return;
          if (text) text.textContent = ack && ack.success ? 'GPS location delivered to the accepting hospital' : 'Location was not accepted — waiting for a fresh fix';
        });
      },
      onError: err => { if (text) text.textContent = 'GPS unavailable — check location permission and keep the app open'; },
    });
  }

  on($('retryTrackingBtn'), 'click', () => {
    if ((caseBook.get(state.activeCaseCode) || {}).status !== 'ACCEPTED') return;
    stopSharingPosition();
    startSharingPosition({});
  });

  function stopSharingPosition() {
    const tracking = $('activeTracking');
    if (tracking) tracking.hidden = true;
    if (geoWatch != null) {
      try { geoWatch(); } catch (_) {}
      geoWatch = null;
    }
  }

  function paintTracking(body) {
    const text = $('trackingText');
    const eta = $('activeEta');
    if (body && body.live_eta_minutes != null && eta) eta.textContent = body.live_eta_minutes + ' min';
    if (!text || !body) return;
    if (body.eta_source === 'stale') { text.textContent = 'Location is stale — hospital is waiting for a fresh GPS fix'; if (eta) eta.textContent = 'Unavailable'; return; }
    if (!socket || !socket.connected) { text.textContent = 'Disconnected — hospital is not receiving location updates'; return; }
    if (!body.position_at && !body.at) return;
    text.textContent = ['stalled', 'stationary'].includes(body.eta_source)
      ? 'Not moving — tell the hospital if you are delayed'
      : 'Sharing location with the accepting hospital' +
        (body.live_eta_minutes != null ? ' · ' + body.live_eta_minutes + ' min out' : '');
  }

  on($('delayedBtn'), 'click', () => {
    if (!state.activeCaseCode || !socket) { toast('Not sharing location yet'); return; }
    socket.emit('ambulance:delayed', { case_code: state.activeCaseCode, reason: 'traffic' }, () => {});
    toast('The hospital has been told you are delayed');
  });

  /* ── Arrived ─────────────────────────────────────────────────────────── */

  let arrivalInFlight = false;
  on($('arrivedBtn'), 'click', async () => {
    if (!state.activeCaseCode || arrivalInFlight) return;
    const entry = caseBook.get(state.activeCaseCode);
    if (entry && entry.status === 'ARRIVED') { toast('Arrival is already recorded'); return; }
    if (win.confirm && !win.confirm('Record arrival and close this case?')) return;

    arrivalInFlight = true;
    try {
      if (!state.demo) await recordArrival({ socket, fetch: win.fetch && win.fetch.bind(win), apiRoot: env.apiRoot, caseCode: state.activeCaseCode });
      stopSharingPosition();
      caseBook.setStatus(state.activeCaseCode, 'ARRIVED');
      updateStatusChip({ status: 'ARRIVED', accepted_by: (caseBook.get(state.activeCaseCode) || {}).accepted_by });
      const banner = $('arrivedBanner');
      if (banner) banner.hidden = false;
      toast('Arrival recorded');
      renderHome();
    } catch (err) {
      toast('Arrival could not be recorded — try again');
    } finally {
      arrivalInFlight = false;
    }
  });

  /* ── Edit patient in transit ─────────────────────────────────────────── */

  on($('editPatientBtn'), 'click', () => {
    if (!state.activeCaseCode) { toast('No active case to update'); return; }
    const p = state.lastPayload || {};
    const v = (p.vitals || {});
    const setVal = (id, value) => { const el = $(id); if (el) el.value = value == null ? '' : String(value); };
    /* Seeded from the band the stored age falls in, so re-saving without
       touching it cannot silently change the patient's age group. */
    paintAgeBands('editAgeChips', describeAgeBand(p.age).id);
    paintRadio('editGender', 'data-value', p.gender || 'U');
    paintRadio('editConsciousness', 'data-value', p.consciousness);
    paintChipRow('editBloodRow', 'data-blood', p.blood_group);
    setVal('editSys', v.systolic_bp); setVal('editDia', v.diastolic_bp);
    setVal('editHr', v.heart_rate); setVal('editRr', v.resp_rate);
    setVal('editSpo2', v.spo2); setVal('editGlc', v.glucose);
    setVal('editNotes', p.notes);
    const status = $('editStatus');
    if (status) status.textContent = '';
    openOverlay('editOverlay');
  });
  on($('editCancelBtn'), 'click', () => closeOverlay('editOverlay'));

  on($('editAgeChips'), 'click', e => {
    const b = e.target.closest('.band');
    if (b) paintAgeBands('editAgeChips', b.dataset.ageBand);
  });

  function paintRadio(containerId, attr, value) {
    const c = $(containerId);
    if (!c) return;
    c.querySelectorAll('[' + attr + ']').forEach(x => {
      const isOn = value != null && x.getAttribute(attr) === String(value);
      x.classList.toggle('is-on', isOn);
      if (x.hasAttribute('role')) x.setAttribute('aria-checked', isOn ? 'true' : 'false');
    });
  }
  function paintChipRow(containerId, attr, value) {
    const c = $(containerId);
    if (!c) return;
    c.querySelectorAll('[' + attr + ']').forEach(x => {
      x.classList.toggle('is-on', value != null && x.getAttribute(attr) === String(value));
    });
  }

  on($('editSaveBtn'), 'click', () => {
    const status = $('editStatus');
    if (!state.activeCaseCode) { if (status) status.textContent = 'No active case.'; return; }
    const selected = sel => { const el = doc.querySelector(sel); return el ? el : null; };
    const genderEl = selected('#editGender .seg-btn.is-on');
    const bloodEl = selected('#editBloodRow .chip.is-on');
    const consciousEl = selected('#editConsciousness .level.is-on');

    const bandEl = selected('#editAgeChips .band.is-on');
    const band = bandEl ? ageBandById(bandEl.dataset.ageBand) : null;

    const patch = {
      /* `null` is a real choice here — it is what "Unknown" means — so the
         key is sent whenever a band is selected, including that one. */
      age: band ? (band.id === 'unknown' ? null : describeAgeBand((state.lastPayload || {}).age).id === band.id
        ? (state.lastPayload || {}).age : band.value) : undefined,
      gender: genderEl ? genderEl.dataset.value : undefined,
      blood_group: bloodEl ? bloodEl.dataset.blood : undefined,
      consciousness: consciousEl ? consciousEl.dataset.value : undefined,
      vitals: {
        systolic_bp: toNumberOrNull($('editSys').value),
        diastolic_bp: toNumberOrNull($('editDia').value),
        heart_rate: toNumberOrNull($('editHr').value),
        resp_rate: toNumberOrNull($('editRr').value),
        spo2: toNumberOrNull($('editSpo2').value),
        glucose: toNumberOrNull($('editGlc').value),
      },
      notes: toTextOrNull($('editNotes').value),
    };
    Object.keys(patch).forEach(k => { if (patch[k] === undefined) delete patch[k]; });

    if (state.demo) {
      applyLocalPatch(patch);
      if (status) status.textContent = 'Saved on this device (demo mode).';
      setTimeout(() => closeOverlay('editOverlay'), 700);
      return;
    }
    if (!socket || !socket.connected) {
      if (status) status.textContent = 'Not connected — the hospital has not seen this change. It will need resending.';
      return;
    }
    if (status) status.textContent = 'Sending…';
    socket.emit('patient:update', { case_code: state.activeCaseCode, patient: patch }, body => {
      if (body && body.success) {
        applyLocalPatch(patch);
        if (status) status.textContent = 'Saved. The hospital has it.';
        setTimeout(() => closeOverlay('editOverlay'), 700);
      } else if (status) {
        status.textContent = (body && body.message) || 'The server refused this update.';
      }
    });
  });

  function applyLocalPatch(patch) {
    if (!state.lastPayload) return;
    if ('age' in patch) state.lastPayload.age = patch.age;
    if ('gender' in patch) state.lastPayload.gender = patch.gender;
    if ('blood_group' in patch) state.lastPayload.blood_group = patch.blood_group;
    if ('consciousness' in patch) state.lastPayload.consciousness = patch.consciousness;
    if ('notes' in patch) state.lastPayload.notes = patch.notes;
    if (patch.vitals) state.lastPayload.vitals = Object.assign({}, state.lastPayload.vitals, patch.vitals);
    if (state.activeCaseCode) {
      caseBook.record({
        case_code: state.activeCaseCode,
        age: state.lastPayload.age,
        gender: state.lastPayload.gender,
      });
    }
    renderHome();
  }

  /* ── Outbox ──────────────────────────────────────────────────────────── */

  function renderOutbox() {
    const pill = $('outboxPill');
    const text = $('outboxText');
    const list = $('outboxList');
    const count = outbox.count();
    if (pill) pill.hidden = count === 0;
    if (text) text.textContent = count + ' case' + (count === 1 ? '' : 's') + ' queued';
    if (list) {
      list.textContent = '';
      outbox.all().forEach(entry => {
        const row = doc.createElement('div');
        row.className = 'recent-row';
        const main = doc.createElement('div');
        main.className = 'recent-main';
        const title = doc.createElement('span');
        title.className = 'recent-title';
        title.textContent = 'Queued case';
        const meta = doc.createElement('span');
        meta.className = 'recent-meta';
        meta.textContent = describeWhen(entry.created_at) +
          (entry.attempts ? ' · ' + entry.attempts + ' attempt' + (entry.attempts === 1 ? '' : 's') : '') +
          (entry.photos_dropped ? ' · photos dropped to fit' : '');
        main.appendChild(title); main.appendChild(meta);
        const status = doc.createElement('span');
        status.className = 'recent-status tone-caution';
        status.textContent = 'Queued';
        row.appendChild(main); row.appendChild(status);
        list.appendChild(row);
      });
    }
    if (count === 0) { const o = $('outboxOverlay'); if (o) o.hidden = true; }
  }

  async function flushOutbox() {
    if (outbox.isEmpty() || state.demo) return;
    const stale = outbox.stale();
    if (stale.length) {
      const info = $('outboxInfo');
      if (info) {
        info.textContent = stale.length + ' queued case' + (stale.length === 1 ? ' has' : 's have') +
          ' been waiting over 15 minutes. The patient may already be at a hospital — send or discard deliberately.';
      }
      if ($('outboxOverlay')) $('outboxOverlay').hidden = false;
    }
    try {
      const result = await outbox.flush((payload, id) => transport.broadcast(payload, id));
      if (result.sent.length) {
        toast(result.sent.length + ' queued case' + (result.sent.length === 1 ? '' : 's') + ' sent');
        setNetPill('live');
        const last = result.sent[result.sent.length - 1];
        state.activeCaseCode = last.response.id;
        state.lastResponse = last.response;
        recordCase(last.response, last.entry.payload, 'PENDING');
        startPolling(last.response.id);
        followCase(last.response.id);
      }
    } catch (_) { /* still no signal */ }
    renderOutbox();
    renderHome();
  }

  /* ── Case book / home ────────────────────────────────────────────────── */

  function recordCase(res, payload, status) {
    const type = state.caseTypes.find(t => Number(t.id) === Number(payload.case_type_id));
    caseBook.record({
      case_code: res.id,
      case_label: type ? (type.short || type.label) : 'Case',
      age: payload.age,
      gender: payload.gender,
      status,
      eta_minutes: payload.eta_minutes,
    });
    renderHome();
  }

  function renderHome() {
    const active = caseBook.current();
    const box = $('activeCaseBox');
    const quickActive = $('quickActiveSub');
    const quickRecent = $('quickRecentSub');
    const all = caseBook.all();

    if (quickRecent) {
      quickRecent.textContent = all.length
        ? all.length + ' case' + (all.length === 1 ? '' : 's') + ' on this device.'
        : 'Nothing yet this shift.';
    }

    if (!active) {
      if (box) box.hidden = true;
      if (quickActive) quickActive.textContent = 'No case is running.';
    } else {
      if (box) box.hidden = false;
      if (quickActive) quickActive.textContent = active.case_label + ' · ' + (STATUS_TEXT[active.status] || active.status);
      const p = state.lastPayload || {};
      const v = p.vitals || {};
      const set = (id, value) => { const el = $(id); if (el) el.textContent = (value === null || value === undefined || value === '') ? '—' : String(value); };
      set('activeCaseCode', active.case_code);
      set('activePatientName', active.case_label);
      set('activeAgeBand', ageBandLabel(active.age));
      set('activeGenderLabel', ({ M: 'Male', F: 'Female', O: 'Other', U: 'Unknown' })[active.gender] || 'Unknown');
      set('activeBlood', p.blood_group);
      set('activeCondition', p.consciousness);
      set('activeHr', v.heart_rate);
      set('activeBp', (v.systolic_bp || '—') + '/' + (v.diastolic_bp || '—'));
      set('activeSpo2', v.spo2);
      set('activeStatusText', STATUS_TEXT[active.status] || active.status);
      set('activeEta', active.eta_minutes != null ? active.eta_minutes + ' min' : '— min');
      set('activeFacility', active.accepted_by || 'Waiting for a hospital');
      const notes = $('activeNotes');
      if (notes) notes.textContent = p.notes || 'No additional notes';
      const arrived = active.status === 'ARRIVED';
      const accepted = active.status === 'ACCEPTED';
      const arrivedBtn = $('arrivedBtn');
      if (arrivedBtn) { arrivedBtn.disabled = !accepted; arrivedBtn.hidden = arrived; }
      const banner = $('arrivedBanner');
      if (banner) banner.hidden = !arrived;
      /* Once the case is closed, the transit controls are noise. */
      ['editPatientBtn', 'delayedBtn', 'continueCaseBtn'].forEach(id => {
        const el = $(id); if (el) el.hidden = arrived;
      });
      /* Editing a patient and reporting a delay both need a hospital that has
         accepted — the server refuses either before that, and there is no
         point letting a crew fill in a form only to be told so afterwards. */
      ['editPatientBtn', 'delayedBtn'].forEach(id => {
        const el = $(id);
        if (!el) return;
        el.disabled = !accepted;
        el.title = accepted ? '' : 'Available once a hospital accepts this case';
      });
    }
    renderRecentInto('homeRecentList', 4);
  }

  function renderRecentInto(containerId, limit) {
    const list = $(containerId);
    if (!list) return;
    const all = caseBook.all().slice(0, limit || 50);
    list.textContent = '';
    if (!all.length) {
      const p = doc.createElement('p');
      p.className = 'empty-note';
      p.textContent = 'Cases you send appear here.';
      list.appendChild(p);
      return;
    }
    all.forEach(entry => {
      const row = doc.createElement('div');
      row.className = 'recent-row';
      const main = doc.createElement('div');
      main.className = 'recent-main';
      const title = doc.createElement('span');
      title.className = 'recent-title';
      title.textContent = entry.case_label || 'Case';
      const meta = doc.createElement('span');
      meta.className = 'recent-meta';
      const sex = ({ M: 'Male', F: 'Female', O: 'Other' })[entry.gender] || 'Sex not recorded';
      meta.textContent = ageBandLabel(entry.age) + ' · ' + sex + ' · ' + describeWhen(entry.created_at);
      main.appendChild(title); main.appendChild(meta);
      const status = doc.createElement('span');
      status.className = 'recent-status tone-' + (STATUS_TONE[entry.status] || 'muted');
      status.textContent = STATUS_TEXT[entry.status] || entry.status;
      row.appendChild(main); row.appendChild(status);
      list.appendChild(row);
    });
  }
  function renderCaseList() { renderRecentInto('caseList', 50); }

  /* ── Settings ──────────────────────────────────────────────────────────
     Only things this build actually has: which unit this is, what the app is
     connected to and why, what is queued, and what is stored locally. No
     invented switches, and deliberately no colour theme. */

  function renderSettings() {
    const set = (id, value) => { const el = $(id); if (el) el.textContent = value; };

    set('setMode', state.demo ? 'Demo — nothing is sent' : 'Live');
    set('setBackend', env.serverBase || (state.demo ? 'Not configured' : (win.location && win.location.origin) || '—'));
    set('setRealtime', env.realtime ? (socket && socket.connected ? 'Connected' : 'Enabled') : 'Off');
    set('setModeWhy', capitalise(env.reason) + '.');

    const queued = outbox.count();
    set('setOutboxSummary', queued
      ? queued + ' case' + (queued === 1 ? '' : 's') + ' waiting to send.'
      : 'Nothing is waiting to send.');
    const openBtn = $('setOutboxBtn');
    if (openBtn) openBtn.disabled = queued === 0;

    set('setCaseCount', String(caseBook.all().length));
  }
  function capitalise(text) {
    const t = String(text || '');
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  }

  on($('setRecheckBtn'), 'click', async () => {
    if (state.demo) { toast('This build has no backend configured'); renderSettings(); return; }
    await loadCaseTypes();
    toast('Connection re-checked');
    renderSettings();
  });
  on($('setOutboxBtn'), 'click', () => { if (outbox.count()) openOverlay('outboxOverlay'); });
  on($('setClearCasesBtn'), 'click', () => {
    if (caseBook.active()) { toast('Finish or close the active case first'); return; }
    if (win.confirm && !win.confirm('Clear the case history stored on this device?')) return;
    caseBook.clear();
    renderHome(); renderCaseList(); renderSettings();
    toast('Local case history cleared');
  });

  /* ── Reset ───────────────────────────────────────────────────────────── */

  function resetForNewCase() {
    state.selected.caseTypeId = null;
    state.selected.category = null;
    state.selected.gender = 'U';
    state.selected.ageBand = 'unknown';
    state.touched = { age: false, gender: false };
    state.selected.bloodGroup = null;
    state.selected.consciousness = null;
    state.fastState = { face: false, arm: false, speech: false };
    state.needsTouched = false;
    state.images = [];
    state.lastClientRequestId = null;

    ['age', 'systolicBp', 'diastolicBp', 'heartRate', 'respRate', 'spo2', 'glucose', 'eta', 'onsetHours', 'notes']
      .forEach(id => { const el = $(id); if (el) el.value = ''; });
    setAgeBand('unknown', { touched: false });
    const sel = $('caseType');
    if (sel) sel.value = '';
    const count = $('notesCount');
    if (count) count.textContent = '0 / 160';

    $$('#quickCase .chip, #bloodChips .chip, #etaChips .chip, #onsetChips .chip')
      .forEach(c => c.classList.remove('is-on'));

    resetRadioGroup('genderSeg', 'data-value', 'U');
    resetRadioGroup('consciousnessGroup', 'data-value', null);
    ['fastFace', 'fastArm', 'fastSpeech'].forEach(id => resetRadioGroup(id, 'data-yn', 'no'));

    setRadius(15);
    const stroke = $('strokeSection');
    if (stroke) stroke.hidden = true;

    repaintAllVitals();
    renderPhotos();
    refreshNeeds();
    markAnswered();
    /* The ambulance has moved since the last case. Ask again. */
    locate();
    refreshSubmitHint();
  }

  function resetRadioGroup(containerId, attr, value) {
    const container = $(containerId);
    if (!container) return;
    container.querySelectorAll('[' + attr + ']').forEach(x => {
      const isOn = value !== null && x.getAttribute(attr) === value;
      x.classList.toggle('is-on', isOn);
      if (x.hasAttribute('role')) x.setAttribute('aria-checked', isOn ? 'true' : 'false');
    });
  }

  /* ── Chrome ──────────────────────────────────────────────────────────── */

  let toastTimer = null;
  function toast(message) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }

  function setNetPill(mode) {
    const pill = $('netPill');
    if (!pill) return;
    pill.className = 'pill ' + (mode === 'live' ? 'pill-good' : mode === 'demo' ? 'pill-caution' : 'pill-critical');
    pill.textContent = mode === 'live' ? 'Live' : mode === 'demo' ? 'Demo' : 'Offline';
  }

  /* ── Go ──────────────────────────────────────────────────────────────── */

  renderCaseTypes();
  renderAgeBands('ageChips');
  renderAgeBands('editAgeChips');
  setAgeBand('unknown', { touched: false });
  markAnswered();
  setRadius(15);
  repaintAllVitals();
  renderPhotos();
  refreshNeeds();
  renderOutbox();
  renderHome();
  renderSettings();
  locate();
  refreshSubmitHint();
  showView('home');

  if (state.demo) {
    setNetPill('demo');
    const banner = $('demoBanner');
    if (banner) banner.hidden = false;
  } else {
    setNetPill('live');
    const banner = $('demoBanner');
    if (banner) banner.hidden = true;
    loadCaseTypes();
    flushTimer = setInterval(() => { flushOutbox(); }, 20000);
    on(win, 'online', () => { setNetPill('live'); flushOutbox(); });
    on(win, 'offline', () => setNetPill('offline'));
  }

  /* ── Test handle ─────────────────────────────────────────────────────── */

  win.__GH = {
    state: () => ({
      demo: state.demo,
      location: Object.assign({}, state.location),
      selected: Object.assign({}, state.selected),
      touched: Object.assign({}, state.touched),
      fastState: Object.assign({}, state.fastState),
      needs: Object.assign({}, state.needs),
      images: state.images.slice(),
      activeCaseCode: state.activeCaseCode,
    }),
    buildPayload,
    getBandFor,
    isOutOfRange,
    submitLoop,
    addImage,
    useTypedCoordinates,
    hasUsableLocation,
    updateStatusChip,
    setAgeBand,
    openOverlay,
    closeOverlay,
    renderSettings,
    stopPolling,
    locate,
    flushOutbox,
    showView,
    env,
  };
}

/* ── Storage that cannot throw ───────────────────────────────────────────────
   Some Android WebViews throw on any localStorage access when third-party
   data is blocked. An ambulance app must not die on that. */
function safeStorage(win) {
  const memory = {};
  let real = null;
  try { real = win.localStorage; real.getItem('__gh_probe__'); } catch (_) { real = null; }
  return {
    getItem(k) { try { return real ? real.getItem(k) : (k in memory ? memory[k] : null); } catch (_) { return k in memory ? memory[k] : null; } },
    setItem(k, v) { memory[k] = String(v); try { if (real) real.setItem(k, v); } catch (_) {} },
    removeItem(k) { delete memory[k]; try { if (real) real.removeItem(k); } catch (_) {} },
  };
}
