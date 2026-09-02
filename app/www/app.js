/* ============================================================
   GoldenHour v3 — ambulance-side pre-arrival alert
   Plain JavaScript. No framework, no build step, no bundler.

   Flow:  fill form  →  Broadcast Request  →  every registered
          hospital inside the radius is alerted  →  first one to
          accept claims the case  →  this screen updates itself.
   ============================================================ */

/* ── 1. Configuration ──────────────────────────────────────── */

/* Everything tunable lives in config.js, which loads first.
   Nothing below needs editing to point the app at a backend. */

var CFG = (typeof window !== "undefined" && window.GH_CONFIG) || {};

/**
 * Is this running inside the Capacitor APK rather than a browser?
 *
 * This matters more than it looks. Capacitor serves the APK's assets from
 * https://localhost, so "just use the page origin" would resolve to
 * https://localhost/api/v1 — a server that does not exist — instead of
 * falling back to demo mode. A browser never has window.Capacitor, so its
 * presence is the reliable signal.
 */
function inNativeShell() {
  return typeof window !== "undefined" && !!window.Capacitor;
}

/**
 * Where is the server?
 *   1. GH_CONFIG.SERVER_BASE, when it is filled in (this is the APK case)
 *   2. the origin this page was served from (browser on the LAN)
 *   3. nothing — and "nothing" means demo mode
 */
function resolveServerBase() {
  var configured = (CFG.SERVER_BASE || "").replace(/\/+$/, "");
  if (configured && configured.indexOf("REPLACE-WITH-YOUR-BACKEND") === -1) return configured;

  if (inNativeShell()) return "";   /* the APK must be told, never guess localhost */

  if (typeof window !== "undefined" && window.location) {
    var proto = window.location.protocol;
    if (proto === "http:" || proto === "https:") {
      return window.location.origin.replace(/\/+$/, "");
    }
  }
  return "";   /* file:// or capacitor:// with nothing configured */
}

var SERVER_BASE = resolveServerBase();
var API_BASE = SERVER_BASE + (CFG.API_PATH || "/api/v1");

/* Tests and demos may override before app.js runs. */
if (typeof window !== "undefined" && window.__GH_API_BASE) {
  API_BASE = window.__GH_API_BASE;
  SERVER_BASE = API_BASE.replace(/\/api\/v\d+\/?$/, "");
}

var DEMO;
if (typeof window !== "undefined" && typeof window.__GH_DEMO === "boolean") {
  DEMO = window.__GH_DEMO;                      /* explicit wins — used by the test suite */
} else if (CFG.MODE === "demo") {
  DEMO = true;
} else if (CFG.MODE === "live") {
  DEMO = false;
} else {
  DEMO = SERVER_BASE === "";                    /* auto */
}

var REALTIME = CFG.REALTIME !== false;
var POLL_MS = (typeof window !== "undefined" && window.__GH_POLL_MS) || CFG.POLL_MS || 4000;
/* Simulated network latency in demo mode (tests shorten this). */
var DEMO_POST_MS = (typeof window !== "undefined" && window.__GH_DEMO_POST_MS) || 650;
var REQUEST_TIMEOUT_MS = 15000;
/* Phase 2: enable Edit Patient + Reached Hospital UI even on cached laptops. */
var ENABLE_TRANSPORT_EDIT = true;
var MAX_IMAGES = 4;
var MAX_IMAGE_PX = 900;
var IMAGE_QUALITY = 0.6;
var DEFAULT_RADIUS_KM = 15;

/* ── 2. Reference data ─────────────────────────────────────── */

var CATEGORY_LABELS = {
  TRAUMA:     "Trauma & injury",
  CARDIAC:    "Cardiac",
  STROKE:     "Stroke",
  NEURO:      "Neurological",
  RESP:       "Breathing & airway",
  METABOLIC:  "Metabolic",
  OBSTETRIC:  "Obstetric & newborn",
  PAEDIATRIC: "Paediatric",
  POISONING:  "Poisoning & bites",
  ALLERGY:    "Allergic",
  OTHER:      "Other"
};

var CATEGORY_ORDER = ["TRAUMA","CARDIAC","STROKE","NEURO","RESP","METABOLIC",
                      "OBSTETRIC","PAEDIATRIC","POISONING","ALLERGY","OTHER"];

/* Used only in demo mode. In live mode this comes from GET /case-types. */
var DEMO_CASE_TYPES = [
  { id: 1,  category: "TRAUMA",     label: "Road accident — multiple injuries", quick: true,  short: "Road accident" },
  { id: 2,  category: "TRAUMA",     label: "Head injury",                       quick: true,  short: "Head injury" },
  { id: 3,  category: "TRAUMA",     label: "Fall from height" },
  { id: 4,  category: "TRAUMA",     label: "Stab / gunshot / penetrating wound" },
  { id: 5,  category: "TRAUMA",     label: "Major burns" },
  { id: 6,  category: "TRAUMA",     label: "Crush injury / amputation" },
  { id: 7,  category: "TRAUMA",     label: "Suspected spinal injury" },

  { id: 8,  category: "CARDIAC",    label: "Chest pain / suspected heart attack", quick: true, short: "Chest pain" },
  { id: 9,  category: "CARDIAC",    label: "Cardiac arrest — CPR in progress",    quick: true, short: "Cardiac arrest" },
  { id: 10, category: "CARDIAC",    label: "Irregular heartbeat / arrhythmia" },
  { id: 11, category: "CARDIAC",    label: "Heart failure / fluid in lungs" },

  { id: 12, category: "STROKE",     label: "Stroke / sudden weakness or slurred speech", quick: true, short: "Stroke" },
  { id: 13, category: "STROKE",     label: "Suspected TIA (symptoms already settled)" },

  { id: 14, category: "NEURO",      label: "Seizure / fits" },
  { id: 15, category: "NEURO",      label: "Unresponsive — cause unknown" },

  { id: 16, category: "RESP",       label: "Severe breathlessness / asthma attack", quick: true, short: "Breathless" },
  { id: 17, category: "RESP",       label: "COPD flare-up" },
  { id: 18, category: "RESP",       label: "Choking / blocked airway" },
  { id: 19, category: "RESP",       label: "Drowning" },

  { id: 20, category: "METABOLIC",  label: "Low blood sugar (hypoglycaemia)" },
  { id: 21, category: "METABOLIC",  label: "High blood sugar / DKA" },
  { id: 22, category: "METABOLIC",  label: "Heat stroke / severe dehydration" },

  { id: 23, category: "OBSTETRIC",  label: "Labour / delivery imminent" },
  { id: 24, category: "OBSTETRIC",  label: "Pregnancy emergency (bleeding, fits, high BP)" },
  { id: 25, category: "OBSTETRIC",  label: "Newborn in distress" },

  { id: 26, category: "PAEDIATRIC", label: "Sick child — high fever or fits" },
  { id: 27, category: "PAEDIATRIC", label: "Injured child" },

  { id: 28, category: "POISONING",  label: "Poisoning / overdose" },
  { id: 29, category: "POISONING",  label: "Snake bite / animal bite" },

  { id: 30, category: "ALLERGY",    label: "Severe allergic reaction (anaphylaxis)" },

  { id: 31, category: "OTHER",      label: "Heavy bleeding (not from injury)" },
  { id: 32, category: "OTHER",      label: "Psychiatric emergency" },
  { id: 33, category: "OTHER",      label: "Other emergency" }
];

/* ── 3. Vital-sign bands ───────────────────────────────────── */
/* A band answers one question: what colour should this number be?
   It is a bedside hint for the crew — the hospital system computes
   the official RED/AMBER/GREEN priority, never this app. */

var LEVELS = { GOOD: "good", CAUTION: "caution", CRITICAL: "critical" };

/* Plausible-entry ranges. Outside these the value is treated as a
   typo: no colour band, and the field is flagged out-of-range. */
var RANGES = {
  systolicBp:  { min: 40, max: 300 },
  diastolicBp: { min: 20, max: 200 },
  heartRate:   { min: 20, max: 300 },
  respRate:    { min: 4,  max: 80  },
  spo2:        { min: 50, max: 100 },
  glucose:     { min: 10, max: 900 },
  age:         { min: 0,  max: 120 },
  eta:         { min: 1,  max: 180 },
  onsetHours:  { min: 0,  max: 72  },
  radiusKm:    { min: 2,  max: 40  }
};

/* Each band: low-critical / low-caution / good / high-caution / high-critical.
   Boundaries are inclusive of the value shown. */
var BANDS = {
  systolicBp:  { criticalLow: 89,  cautionLow: 99,  cautionHigh: 140, criticalHigh: 180 },
  diastolicBp: { criticalLow: 49,  cautionLow: 59,  cautionHigh: 90,  criticalHigh: 120 },
  heartRate:   { criticalLow: 49,  cautionLow: 59,  cautionHigh: 101, criticalHigh: 121 },
  respRate:    { criticalLow: 8,   cautionLow: 11,  cautionHigh: 21,  criticalHigh: 30  },
  spo2:        { criticalLow: 89,  cautionLow: 94,  cautionHigh: 101, criticalHigh: 101 },
  glucose:     { criticalLow: 59,  cautionLow: 69,  cautionHigh: 141, criticalHigh: 250 }
};

/**
 * Map a vital value to "good" | "caution" | "critical", or null when
 * the field is blank, not a number, or outside its plausible range.
 */
function getBandFor(bandKey, value) {
  var band = BANDS[bandKey];
  if (!band) return null;
  if (value === "" || value === null || value === undefined) return null;

  var n = Number(value);
  if (isNaN(n)) return null;

  var range = RANGES[bandKey];
  if (range && (n < range.min || n > range.max)) return null;

  if (n <= band.criticalLow)  return LEVELS.CRITICAL;
  if (n >= band.criticalHigh) return LEVELS.CRITICAL;
  if (n <= band.cautionLow)   return LEVELS.CAUTION;
  if (n >= band.cautionHigh)  return LEVELS.CAUTION;
  return LEVELS.GOOD;
}

/** True when a filled-in value is outside its plausible range. */
function isOutOfRange(key, value) {
  var range = RANGES[key];
  if (!range) return false;
  if (value === "" || value === null || value === undefined) return false;
  var n = Number(value);
  if (isNaN(n)) return false;
  return n < range.min || n > range.max;
}

var BAND_LABELS = { good: "Normal", caution: "Caution", critical: "Critical" };

/* ── 4. Payload helpers (pure — unit tested) ───────────────── */

/** Blank → null. Never 0, because 0 is a real and dangerous reading. */
function toNumberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  var n = Number(value);
  return isNaN(n) ? null : n;
}

function toTextOrNull(value) {
  if (value === null || value === undefined) return null;
  var s = String(value).trim();
  return s === "" ? null : s;
}

/**
 * Build the exact POST /requests body from a plain form object.
 * Hard rules (enforced by tests):
 *  - blank vital  → null, never 0, never omitted
 *  - stroke_assessment present ONLY when category === "STROKE"
 *  - "priority" NEVER appears — the backend computes it
 *  - "destination_hospital_ids" NEVER appears — the backend resolves
 *    hospitals from origin + broadcast_radius_km
 *  - origin.source records how the position was obtained, so a typed-in
 *    location is never mistaken for a measured one
 */
function buildPayload(form) {
  var f = form || {};

  var payload = {
    case_type_id: toNumberOrNull(f.caseTypeId),
    age: toNumberOrNull(f.age),
    gender: f.gender || "U",
    blood_group: toTextOrNull(f.bloodGroup),
    vitals: {
      systolic_bp:  toNumberOrNull(f.systolicBp),
      diastolic_bp: toNumberOrNull(f.diastolicBp),
      heart_rate:   toNumberOrNull(f.heartRate),
      resp_rate:    toNumberOrNull(f.respRate),
      spo2:         toNumberOrNull(f.spo2),
      glucose:      toNumberOrNull(f.glucose)
    },
    consciousness: toTextOrNull(f.consciousness),
    origin: {
      lat: toNumberOrNull(f.lat),
      lng: toNumberOrNull(f.lng),
      accuracy_m: toNumberOrNull(f.accuracy),
      /* "gps" | "last-known" | "manual" | null.
         The ER reads a distance differently when the position was typed in
         rather than measured, so the provenance travels with it. */
      source: toTextOrNull(f.originSource)
    },
    broadcast_radius_km: toNumberOrNull(f.radiusKm) === null ? DEFAULT_RADIUS_KM : toNumberOrNull(f.radiusKm),
    images: [],
    eta_minutes: toNumberOrNull(f.eta),
    notes: toTextOrNull(f.notes),
    ambulance_id: toTextOrNull(f.ambulanceId)
  };

  if (Object.prototype.toString.call(f.images) === "[object Array]") {
    payload.images = f.images.slice(0, MAX_IMAGES);
  }

  if (f.category === "STROKE") {
    payload.stroke_assessment = {
      face:   !!f.face,
      arm:    !!f.arm,
      speech: !!f.speech,
      onset_hours: toNumberOrNull(f.onsetHours)
    };
  }

  return payload;
}

/* ── 5. Runtime state ──────────────────────────────────────── */

var caseTypes = [];
var locationState = { status: "idle", lat: null, lng: null, accuracy: null, source: null, message: "Locating device…" };
var attachedImages = [];
var selected = { gender: "U", bloodGroup: null, consciousness: null, radiusKm: DEFAULT_RADIUS_KM };
var fastState = { face: false, arm: false, speech: false };
var submitting = false;
var pollTimer = null;
var demoPollCount = 0;
var lastPayload = null;
var currentRequestId = null;
var socket = null;
var socketLive = false;
/* Phase 2 state — populated when status flips to ACCEPTED. */
var activeCase = null;          /* { id, status, patient, notes, accepted_by, accepted_at, arrived_at, last_patient_updated_at } */
var editPanelOpen = false;
var arrivalReported = false;

/* ── 6. Tiny DOM helpers ───────────────────────────────────── */

function $(id) { return document.getElementById(id); }
function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
function show(el) { if (el) el.hidden = false; }
function hide(el) { if (el) el.hidden = true; }
function setText(el, t) { if (el) el.textContent = t; }

var toastTimer = null;
function toast(message) {
  var el = $("toast");
  if (!el) return;
  setText(el, message);
  show(el);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { hide(el); }, 2600);
}

/* Safe storage — localStorage is unavailable or throws in some WebViews. */
function storeGet(key) {
  try { return window.localStorage.getItem(key); } catch (e) { return null; }
}
function storeSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
}

/* ── 7. Environment detection ──────────────────────────────── */

function isNative() {
  return !!(typeof window !== "undefined" && window.Capacitor &&
            typeof window.Capacitor.isNativePlatform === "function" &&
            window.Capacitor.isNativePlatform());
}
function plugin(name) {
  return (typeof window !== "undefined" && window.Capacitor && window.Capacitor.Plugins)
    ? window.Capacitor.Plugins[name] : null;
}

/* ── 8. Geolocation ────────────────────────────────────────── */
/* Three ways to get a starting point, in order of trust:
     gps         the device measured it
     last-known  the device measured it earlier, this shift
     manual      a human typed it, or tapped the configured shortcut

   The third exists because of a specific trap: Chrome only grants
   geolocation on secure origins, and http://192.168.x.x is not one.
   Open this app from a laptop's LAN address in a phone browser and the
   GPS is refused — so without a way through, the crew would sit looking
   at a form that will not send. In an ambulance that is the worse
   failure, which is exactly what the API contract says about vitals. */

var LAST_FIX_KEY = "gh_last_fix";
var LAST_FIX_MAX_AGE_MS = 6 * 60 * 60 * 1000;   /* a shift, not a week */

function saveLastFix(lat, lng, accuracy) {
  try {
    storeSet(LAST_FIX_KEY, JSON.stringify({
      lat: lat, lng: lng, accuracy: accuracy === undefined ? null : accuracy, ts: Date.now()
    }));
  } catch (e) { /* ignore */ }
}

function readLastFix() {
  var raw = storeGet(LAST_FIX_KEY);
  if (!raw) return null;
  try {
    var fix = JSON.parse(raw);
    if (typeof fix.lat !== "number" || typeof fix.lng !== "number") return null;
    if (!fix.ts || (Date.now() - fix.ts) > LAST_FIX_MAX_AGE_MS) return null;
    return fix;
  } catch (e) { return null; }
}

function describeAge(ts) {
  var mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  return Math.round(mins / 60) + " h ago";
}

function renderLocation() {
  var box = $("locBox");
  var text = $("locationStatus");
  var retry = $("locRetryBtn");
  if (!box || !text) return;

  box.className = "locbox loc-" + locationState.status;
  setText(text, locationState.message);
  if (locationState.status === "error" || locationState.status === "manual") { show(retry); } else { hide(retry); }

  renderLocationFallback();
  updateSubmitHint();
}

/* The shortcut row is rebuilt each time, because "last fix" ages. */
function renderLocationFallback() {
  var panel = $("locFallback");
  var row = $("locFallbackChips");
  if (!panel || !row) return;

  var needed = locationState.status === "error" || locationState.status === "manual";
  if (!needed) { hide(panel); return; }

  row.innerHTML = "";

  var fix = readLastFix();
  if (fix) {
    addFallbackChip(row, "Last fix · " + describeAge(fix.ts), function () {
      applyOrigin(fix.lat, fix.lng, fix.accuracy, "last-known",
        "Last known position · " + describeAge(fix.ts));
    });
  }

  var preset = CFG.FALLBACK_ORIGIN;
  if (preset && typeof preset.lat === "number" && typeof preset.lng === "number") {
    addFallbackChip(row, preset.label || "Preset location", function () {
      applyOrigin(preset.lat, preset.lng, null, "manual",
        "Set by hand · " + (preset.label || "preset"));
    });
  }

  show(panel);
}

function addFallbackChip(row, label, onPick) {
  var b = document.createElement("button");
  b.type = "button";
  b.className = "chip chip-xs";
  b.textContent = label;
  b.addEventListener("click", onPick);
  row.appendChild(b);
}

/** The one place locationState is set to a usable position. */
function applyOrigin(lat, lng, accuracy, source, message) {
  locationState = {
    status: source === "gps" ? "ready" : "manual",
    lat: lat, lng: lng,
    accuracy: accuracy === undefined ? null : accuracy,
    source: source,
    message: message
  };
  if (source === "gps") saveLastFix(lat, lng, accuracy);
  renderLocation();
  return locationState;
}

function useTypedCoordinates() {
  var latEl = $("manualLat"), lngEl = $("manualLng");
  if (!latEl || !lngEl) return false;

  var lat = toNumberOrNull(latEl.value);
  var lng = toNumberOrNull(lngEl.value);

  if (lat === null || lng === null) { toast("Enter both a latitude and a longitude"); return false; }
  if (lat < -90 || lat > 90)   { toast("Latitude must be between −90 and 90");   return false; }
  if (lng < -180 || lng > 180) { toast("Longitude must be between −180 and 180"); return false; }

  applyOrigin(lat, lng, null, "manual",
    "Set by hand · " + lat.toFixed(4) + ", " + lng.toFixed(4));
  toast("Starting point set");
  return true;
}

/** True when we have coordinates good enough to broadcast with. */
function hasUsableLocation() {
  return (locationState.status === "ready" || locationState.status === "manual") &&
         typeof locationState.lat === "number" && typeof locationState.lng === "number";
}

function readPosition() {
  var geo = plugin("Geolocation");
  if (isNative() && geo && typeof geo.getCurrentPosition === "function") {
    return geo.getCurrentPosition({ enableHighAccuracy: true, timeout: 12000 });
  }
  return new Promise(function (resolve, reject) {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("This device has no GPS available to the app."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true, timeout: 12000, maximumAge: 30000
    });
  });
}

/** Turn a browser GeolocationPositionError into something a paramedic can act on. */
function explainLocationError(err) {
  var message = (err && err.message) ? String(err.message) : "";
  var code = err && err.code;

  if (/secure origin|secure context/i.test(message)) {
    return "GPS is blocked because this page was opened over plain http. " +
           "Use the app build, or set a starting point below.";
  }
  if (code === 1) return "Location permission was refused. Allow it, or set a starting point below.";
  if (code === 2) return "The device could not get a fix. Set a starting point below.";
  if (code === 3) return "GPS timed out. Retry, or set a starting point below.";
  return message ? ("No location: " + message) : "Location unavailable. Retry, or set one below.";
}

function requestLocation() {
  if (DEMO) {
    return Promise.resolve(applyOrigin(12.9716, 77.5946, 20, "gps", "Demo location · Bengaluru"));
  }

  locationState = { status: "locating", lat: null, lng: null, accuracy: null, source: null, message: "Locating device…" };
  renderLocation();

  return readPosition().then(function (pos) {
    var c = pos && pos.coords ? pos.coords : {};
    var accuracy = c.accuracy === undefined ? null : Math.round(c.accuracy);
    return applyOrigin(c.latitude, c.longitude, accuracy, "gps",
      "Location locked" + (accuracy ? " · accurate to ±" + accuracy + " m" : ""));
  }).catch(function (err) {
    locationState = {
      status: "error", lat: null, lng: null, accuracy: null, source: null,
      message: explainLocationError(err)
    };
    renderLocation();
    return locationState;
  });
}

/* ── 9. Photos ─────────────────────────────────────────────── */

function canvasAvailable() {
  try {
    var c = document.createElement("canvas");
    return !!(c.getContext && c.getContext("2d"));
  } catch (e) { return false; }
}

/** Shrink to maxPx on the long edge and re-encode as JPEG. */
function compressImage(dataUrl, maxPx) {
  if (!dataUrl) return Promise.resolve(null);
  if (!canvasAvailable()) return Promise.resolve(dataUrl);

  return new Promise(function (resolve) {
    var img = new Image();
    var done = false;
    var bail = setTimeout(function () { if (!done) { done = true; resolve(dataUrl); } }, 6000);

    img.onload = function () {
      if (done) return;
      done = true; clearTimeout(bail);
      try {
        var w = img.width, h = img.height;
        var scale = Math.min(1, maxPx / Math.max(w, h));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", IMAGE_QUALITY));
      } catch (e) { resolve(dataUrl); }
    };
    img.onerror = function () { if (!done) { done = true; clearTimeout(bail); resolve(dataUrl); } };
    img.src = dataUrl;
  });
}

function renderPhotoGrid() {
  var grid = $("photoGrid");
  var addBtn = $("addPhotoBtn");
  if (!grid || !addBtn) return;

  var tiles = grid.querySelectorAll(".photo-tile");
  for (var i = 0; i < tiles.length; i++) grid.removeChild(tiles[i]);

  for (var j = 0; j < attachedImages.length; j++) {
    (function (index) {
      var tile = document.createElement("div");
      tile.className = "photo-tile";

      var img = document.createElement("img");
      img.src = attachedImages[index];
      img.alt = "Attached photo " + (index + 1);
      tile.appendChild(img);

      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "photo-remove";
      rm.setAttribute("aria-label", "Remove photo " + (index + 1));
      rm.textContent = "×";
      rm.addEventListener("click", function () {
        attachedImages.splice(index, 1);
        renderPhotoGrid();
      });
      tile.appendChild(rm);

      grid.insertBefore(tile, addBtn);
    })(j);
  }

  setText($("photoCount"), attachedImages.length + " / " + MAX_IMAGES);
  if (attachedImages.length >= MAX_IMAGES) { hide(addBtn); } else { show(addBtn); }
}

function addImage(dataUrl) {
  if (!dataUrl) return Promise.resolve(false);
  if (attachedImages.length >= MAX_IMAGES) {
    toast("Maximum " + MAX_IMAGES + " photos");
    return Promise.resolve(false);
  }
  return compressImage(dataUrl, MAX_IMAGE_PX).then(function (small) {
    if (attachedImages.length >= MAX_IMAGES) return false;
    attachedImages.push(small);
    renderPhotoGrid();
    return true;
  });
}

function addPhotoFromFile(file) {
  if (!file) return Promise.resolve(false);
  return new Promise(function (resolve) {
    var reader = new FileReader();
    reader.onload = function () { addImage(String(reader.result)).then(resolve); };
    reader.onerror = function () { toast("Couldn't read that image"); resolve(false); };
    reader.readAsDataURL(file);
  });
}

function capturePhotos() {
  if (attachedImages.length >= MAX_IMAGES) { toast("Maximum " + MAX_IMAGES + " photos"); return; }

  var cam = plugin("Camera");
  if (isNative() && cam && typeof cam.getPhoto === "function") {
    cam.getPhoto({
      quality: 70,
      width: MAX_IMAGE_PX,
      allowEditing: false,
      resultType: "dataUrl",
      source: "PROMPT",
      promptLabelHeader: "Add photo",
      promptLabelPhoto: "Choose from gallery",
      promptLabelPicture: "Take a photo",
      saveToGallery: false
    }).then(function (photo) {
      var url = photo && (photo.dataUrl || photo.webPath);
      if (url) addImage(url);
    }).catch(function () { /* user cancelled — silent */ });
    return;
  }

  var input = $("photoInput");
  if (input) input.click();
}

/* ── 10. Case types ────────────────────────────────────────── */

function findCaseType(id) {
  var n = Number(id);
  for (var i = 0; i < caseTypes.length; i++) if (Number(caseTypes[i].id) === n) return caseTypes[i];
  return null;
}

function selectedCaseCategory() {
  var sel = $("caseType");
  if (!sel || !sel.value) return null;
  var ct = findCaseType(sel.value);
  return ct ? ct.category : null;
}

function populateCaseTypes(list) {
  caseTypes = Array.isArray(list) ? list : [];
  var sel = $("caseType");
  if (!sel) return;

  sel.innerHTML = "";
  var placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a case type…";
  sel.appendChild(placeholder);

  var seen = {};
  var order = [];
  for (var i = 0; i < caseTypes.length; i++) {
    var cat = caseTypes[i].category || "OTHER";
    if (!seen[cat]) { seen[cat] = []; order.push(cat); }
    seen[cat].push(caseTypes[i]);
  }
  order.sort(function (a, b) {
    var ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  for (var k = 0; k < order.length; k++) {
    var group = document.createElement("optgroup");
    group.label = CATEGORY_LABELS[order[k]] || order[k];
    var items = seen[order[k]];
    for (var m = 0; m < items.length; m++) {
      var opt = document.createElement("option");
      opt.value = String(items[m].id);
      opt.textContent = items[m].label;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }

  renderQuickCases();
  updateStrokeSection();
  updateSubmitHint();
}

function renderQuickCases() {
  var row = $("quickCase");
  if (!row) return;
  row.innerHTML = "";

  var quick = caseTypes.filter(function (c) { return c.quick === true; });
  if (quick.length === 0) quick = caseTypes.slice(0, 6);

  quick.slice(0, 6).forEach(function (ct) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.setAttribute("data-case-id", String(ct.id));
    b.textContent = ct.short || ct.label;
    b.addEventListener("click", function () {
      var sel = $("caseType");
      if (!sel) return;
      sel.value = String(ct.id);
      syncQuickCases();
      updateStrokeSection();
      updateSubmitHint();
    });
    row.appendChild(b);
  });
  syncQuickCases();
}

function syncQuickCases() {
  var sel = $("caseType");
  var row = $("quickCase");
  if (!row) return;
  var current = sel ? sel.value : "";
  var chips = row.querySelectorAll("[data-case-id]");
  for (var i = 0; i < chips.length; i++) {
    var on = chips[i].getAttribute("data-case-id") === current && current !== "";
    chips[i].className = on ? "chip is-on" : "chip";
  }
}

function showListError(visible) {
  var banner = $("loadError");
  if (!banner) return;
  if (visible) { show(banner); } else { hide(banner); }
}

function fetchJson(url, options) {
  var opts = options || {};

  /* Never throw synchronously. Every caller treats this as a promise, and a
     WebView without fetch would otherwise take down init() on the way past. */
  if (typeof fetch !== "function") {
    return Promise.reject(new Error("This device has no network stack available to the app."));
  }

  if (typeof AbortController === "function") {
    var ctrl = new AbortController();
    opts.signal = ctrl.signal;
    var bail = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    return fetch(url, opts).then(function (res) {
      clearTimeout(bail);
      if (!res.ok) throw new Error("Server responded " + res.status);
      return res.json();
    }, function (err) { clearTimeout(bail); throw err; });
  }

  return fetch(url, opts).then(function (res) {
    if (!res.ok) throw new Error("Server responded " + res.status);
    return res.json();
  });
}

function loadLists() {
  showListError(false);
  if (DEMO) { populateCaseTypes(DEMO_CASE_TYPES); return Promise.resolve(DEMO_CASE_TYPES); }

  return fetchJson(API_BASE + "/case-types")
    .then(function (data) { populateCaseTypes(data); return data; })
    .catch(function () { populateCaseTypes(DEMO_CASE_TYPES); showListError(true); return null; });
}

/* ── 11. Live vital colours ────────────────────────────────── */

function applyVitalColour(inputId, chipId, bandKey) {
  var input = $(inputId), chip = $(chipId);
  if (!input || !chip) return;

  var raw = input.value;
  input.className = input.className.replace(/\s*in-(good|caution|critical|range)/g, "");

  if (raw === "" || raw === null) { hide(chip); chip.className = "chip-state"; return; }

  if (isOutOfRange(bandKey, raw)) {
    chip.className = "chip-state state-range";
    setText(chip, "Check value");
    show(chip);
    input.className += " in-range";
    return;
  }

  var band = getBandFor(bandKey, raw);
  if (!band) { hide(chip); chip.className = "chip-state"; return; }

  chip.className = "chip-state state-" + band;
  setText(chip, BAND_LABELS[band]);
  show(chip);
  input.className += " in-" + band;
}

function refreshVitals() {
  applyVitalColour("systolicBp",  "sysChip",  "systolicBp");
  applyVitalColour("diastolicBp", "diaChip",  "diastolicBp");
  applyVitalColour("heartRate",   "hrChip",   "heartRate");
  applyVitalColour("respRate",    "rrChip",   "respRate");
  applyVitalColour("spo2",        "spo2Chip", "spo2");
  applyVitalColour("glucose",     "glcChip",  "glucose");
}

function wireVitals() {
  ["systolicBp","diastolicBp","heartRate","respRate","spo2","glucose"].forEach(function (id) {
    var el = $(id);
    on(el, "input", refreshVitals);
    on(el, "change", refreshVitals);
  });
}

/* ── 12. Option controls ───────────────────────────────────── */

function wireSegmented(containerId, onPick) {
  var box = $(containerId);
  if (!box) return;
  var buttons = box.querySelectorAll(".seg-btn");
  for (var i = 0; i < buttons.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        for (var j = 0; j < buttons.length; j++) {
          buttons[j].className = "seg-btn";
          buttons[j].setAttribute("aria-checked", "false");
        }
        btn.className = "seg-btn is-on";
        btn.setAttribute("aria-checked", "true");
        onPick(btn.getAttribute("data-value"));
      });
    })(buttons[i]);
  }
}

function wireBloodChips() {
  var box = $("bloodChips");
  if (!box) return;
  var chips = box.querySelectorAll("[data-blood]");
  for (var i = 0; i < chips.length; i++) {
    (function (chip) {
      chip.addEventListener("click", function () {
        var value = chip.getAttribute("data-blood");
        var turningOff = selected.bloodGroup === value;
        for (var j = 0; j < chips.length; j++) chips[j].className = "chip";
        if (turningOff) { selected.bloodGroup = null; return; }
        chip.className = "chip is-on";
        selected.bloodGroup = value;
      });
    })(chips[i]);
  }
}

function wireConsciousness() {
  var box = $("consciousnessGroup");
  if (!box) return;
  var buttons = box.querySelectorAll(".level");
  for (var i = 0; i < buttons.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        for (var j = 0; j < buttons.length; j++) {
          buttons[j].className = "level";
          buttons[j].setAttribute("aria-checked", "false");
        }
        btn.className = "level is-on";
        btn.setAttribute("aria-checked", "true");
        selected.consciousness = btn.getAttribute("data-value");
      });
    })(buttons[i]);
  }
}

function wireFastToggles() {
  var groups = document.querySelectorAll("[data-fast]");
  for (var i = 0; i < groups.length; i++) {
    (function (group) {
      var key = group.getAttribute("data-fast");
      var buttons = group.querySelectorAll(".seg-btn");
      for (var j = 0; j < buttons.length; j++) {
        (function (btn) {
          btn.addEventListener("click", function () {
            for (var k = 0; k < buttons.length; k++) {
              buttons[k].className = "seg-btn";
              buttons[k].setAttribute("aria-checked", "false");
            }
            btn.className = "seg-btn is-on";
            btn.setAttribute("aria-checked", "true");
            fastState[key] = btn.getAttribute("data-yn") === "yes";
          });
        })(buttons[j]);
      }
    })(groups[i]);
  }
}

/** Chip rows that just fill a number field (age, ETA, onset, radius). */
function wireValueChips(rowId, attr, targetId, afterPick) {
  var row = $(rowId);
  if (!row) return;
  var chips = row.querySelectorAll("[" + attr + "]");
  for (var i = 0; i < chips.length; i++) {
    (function (chip) {
      chip.addEventListener("click", function () {
        for (var j = 0; j < chips.length; j++) chips[j].className = chips[j].className.replace(" is-on", "");
        chip.className += " is-on";
        var value = chip.getAttribute(attr);
        var target = $(targetId);
        if (target) {
          target.value = value;
          if (typeof Event === "function") target.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (afterPick) afterPick(value);
      });
    })(chips[i]);
  }
}

function updateStrokeSection() {
  var section = $("strokeSection");
  if (!section) return;
  if (selectedCaseCategory() === "STROKE") { show(section); } else { hide(section); }
}

function updateRadius(value) {
  var n = Number(value);
  if (isNaN(n)) n = DEFAULT_RADIUS_KM;
  selected.radiusKm = n;
  setText($("radiusOut"), n + " km");
  var slider = $("radiusKm");
  if (slider) {
    var min = Number(slider.min || 2), max = Number(slider.max || 40);
    var pct = ((n - min) / (max - min)) * 100;
    if (slider.style && slider.style.setProperty) slider.style.setProperty("--fill", pct + "%");
  }
  var row = $("radiusChips");
  if (row) {
    var chips = row.querySelectorAll("[data-radius]");
    for (var i = 0; i < chips.length; i++) {
      chips[i].className = (Number(chips[i].getAttribute("data-radius")) === n) ? "chip chip-xs is-on" : "chip chip-xs";
    }
  }
  storeSet("gh_radius", String(n));
}

/* ── 13. Readiness hint ────────────────────────────────────── */

function updateSubmitHint() {
  var hint = $("submitHint");
  var btn = $("submitBtn");
  if (!hint) return;

  var sel = $("caseType");
  var hasCase = !!(sel && sel.value);
  var hasLocation = hasUsableLocation();

  if (submitting) { setText(hint, "Sending…"); hint.className = "submit-hint"; return; }

  if (!hasCase && !hasLocation) {
    /* Don't say "waiting for GPS" when the GPS already gave up — that reads
       as "be patient" when the crew actually has something to do. */
    setText(hint, locationState.status === "locating"
      ? "Pick a case type · waiting for GPS"
      : "Pick a case type · set a starting point");
    hint.className = "submit-hint is-bad";
  }
  else if (!hasCase)                 { setText(hint, "Pick a case type to broadcast");      hint.className = "submit-hint is-bad"; }
  else if (locationState.status === "locating") { setText(hint, "Waiting for GPS…");        hint.className = "submit-hint"; }
  else if (!hasLocation)             { setText(hint, "Set a starting point above");         hint.className = "submit-hint is-bad"; }
  else if (locationState.source !== "gps") {
    setText(hint, "Ready · " + selected.radiusKm + " km radius · location set by hand");
    hint.className = "submit-hint is-ok";
  }
  else                               { setText(hint, "Ready · " + selected.radiusKm + " km radius"); hint.className = "submit-hint is-ok"; }

  if (btn) btn.disabled = false;
}

function updateNetPill() {
  var pill = $("netPill");
  if (!pill) return;
  var online = (typeof navigator === "undefined") ? true : navigator.onLine !== false;
  if (DEMO) { pill.className = "pill pill-warn"; setText(pill, "Demo"); return; }
  if (!online) { pill.className = "pill pill-bad"; setText(pill, "Offline"); return; }
  pill.className = "pill pill-ok";
  setText(pill, socketLive ? "Live" : "Online");
}

/* ── 14. Gather + submit ───────────────────────────────────── */

function gatherForm() {
  var sel = $("caseType");
  var category = selectedCaseCategory();
  return {
    caseTypeId: sel ? sel.value : "",
    category: category,
    age: $("age") ? $("age").value : "",
    gender: selected.gender,
    bloodGroup: selected.bloodGroup,
    systolicBp:  $("systolicBp")  ? $("systolicBp").value  : "",
    diastolicBp: $("diastolicBp") ? $("diastolicBp").value : "",
    heartRate:   $("heartRate")   ? $("heartRate").value   : "",
    respRate:    $("respRate")    ? $("respRate").value    : "",
    spo2:        $("spo2")        ? $("spo2").value        : "",
    glucose:     $("glucose")     ? $("glucose").value     : "",
    consciousness: selected.consciousness,
    lat: locationState.lat,
    lng: locationState.lng,
    accuracy: locationState.accuracy,
    originSource: locationState.source,
    radiusKm: selected.radiusKm,
    images: attachedImages.slice(),
    eta: $("eta") ? $("eta").value : "",
    notes: $("notes") ? $("notes").value : "",
    ambulanceId: $("ambulanceId") ? $("ambulanceId").value : "",
    face: fastState.face,
    arm: fastState.arm,
    speech: fastState.speech,
    onsetHours: $("onsetHours") ? $("onsetHours").value : ""
  };
}

/* Phase 2 — collect the edit form data. Same field names as gatherForm() so
   schedule/validate can reuse the buildPayload pipeline. Returns null when
   any required field is missing or clearly out-of-range. */
function collectEditForm() {
  var ageRaw = $("editAge") ? $("editAge").value : "";
  var age = ageRaw === "" ? null : Number(ageRaw);
  if (age !== null && (isNaN(age) || age < 0 || age > 120)) {
    toast("Age must be between 0 and 120");
    return null;
  }
  function readNum(id, min, max, label) {
    var el = $(id); if (!el) return null;
    var v = el.value;
    if (v === "") return null;
    var n = Number(v);
    if (isNaN(n) || n < min || n > max) {
      toast(label + " looks wrong — please check the value");
      return undefined;
    }
    return n;
  }
  var sys  = readNum("editSys",  40, 300, "Systolic BP");
  var dia  = readNum("editDia",  20, 200, "Diastolic BP");
  var hr   = readNum("editHr",   20, 300, "Heart rate");
  var rr   = readNum("editRr",   4,  80,  "Resp rate");
  var o2   = readNum("editSpo2", 50, 100, "SpO2");
  var glc  = readNum("editGlc",  10, 900, "Glucose");
  if (sys === undefined || dia === undefined || hr === undefined ||
      rr === undefined || o2  === undefined || glc === undefined) return null;

  var bloodGroup = $("editBlood") ? ($("editBlood").value || null) : null;
  var consEl = document.querySelector("#editConsciousness .level.is-on");
  var consciousness = consEl ? consEl.getAttribute("data-value") : null;
  var notes = $("editNotes") ? $("editNotes").value.trim() : "";
  if (notes.length > 160) notes = notes.slice(0, 160);

  return {
    patient: {
      age: age,
      gender: $("editGender") ? $("editGender").value || "U" : "U",
      blood_group: bloodGroup,
      consciousness: consciousness || null,
      vitals: {
        systolic_bp:  sys,
        diastolic_bp: dia,
        heart_rate:   hr,
        resp_rate:    rr,
        spo2:         o2,
        glucose:      glc
      }
    },
    notes: notes || null
  };
}

function setBusy(busy) {
  submitting = busy;
  var btn = $("submitBtn");
  if (!btn) return;
  btn.disabled = busy;
  btn.className = busy ? "btn-primary is-busy" : "btn-primary";
  var label = btn.querySelector(".btn-label");
  if (label) label.textContent = busy ? "Broadcasting…" : "Broadcast Request";
}

function postRequest(payload) {
  if (DEMO) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (typeof window !== "undefined" && window.__GH_DEMO_FAIL) {
          reject(new Error("Simulated network failure (demo)"));
        } else {
          resolve({ id: "demo-1", hospitals_notified: 3, status: "PENDING" });
        }
      }, DEMO_POST_MS);
    });
  }
  return fetchJson(API_BASE + "/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

function submitLoop() {
  if (submitting) return Promise.resolve(null);

  var sel = $("caseType");
  if (!sel || !sel.value) {
    toast("Pick a case type first");
    var card = $("caseCard");
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "center" });
    return Promise.resolve(null);
  }
  if (!hasUsableLocation()) {
    if (locationState.status === "locating") {
      toast("Waiting for GPS — one moment");
    } else {
      toast("Set a starting point — the broadcast needs a location");
      var panel = $("locFallback");
      if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return Promise.resolve(null);
  }

  lastPayload = buildPayload(gatherForm());
  if (typeof window !== "undefined") window.__GH_LAST_PAYLOAD = lastPayload;

  setBusy(true);
  updateSubmitHint();

  return postRequest(lastPayload).then(function (res) {
    setBusy(false);
    showBroadcast(res || {});
    return res;
  }).catch(function (err) {
    setBusy(false);
    updateSubmitHint();
    showError(err && err.message ? err.message : "Network error.");
    return null;
  });
}

/* ── 14b. Realtime channel ─────────────────────────────────── */
/* Polling alone works, and always did. This just closes the gap
   between "a hospital pressed Accept" and "the crew sees it" from
   up to POLL_MS down to the width of the room's Wi-Fi. If the
   socket never connects, nothing breaks — the poll carries on. */

function realtimeUsable() {
  return REALTIME && !DEMO &&
         typeof window !== "undefined" && typeof window.io === "function" &&
         SERVER_BASE !== "";
}

function ensureSocket() {
  if (!realtimeUsable()) return null;
  if (socket) return socket;

  try {
    socket = window.io(SERVER_BASE, {
      query: { role: "ambulance" },
      transports: ["websocket", "polling"],
      reconnectionDelay: 800,
      timeout: 8000
    });
  } catch (e) {
    socket = null;
    return null;
  }

  socket.on("connect", function () {
    socketLive = true;
    updateNetPill();
    if (currentRequestId) socket.emit("case:follow", currentRequestId);
  });

  socket.on("disconnect", function () { socketLive = false; updateNetPill(); });
  socket.on("connect_error", function () { socketLive = false; updateNetPill(); });

  /* The server pushes the whole status object, the same shape the
     poll returns — so one renderer handles both paths. */
  socket.on("case:status", function (data) {
    if (!data || String(data.id) !== String(currentRequestId)) return;
    applyServerStatus(data);
  });

  return socket;
}

function followCase(caseCode) {
  var s = ensureSocket();
  if (s && s.connected) s.emit("case:follow", caseCode);
}

function unfollowCase(caseCode) {
  if (socket && socket.connected && caseCode) socket.emit("case:unfollow", caseCode);
}

/* ── 15. Broadcast overlay + live acceptance ───────────────── */

function showBroadcast(res) {
  currentRequestId = res.id === undefined ? null : res.id;
  demoPollCount = 0;
  activeCase = null;
  arrivalReported = false;
  if (currentRequestId !== null) followCase(currentRequestId);

  var n = res.hospitals_notified;
  setText($("broadcastInfo"),
    (n === undefined || n === null)
      ? "Alert sent to nearby hospitals"
      : ("Sent to " + n + " nearby hospital" + (n === 1 ? "" : "s") + " within " + selected.radiusKm + " km"));

  hide($("acceptedBox"));
  hide($("callBtn"));
  hide($("navBtn"));
  hide($("activeCaseBox"));
  if ($("arrivedBanner")) hide($("arrivedBanner"));
  updateStatusChip({ status: res.status || "PENDING" });
  show($("successOverlay"));

  startPolling();
}

/* Centralised "what changed on this case" handler — called for both the
   initial poll and the realtime case:status push. */
function applyServerStatus(data) {
  updateStatusChip(data);
  var status = String((data && data.status) || "PENDING").toUpperCase();
  if (status === "ACCEPTED" || status === "ARRIVED") {
    activeCase = {
      id: data.id,
      status: status,
      patient: data.patient || (activeCase && activeCase.patient) || null,
      notes: data.notes || (activeCase && activeCase.notes) || null,
      accepted_by: data.accepted_by || (activeCase && activeCase.accepted_by) || null,
      accepted_hospital: data.accepted_hospital || null,
      accepted_at: (activeCase && activeCase.accepted_at) || new Date().toISOString(),
      arrived_at: data.arrived_at || null,
      last_patient_updated_at: data.last_patient_updated_at || null
    };
    renderActiveCase();
  }
  if (status === "ARRIVED" && !arrivalReported) {
    /* Server sometimes sees arrival before our own ambulance:arrived ack.
       If we never sent it but the record is ARRIVED, just reflect that. */
    arrivalReported = true;
  }
  if (status !== "PENDING") stopPolling();
}

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function startPolling() {
  stopPolling();
  if (currentRequestId === null || currentRequestId === undefined) return;
  pollTimer = setTimeout(pollStatus, POLL_MS);
}

function fetchStatus() {
  if (DEMO) {
    demoPollCount++;
    if (demoPollCount < 2) return Promise.resolve({ id: currentRequestId, status: "PENDING", hospitals_notified: 3 });
    return Promise.resolve({
      id: currentRequestId,
      status: "ACCEPTED",
      accepted_by: "Demo City ER",
      hospitals_notified: 3,
      accepted_hospital: { name: "Demo City ER", distance_km: 3.4, phone: "+911234567890", lat: 12.9899, lng: 77.5921 }
    });
  }
  return fetchJson(API_BASE + "/requests/" + encodeURIComponent(currentRequestId));
}

function pollStatus() {
  fetchStatus().then(function (data) {
    applyServerStatus(data || {});
    var status = String((data && data.status) || "PENDING").toUpperCase();
    if (status === "PENDING") { startPolling(); }
    else { stopPolling(); }
  }).catch(function () {
    /* A dropped poll is not fatal — keep trying. */
    startPolling();
  });
}

function updateStatusChip(data) {
  var chip = $("statusChip");
  var text = $("statusChipText");
  var note = $("sheetNote");
  if (!chip || !text) return;

  var status = String(data.status || "PENDING").toUpperCase();
  var hospital = data.accepted_hospital || null;
  var name = data.accepted_by || (hospital && hospital.name) || "a hospital";

  var title = $("successTitle");

  if (status === "ACCEPTED") {
    chip.className = "status-chip status-accepted";
    setText(text, "✓ Accepted by " + name);
    setText(note, "Head there now. The ER is preparing for this patient.");
    setText(title, "Hospital ready");

    setText($("acceptedName"), name);
    var bits = [];
    if (hospital && hospital.distance_km !== undefined && hospital.distance_km !== null) bits.push(hospital.distance_km + " km away");
    if (hospital && hospital.eta_min) bits.push("~" + hospital.eta_min + " min");
    if (data.hospitals_notified) bits.push("first of " + data.hospitals_notified + " to accept");
    setText($("acceptedMeta"), bits.join(" · "));

    var call = $("callBtn");
    if (call && hospital && hospital.phone) { call.href = "tel:" + hospital.phone; show(call); } else { hide(call); }

    var nav = $("navBtn");
    if (nav && hospital && hospital.lat !== undefined && hospital.lat !== null) {
      nav.href = "geo:" + hospital.lat + "," + hospital.lng + "?q=" + encodeURIComponent(name);
      show(nav);
    } else { hide(nav); }

    show($("acceptedBox"));

  } else if (status === "REJECTED" || status === "EXPIRED" || status === "CANCELLED") {
    chip.className = "status-chip status-failed";
    setText(text, "No hospital accepted");
    setText(note, "Call the nearest ER directly, or start a new request with a wider radius.");
    setText(title, "No hospital yet");
    hide($("acceptedBox"));

  } else {
    chip.className = "status-chip status-pending";
    setText(text, "Waiting for a hospital to accept…");
    setText(note, "Keep this screen open — it updates by itself.");
    setText(title, "Request broadcast");
    hide($("acceptedBox"));
  }
}

/* ── 15b. Active case + Edit Patient + Arrival  ───────────── */
/* Pull the latest patient fields out of activeCase into the Edit Patient
   panel. Missing values are blank, not "0" — same rule as the broadcast form. */
function prefillEditPanel() {
  var p = (activeCase && activeCase.patient) || {};
  var v = (p && p.vitals) || {};
  function setVal(id, value) { var el = $(id); if (el) el.value = (value === null || value === undefined) ? "" : String(value); }
  setVal("editAge", p.age);
  setVal("editBlood", p.blood_group);
  setVal("editSys", v.systolic_bp);
  setVal("editDia", v.diastolic_bp);
  setVal("editHr", v.heart_rate);
  setVal("editRr", v.resp_rate);
  setVal("editSpo2", v.spo2);
  setVal("editGlc", v.glucose);
  setVal("editNotes", activeCase && activeCase.notes);
  var gsel = $("editGender"); if (gsel) gsel.value = p.gender || "U";
  /* consciousness: pick the matching button is-on */
  var consBtns = document.querySelectorAll("#editConsciousness .level");
  for (var i = 0; i < consBtns.length; i++) {
    var on = consBtns[i].getAttribute("data-value") === (p.consciousness || "");
    consBtns[i].className = on ? "level is-on" : "level";
    consBtns[i].setAttribute("aria-checked", on ? "true" : "false");
  }
}

function openEditPanel() {
  if (!activeCase) return;
  if (String(activeCase.status || "").toUpperCase() !== "ACCEPTED") {
    toast("Patient details can only be edited while the case is active");
    return;
  }
  editPanelOpen = true;
  prefillEditPanel();
  var status = $("editStatus"); if (status) setText(status, "");
  show($("editOverlay"));
}

function closeEditPanel() {
  editPanelOpen = false;
  hide($("editOverlay"));
}

/* spec §3: emit patient:update, validate first, persist via server. */
function submitPatientUpdate() {
  if (!activeCase || !socket || !socket.connected) {
    toast("Connection unstable — please retry");
    return Promise.resolve(false);
  }
  var data = collectEditForm();
  if (!data) return Promise.resolve(false);
  var statusEl = $("editStatus");
  if (statusEl) setText(statusEl, "Saving…");
  return new Promise(function (resolve) {
    socket.emit("patient:update", {
      case_code: activeCase.id,
      patient: data.patient,
      notes: data.notes
    }, function (ack) {
      if (ack && ack.success) {
        activeCase.patient = data.patient;
        activeCase.notes = data.notes;
        activeCase.last_patient_updated_at = ack.updated_at || new Date().toISOString();
        renderActiveCase(true);
        renderPatientEcho();
        if (statusEl) setText(statusEl, "Patient details updated");
        toast("Patient details updated");
        setTimeout(closeEditPanel, 700);
        resolve(true);
      } else {
        var msg = (ack && (ack.message || ack.reason)) || "Update failed";
        if (statusEl) setText(statusEl, "Update failed — please retry");
        toast(msg);
        resolve(false);
      }
    });
  });
}

/* spec §12: emit ambulance:arrived once we reach the accepting hospital. */
function reportArrival() {
  if (!activeCase || !socket || !socket.connected) {
    toast("Connection unstable — please retry");
    return;
  }
  if (arrivalReported) return;
  arrivalReported = true;
  var hospitalId = (activeCase.accepted_hospital && activeCase.accepted_hospital.hospital_id) || null;
  socket.emit("ambulance:arrived", {
    case_code: activeCase.id,
    hospital_id: hospitalId
  }, function (ack) {
    if (ack && ack.success) {
      activeCase.status = "ARRIVED";
      activeCase.arrived_at = ack.arrived_at || new Date().toISOString();
      var banner = $("arrivedBanner");
      if (banner) { show(banner); setText(banner, "✓ Arrival reported — case closed at " + formatTime(activeCase.arrived_at)); }
      renderActiveCase();
      toast("Arrival reported");
    } else {
      arrivalReported = false;
      var msg = (ack && (ack.message || ack.reason)) || "Could not record arrival";
      toast(msg);
    }
  });
}

function formatTime(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  var hh = d.getHours(); var mm = d.getMinutes();
  return (hh < 10 ? "0" + hh : hh) + ":" + (mm < 10 ? "0" + mm : mm);
}

function relativeTime(iso) {
  if (!iso) return "";
  var then = new Date(iso).getTime(); if (isNaN(then)) return "";
  var secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return secs + "s ago";
  var mins = Math.floor(secs / 60);
  if (mins < 60) return mins + " min ago";
  var hrs = Math.floor(mins / 60);
  return hrs + " h ago";
}

/* Render the active-case card inside successOverlay. flash=true paints the
   small "Updated" ticker so the crew has visible confirmation of edit success. */
function renderActiveCase(flash) {
  if (!activeCase) { hide($("activeCaseBox")); return; }
  show($("activeCaseBox"));
  var p = activeCase.patient || {};
  var v = (p && p.vitals) || {};
  var name = "Patient";
  setText($("activeCaseCode"), activeCase.id);
  setText($("activeFacility"), activeCase.accepted_by || "—");
  setText($("activeStatusLabel"), String(activeCase.status || "").toUpperCase());
  setText($("activePatientName"), (p.age !== undefined && p.age !== null) ? ("Patient · age " + p.age) : "Patient");
  setText($("activeBlood"),      p.blood_group || "—");
  setText($("activeCondition"),  p.consciousness || "—");
  setText($("activeHr"),         v.heart_rate === null || v.heart_rate === undefined ? "—" : v.heart_rate + " bpm");
  setText($("activeBp"),         formatBp(v.systolic_bp, v.diastolic_bp));
  setText($("activeSpo2"),       v.spo2 === null || v.spo2 === undefined ? "—" : v.spo2 + "%");
  setText($("activeNotes"),      activeCase.notes || "No additional notes");
  if ($("activeAgeBand")) setText($("activeAgeBand"), p.age ? (p.age + " yrs") : "—");
  if ($("activeGenderLabel")) setText($("activeGenderLabel"), { M: "Male", F: "Female", O: "Other", U: "Unknown" }[p.gender || "U"] || "Unknown");

  var editBtn = $("editPatientBtn");
  if (editBtn) {
    var editable = String(activeCase.status || "").toUpperCase() === "ACCEPTED" && !arrivalReported;
    editBtn.disabled = !editable;
    editBtn.className = "btn-secondary" + (editable ? "" : " is-disabled");
    editBtn.title = editable ? "Edit patient details" : "Editing is disabled after arrival";
  }
  var arrivedBtn = $("arrivedBtn");
  if (arrivedBtn) {
    var canArrive = String(activeCase.status || "").toUpperCase() === "ACCEPTED" && !arrivalReported;
    arrivedBtn.disabled = !canArrive;
    arrivedBtn.className = arrivedBtn.className.replace(" is-disabled", "") + (canArrive ? "" : " is-disabled");
    arrivedBtn.textContent = arrivalReported ? "Arrived ✓" : "Reached hospital · ARRIVED";
  }

  var ticker = $("updateTicker");
  if (ticker) {
    var when = activeCase.last_patient_updated_at;
    setText(ticker, when ? ("Updated · " + relativeTime(when)) : "");
    ticker.className = flash ? "update-ticker is-fresh" : "update-ticker";
    if (flash) {
      setTimeout(function () { if (ticker) ticker.className = "update-ticker"; }, 1800);
    }
  }
}

function formatBp(s, d) {
  if (s === null || s === undefined) return "—";
  return s + "/" + (d === null || d === undefined ? "—" : d);
}

/* After a successful save, also echo the changed facts back onto the side
   sheet (the patient card inside the overlay) so the crew does not have to
   re-open the dialog to confirm the update. */
function renderPatientEcho() {
  if (!activeCase) return;
  var p = activeCase.patient || {};
  var v = (p && p.vitals) || {};
  setText($("acceptedName"), activeCase.accepted_by || "—");
  setText($("activePatientName"), p.age ? ("Patient · age " + p.age) : "Patient");
  setText($("activeBlood"), p.blood_group || "—");
  setText($("activeCondition"), p.consciousness || "—");
  setText($("activeHr"), v.heart_rate === null || v.heart_rate === undefined ? "—" : v.heart_rate + " bpm");
  setText($("activeBp"), formatBp(v.systolic_bp, v.diastolic_bp));
  setText($("activeSpo2"), v.spo2 === null || v.spo2 === undefined ? "—" : v.spo2 + "%");
}



function showError(message) {
  setText($("errorMessage"), message || "Network error.");
  show($("errorOverlay"));
}
function hideError() { hide($("errorOverlay")); }

function retrySubmit() {
  hideError();
  if (!lastPayload) { submitLoop(); return; }
  setBusy(true);
  postRequest(lastPayload).then(function (res) {
    setBusy(false);
    showBroadcast(res || {});
  }).catch(function (err) {
    setBusy(false);
    showError(err && err.message ? err.message : "Network error.");
  });
}

/* ── 17. Reset ─────────────────────────────────────────────── */

function resetForm() {
  stopPolling();
  unfollowCase(currentRequestId);
  currentRequestId = null;
  lastPayload = null;
  demoPollCount = 0;

  var sel = $("caseType");
  if (sel) sel.value = "";
  syncQuickCases();

  ["age","systolicBp","diastolicBp","heartRate","respRate","spo2","glucose","eta","onsetHours","notes"]
    .forEach(function (id) { var el = $(id); if (el) el.value = ""; });

  selected.bloodGroup = null;
  selected.consciousness = null;
  selected.gender = "U";
  fastState = { face: false, arm: false, speech: false };
  attachedImages = [];

  var bloodChips = document.querySelectorAll("[data-blood]");
  for (var i = 0; i < bloodChips.length; i++) bloodChips[i].className = "chip";

  var levels = document.querySelectorAll(".level");
  for (var j = 0; j < levels.length; j++) { levels[j].className = "level"; levels[j].setAttribute("aria-checked","false"); }

  var genderButtons = $("genderSeg") ? $("genderSeg").querySelectorAll(".seg-btn") : [];
  for (var k = 0; k < genderButtons.length; k++) {
    var isDefault = genderButtons[k].getAttribute("data-value") === "U";
    genderButtons[k].className = isDefault ? "seg-btn is-on" : "seg-btn";
    genderButtons[k].setAttribute("aria-checked", isDefault ? "true" : "false");
  }

  var fastGroups = document.querySelectorAll("[data-fast]");
  for (var m = 0; m < fastGroups.length; m++) {
    var yn = fastGroups[m].querySelectorAll(".seg-btn");
    for (var p = 0; p < yn.length; p++) {
      var isNo = yn[p].getAttribute("data-yn") === "no";
      yn[p].className = isNo ? "seg-btn is-on" : "seg-btn";
      yn[p].setAttribute("aria-checked", isNo ? "true" : "false");
    }
  }

  ["ageChips","etaChips","onsetChips"].forEach(function (rowId) {
    var row = $(rowId);
    if (!row) return;
    var chips = row.querySelectorAll(".chip");
    for (var q = 0; q < chips.length; q++) chips[q].className = "chip chip-xs";
  });

  setText($("notesCount"), "0 / 160");
  renderPhotoGrid();
  refreshVitals();
  updateStrokeSection();
  hide($("successOverlay"));
  hideError();
  setBusy(false);

  /* The ambulance has moved since the last case — get a fresh fix.
     If GPS is still refused, the fallback panel comes straight back with
     the same one-tap shortcuts, so the next case is not slower than this one. */
  requestLocation();
  updateSubmitHint();
}

/* ── 18. Init ──────────────────────────────────────────────── */

function init() {
  if (DEMO) {
    /* Say why, because "Demo mode" on its own is not actionable. */
    var banner = $("demoBanner");
    if (banner && inNativeShell()) {
      banner.innerHTML = "<strong>Demo mode</strong> \u00b7 this build has no server address \u2014 " +
                         "set SERVER_BASE in www/config.js and rebuild the APK";
    }
    show(banner);
  }
  updateNetPill();

  wireVitals();
  wireConsciousness();
  wireBloodChips();
  wireFastToggles();
  wireSegmented("genderSeg", function (value) { selected.gender = value || "U"; });

  wireValueChips("ageChips", "data-age", "age");
  wireValueChips("etaChips", "data-eta", "eta");
  wireValueChips("onsetChips", "data-onset", "onsetHours");

  var radiusRow = $("radiusChips");
  if (radiusRow) {
    var rChips = radiusRow.querySelectorAll("[data-radius]");
    for (var i = 0; i < rChips.length; i++) {
      (function (chip) {
        chip.addEventListener("click", function () {
          var v = Number(chip.getAttribute("data-radius"));
          var slider = $("radiusKm");
          if (slider) slider.value = String(v);
          updateRadius(v);
        });
      })(rChips[i]);
    }
  }

  var slider = $("radiusKm");
  on(slider, "input", function () { updateRadius(slider.value); });

  on($("caseType"), "change", function () {
    syncQuickCases();
    updateStrokeSection();
    updateSubmitHint();
  });

  on($("addPhotoBtn"), "click", capturePhotos);
  on($("photoInput"), "change", function (e) {
    var files = e.target.files ? Array.prototype.slice.call(e.target.files) : [];
    var chain = Promise.resolve();
    files.forEach(function (file) { chain = chain.then(function () { return addPhotoFromFile(file); }); });
    chain.then(function () { e.target.value = ""; });
  });

  on($("notes"), "input", function () {
    var el = $("notes");
    setText($("notesCount"), el.value.length + " / 160");
  });

  var unit = $("ambulanceId");
  if (unit) {
    var saved = storeGet("gh_unit");
    if (saved) unit.value = saved;
    on(unit, "change", function () { storeSet("gh_unit", unit.value.trim()); });
  }

  var savedRadius = Number(storeGet("gh_radius"));
  var startRadius = (savedRadius >= 2 && savedRadius <= 40) ? savedRadius : DEFAULT_RADIUS_KM;
  if (slider) slider.value = String(startRadius);
  updateRadius(startRadius);

  on($("submitBtn"), "click", submitLoop);
  on($("newRequestBtn"), "click", resetForm);
  on($("retryBtn"), "click", retrySubmit);
  on($("backBtn"), "click", hideError);
  on($("locRetryBtn"), "click", requestLocation);
  on($("useManualBtn"), "click", useTypedCoordinates);
  ["manualLat", "manualLng"].forEach(function (id) {
    on($(id), "keydown", function (e) { if (e.key === "Enter") useTypedCoordinates(); });
  });
  on($("retryListsBtn"), "click", loadLists);

  ["age","eta","onsetHours"].forEach(function (id) {
    on($(id), "input", function () {
      var rows = { age: "ageChips", eta: "etaChips", onsetHours: "onsetChips" };
      var row = $(rows[id]);
      if (!row) return;
      var chips = row.querySelectorAll(".chip");
      var value = $(id).value;
      for (var c = 0; c < chips.length; c++) {
        var attr = chips[c].getAttribute("data-age") || chips[c].getAttribute("data-eta") || chips[c].getAttribute("data-onset");
        chips[c].className = (attr === value) ? "chip chip-xs is-on" : "chip chip-xs";
      }
    });
  });

  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("online", updateNetPill);
    window.addEventListener("offline", updateNetPill);
  }

  renderPhotoGrid();
  refreshVitals();
  loadLists();
  requestLocation();
  ensureSocket();          /* opens early so the header can say "Live" */
  updateSubmitHint();
  wireEditPanel();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}

/* ── 15c. Edit panel wiring ─────────────────────────────────── */
function wireEditPanel() {
  var segs = document.querySelectorAll("#editConsciousness .level");
  for (var i = 0; i < segs.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        for (var j = 0; j < segs.length; j++) {
          segs[j].className = "level";
          segs[j].setAttribute("aria-checked", "false");
        }
        btn.className = "level is-on";
        btn.setAttribute("aria-checked", "true");
      });
    })(segs[i]);
  }
  var bloodChips = document.querySelectorAll("#editBloodRow .chip");
  for (var k = 0; k < bloodChips.length; k++) {
    (function (chip) {
      chip.addEventListener("click", function () {
        var value = chip.getAttribute("data-blood");
        var turningOff = ($("editBlood") && $("editBlood").value === value);
        for (var j = 0; j < bloodChips.length; j++) bloodChips[j].className = "chip";
        if (turningOff) { if ($("editBlood") && $("editBlood").value === value) $("editBlood").value = ""; return; }
        chip.className = "chip is-on";
        if ($("editBlood")) $("editBlood").value = chip.getAttribute("data-blood");
      });
    })(bloodChips[k]);
  }

  on($("editCancelBtn"), "click", closeEditPanel);
  on($("editSaveBtn"),   "click", function () { submitPatientUpdate(); });
  on($("editPatientBtn"),"click", function () { if (this.disabled) return; openEditPanel(); });
  on($("arrivedBtn"),    "click", function () { if (this.disabled) return; reportArrival(); });
}

/* ── 19. Exports ───────────────────────────────────────────── */

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    getBandFor: getBandFor,
    isOutOfRange: isOutOfRange,
    buildPayload: buildPayload,
    toNumberOrNull: toNumberOrNull,
    toTextOrNull: toTextOrNull,
    BANDS: BANDS,
    LEVELS: LEVELS,
    RANGES: RANGES,
    DEMO_CASE_TYPES: DEMO_CASE_TYPES,
    MAX_IMAGES: MAX_IMAGES
  };
}

if (typeof window !== "undefined") {
  window.__GH = {
    getBandFor: getBandFor,
    buildPayload: buildPayload,
    gatherForm: gatherForm,
    submitLoop: submitLoop,
    resetForm: resetForm,
    requestLocation: requestLocation,
    applyOrigin: applyOrigin,
    useTypedCoordinates: useTypedCoordinates,
    hasUsableLocation: hasUsableLocation,
    addImage: addImage,
    updateRadius: updateRadius,
    updateStatusChip: updateStatusChip,
    pollStatus: pollStatus,
    showBroadcast: showBroadcast,
    stopPolling: stopPolling,
    submitPatientUpdate: submitPatientUpdate,
    openEditPanel: openEditPanel,
    closeEditPanel: closeEditPanel,
    collectEditForm: collectEditForm,
    reportArrival: reportArrival,
    renderActiveCase: renderActiveCase,
    applyServerStatus: applyServerStatus,
    state: function () {
      return {
        selected: selected, fastState: fastState, images: attachedImages,
        location: locationState, caseTypes: caseTypes, demo: DEMO,
        requestId: currentRequestId, lastPayload: lastPayload,
        activeCase: activeCase, arrivalReported: arrivalReported
      };
    }
  };
}
