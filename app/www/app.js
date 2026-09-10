(function() {
  "use strict";
  const MAX_IMAGES = 4;
  function toNumberOrNull(value) {
    if (value === null || value === void 0) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function toTextOrNull(value) {
    if (value === null || value === void 0) return null;
    const s = String(value).trim();
    return s === "" ? null : s;
  }
  const VITALS = {
    systolicBp: { range: [40, 300], bands: [[90, "critical"], [100, "caution"], [140, "good"], [180, "caution"], [Infinity, "critical"]] },
    diastolicBp: { range: [20, 200], bands: [[50, "critical"], [60, "caution"], [90, "good"], [120, "caution"], [Infinity, "critical"]] },
    heartRate: { range: [20, 300], bands: [[50, "critical"], [60, "caution"], [101, "good"], [121, "caution"], [Infinity, "critical"]] },
    respRate: { range: [4, 80], bands: [[9, "critical"], [12, "caution"], [21, "good"], [30, "caution"], [Infinity, "critical"]] },
    spo2: { range: [50, 100], bands: [[90, "critical"], [95, "caution"], [Infinity, "good"]] },
    glucose: { range: [10, 900], bands: [[60, "critical"], [70, "caution"], [141, "good"], [250, "caution"], [Infinity, "critical"]] }
  };
  const VITAL_KEYS = Object.keys(VITALS);
  function getBandFor(key, value) {
    const spec = VITALS[key];
    if (!spec) return null;
    const n = toNumberOrNull(value);
    if (n === null) return null;
    if (n < spec.range[0] || n > spec.range[1]) return null;
    for (const [ceiling, band] of spec.bands) if (n < ceiling) return band;
    return null;
  }
  function isOutOfRange(key, value) {
    const spec = VITALS[key];
    if (!spec) return false;
    const n = toNumberOrNull(value);
    if (n === null) return false;
    return n < spec.range[0] || n > spec.range[1];
  }
  function deriveNeeds(form) {
    const f = form || {};
    const v = f.vitals || {};
    const needs = { ventilator: false, blood: false, imaging: false, ot: false, cathlab: false };
    const spo2 = toNumberOrNull(v.spo2);
    const sbp = toNumberOrNull(v.systolic_bp);
    if (f.consciousness === "Unconscious") needs.ventilator = true;
    if (spo2 !== null && spo2 < 90) needs.ventilator = true;
    if (sbp !== null && sbp < 90) needs.blood = true;
    switch (f.category) {
      case "TRAUMA":
      case "OBSTETRIC":
        needs.blood = true;
        needs.imaging = true;
        needs.ot = true;
        break;
      case "STROKE":
      case "NEURO":
        needs.imaging = true;
        break;
      case "CARDIAC":
        needs.imaging = true;
        needs.cathlab = true;
        break;
    }
    return needs;
  }
  function buildPayload(form) {
    const f = form || {};
    const source = toTextOrNull(f.originSource);
    const isMeasured = source === "gps" || source === "last-known";
    const payload = {
      case_type_id: toNumberOrNull(f.caseTypeId),
      age: toNumberOrNull(f.age),
      gender: toTextOrNull(f.gender) || "U",
      blood_group: toTextOrNull(f.bloodGroup),
      vitals: {
        systolic_bp: toNumberOrNull(f.systolicBp),
        diastolic_bp: toNumberOrNull(f.diastolicBp),
        heart_rate: toNumberOrNull(f.heartRate),
        resp_rate: toNumberOrNull(f.respRate),
        spo2: toNumberOrNull(f.spo2),
        glucose: toNumberOrNull(f.glucose)
      },
      consciousness: toTextOrNull(f.consciousness),
      origin: {
        lat: toNumberOrNull(f.lat),
        lng: toNumberOrNull(f.lng),
        accuracy_m: isMeasured ? toNumberOrNull(f.accuracy) : null,
        source
      },
      broadcast_radius_km: toNumberOrNull(f.radiusKm) === null ? 15 : toNumberOrNull(f.radiusKm),
      images: Array.isArray(f.images) ? f.images.slice(0, MAX_IMAGES) : [],
      eta_minutes: toNumberOrNull(f.eta),
      notes: toTextOrNull(f.notes),
      ambulance_id: toTextOrNull(f.ambulanceId)
    };
    if (f.category === "STROKE") {
      payload.stroke_assessment = {
        face: !!f.face,
        arm: !!f.arm,
        speech: !!f.speech,
        onset_hours: toNumberOrNull(f.onsetHours)
      };
    }
    return payload;
  }
  const DEMO_CASE_TYPES = [
    { id: 1, category: "TRAUMA", label: "Road accident — multiple injuries", quick: true, short: "Road accident" },
    { id: 2, category: "TRAUMA", label: "Head injury", quick: true, short: "Head injury" },
    { id: 3, category: "TRAUMA", label: "Fall from height" },
    { id: 4, category: "TRAUMA", label: "Crush injury / amputation" },
    { id: 5, category: "TRAUMA", label: "Penetrating injury / stabbing" },
    { id: 6, category: "TRAUMA", label: "Major burns" },
    { id: 7, category: "TRAUMA", label: "Spinal injury suspected" },
    { id: 8, category: "CARDIAC", label: "Chest pain — suspected heart attack", quick: true, short: "Chest pain" },
    { id: 9, category: "CARDIAC", label: "Cardiac arrest", quick: true, short: "Cardiac arrest" },
    { id: 10, category: "CARDIAC", label: "Irregular heartbeat / palpitations" },
    { id: 11, category: "CARDIAC", label: "Heart failure / severe swelling" },
    { id: 12, category: "STROKE", label: "Stroke — sudden weakness or slurred speech", quick: true, short: "Stroke" },
    { id: 13, category: "STROKE", label: "Transient ischaemic attack" },
    { id: 14, category: "NEURO", label: "Seizure / fitting" },
    { id: 15, category: "NEURO", label: "Unresponsive — cause unknown" },
    { id: 16, category: "RESP", label: "Severe breathlessness", quick: true, short: "Breathless" },
    { id: 17, category: "RESP", label: "Asthma attack" },
    { id: 18, category: "RESP", label: "Choking / airway obstruction" },
    { id: 19, category: "RESP", label: "Drowning / near-drowning" },
    { id: 20, category: "OBSTETRIC", label: "Labour / imminent delivery" },
    { id: 21, category: "OBSTETRIC", label: "Pregnancy complication / bleeding" },
    { id: 22, category: "OBSTETRIC", label: "Eclampsia / seizure in pregnancy" },
    { id: 23, category: "PAEDIATRIC", label: "Child — serious illness" },
    { id: 24, category: "PAEDIATRIC", label: "Child — injury" },
    { id: 25, category: "PAEDIATRIC", label: "Newborn in distress" },
    { id: 26, category: "TOXIC", label: "Poisoning / overdose" },
    { id: 27, category: "TOXIC", label: "Snake or animal bite" },
    { id: 28, category: "TOXIC", label: "Severe allergic reaction" },
    { id: 29, category: "TOXIC", label: "Smoke or gas inhalation" },
    { id: 30, category: "MEDICAL", label: "Diabetic emergency" },
    { id: 31, category: "MEDICAL", label: "Heavy bleeding — non-trauma" },
    { id: 32, category: "MEDICAL", label: "Severe abdominal pain" },
    { id: 33, category: "MEDICAL", label: "Severe infection / sepsis suspected" }
  ];
  const CATEGORY_LABELS = [
    ["TRAUMA", "Trauma & injury"],
    ["CARDIAC", "Cardiac"],
    ["STROKE", "Stroke"],
    ["NEURO", "Neurological"],
    ["RESP", "Breathing & airway"],
    ["OBSTETRIC", "Pregnancy & birth"],
    ["PAEDIATRIC", "Children"],
    ["TOXIC", "Poisoning & bites"],
    ["MEDICAL", "Other medical"]
  ];
  function categoryOf(caseTypes, id) {
    const n = toNumberOrNull(id);
    if (n === null) return null;
    const t = (caseTypes || []).find((c) => Number(c.id) === n);
    return t ? t.category : null;
  }
  const PLACEHOLDER = /replace[-_ ]?with|your[-_ ]?backend|example\.com|changeme/i;
  const DEFAULT_CONFIG = {
    SERVER_BASE: "",
    API_PATH: "/api/v1",
    MODE: "auto",
    REALTIME: true,
    POLL_MS: 4e3,
    FALLBACK_ORIGIN: { lat: 12.9716, lng: 77.5946, label: "Bengaluru city centre" }
  };
  function usableServerBase(value) {
    if (value === null || value === void 0) return null;
    const s = String(value).trim().replace(/\/+$/, "");
    if (!s) return null;
    if (PLACEHOLDER.test(s)) return null;
    if (!/^https?:\/\//i.test(s)) return null;
    return s;
  }
  function isCapacitorRuntime(win) {
    try {
      const cap = win && win.Capacitor;
      if (!cap) return false;
      if (typeof cap.isNativePlatform === "function") return !!cap.isNativePlatform();
      return !!cap.isNative;
    } catch (_) {
      return false;
    }
  }
  function resolveEnvironment(options) {
    const opts = options || {};
    const cfg = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
    const loc = opts.location || {};
    const protocol = String(loc.protocol || "").toLowerCase();
    const origin = loc.origin && loc.origin !== "null" ? String(loc.origin).replace(/\/+$/, "") : null;
    const apiPath = cfg.API_PATH || "/api/v1";
    const base = usableServerBase(cfg.SERVER_BASE);
    const capacitor = !!opts.capacitor;
    let demo;
    let reason;
    if (typeof opts.forceDemo === "boolean") {
      demo = opts.forceDemo;
      reason = "forced by test harness";
    } else if (cfg.MODE === "demo") {
      demo = true;
      reason = "config MODE is demo";
    } else if (cfg.MODE === "live") {
      demo = false;
      reason = "config MODE is live";
    } else if (base) {
      demo = false;
      reason = "SERVER_BASE is configured";
    } else if (capacitor) {
      demo = true;
      reason = "running as an APK with no SERVER_BASE set";
    } else if (protocol === "file:") {
      demo = true;
      reason = "opened straight off disk — there is no server to talk to";
    } else if (protocol === "http:" || protocol === "https:") {
      demo = false;
      reason = "served over the network — using the page origin";
    } else {
      demo = true;
      reason = "no reachable backend could be determined";
    }
    const root = base || (demo ? null : origin);
    return {
      demo,
      reason,
      serverBase: base,
      apiRoot: root ? root + apiPath : null,
      realtime: cfg.REALTIME !== false,
      pollMs: Number(cfg.POLL_MS) > 0 ? Number(cfg.POLL_MS) : 4e3,
      fallbackOrigin: cfg.FALLBACK_ORIGIN || null,
      config: cfg
    };
  }
  const LAST_FIX_KEY = "gh_last_fix";
  const LAST_FIX_MAX_AGE_MS = 20 * 60 * 1e3;
  const SOURCE_LABELS = {
    "gps": "GPS",
    "last-known": "recalled fix",
    "manual": "set by hand",
    "demo": "demo position"
  };
  function validCoords(lat, lng) {
    const a = toNumberOrNull(lat);
    const b = toNumberOrNull(lng);
    if (a === null || b === null) return null;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (a < -90 || a > 90) return null;
    if (b < -180 || b > 180) return null;
    if (a === 0 && b === 0) return null;
    return { lat: a, lng: b };
  }
  function describeGeoError(err) {
    const code = err && err.code;
    const raw = String(err && err.message || "");
    if (/secure origin|secure context|only secure/i.test(raw)) {
      return "This page is on plain http, so the browser will not release GPS. Use the app build, or pick a starting point below.";
    }
    if (code === 1) {
      return "Location permission was refused. Pick a starting point below, or allow location and try again.";
    }
    if (code === 2) {
      return "The device could not get a fix. Pick a starting point below, or type the coordinates.";
    }
    if (code === 3) {
      return "Locating timed out. Pick a starting point below, or type the coordinates.";
    }
    return "Location is unavailable. Pick a starting point below, or type the coordinates.";
  }
  function noGeolocationMessage() {
    return "This device offers no location service. Pick a starting point below, or type the coordinates.";
  }
  function describeAge(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    const mins = Math.floor(ms / 6e4);
    if (mins < 1) return "just now";
    if (mins === 1) return "1 min ago";
    if (mins < 60) return mins + " min ago";
    const hours = Math.floor(mins / 60);
    return hours === 1 ? "1 hour ago" : hours + " hours ago";
  }
  function readLastFix(storage, now) {
    try {
      const raw = storage.getItem(LAST_FIX_KEY);
      if (!raw) return null;
      const fix = JSON.parse(raw);
      const coords = validCoords(fix && fix.lat, fix && fix.lng);
      if (!coords) return null;
      const ts = Number(fix.ts);
      if (!Number.isFinite(ts)) return null;
      const age = (now || Date.now()) - ts;
      if (age < 0 || age > LAST_FIX_MAX_AGE_MS) return null;
      return { lat: coords.lat, lng: coords.lng, accuracy: toNumberOrNull(fix.accuracy), ts, age };
    } catch (_) {
      return null;
    }
  }
  function writeLastFix(storage, fix) {
    try {
      storage.setItem(LAST_FIX_KEY, JSON.stringify({
        lat: fix.lat,
        lng: fix.lng,
        accuracy: fix.accuracy == null ? null : fix.accuracy,
        ts: Date.now()
      }));
      return true;
    } catch (_) {
      return false;
    }
  }
  const DEMO_HOSPITALS_NOTIFIED = 3;
  const DEMO_ACCEPTOR = {
    hospital_id: 1,
    name: "Demo City ER",
    distance_km: 3.4,
    phone: "+911234567890",
    lat: 12.9899,
    lng: 77.5921
  };
  class NetworkError extends Error {
    constructor(message) {
      super(message || "Network unreachable");
      this.name = "NetworkError";
      this.network = true;
    }
  }
  class RejectedError extends Error {
    constructor(message, status) {
      super(message || "Rejected");
      this.name = "RejectedError";
      this.status = status;
    }
  }
  function createLiveTransport(apiRoot, fetchImpl) {
    const doFetch = fetchImpl;
    const url = (path) => apiRoot.replace(/\/+$/, "") + path;
    async function readJson(res) {
      try {
        return await res.json();
      } catch (_) {
        return null;
      }
    }
    return {
      kind: "live",
      async caseTypes() {
        const res = await doFetch(url("/case-types"));
        if (!res.ok) throw new RejectedError("HTTP " + res.status, res.status);
        return await res.json();
      },
      async broadcast(payload, clientRequestId) {
        let res;
        try {
          res = await doFetch(url("/requests"), {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Client-Request-Id": clientRequestId },
            body: JSON.stringify(payload)
          });
        } catch (err) {
          throw new NetworkError(err && err.message);
        }
        if (res.status >= 500) throw new NetworkError("Server error " + res.status);
        const body = await readJson(res);
        if (!res.ok) throw new RejectedError(body && body.message || "HTTP " + res.status, res.status);
        return body;
      },
      async status(caseCode) {
        let res;
        try {
          res = await doFetch(url("/requests/" + encodeURIComponent(caseCode)));
        } catch (err) {
          throw new NetworkError(err && err.message);
        }
        if (!res.ok) throw new RejectedError("HTTP " + res.status, res.status);
        return await res.json();
      }
    };
  }
  function createDemoTransport(options) {
    const opts = options || {};
    const delay = () => Number(opts.postMs && opts.postMs()) || 300;
    const shouldFail = () => !!(opts.shouldFail && opts.shouldFail());
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let counter = 0;
    const cases = /* @__PURE__ */ new Map();
    return {
      kind: "demo",
      async caseTypes() {
        return opts.caseTypes || [];
      },
      async broadcast(payload) {
        await wait(delay());
        if (shouldFail()) throw new NetworkError("Demo mode: simulated send failure");
        counter += 1;
        const id = "GH-DEMO-" + String(counter).padStart(4, "0");
        const now = Date.now();
        cases.set(id, { id, created: now, payload });
        return {
          id,
          status: "PENDING",
          hospitals_notified: DEMO_HOSPITALS_NOTIFIED,
          expires_at: new Date(now + 18e4).toISOString(),
          priority: "RED"
        };
      },
      async status(caseCode) {
        const entry = cases.get(caseCode);
        if (!entry) throw new RejectedError("Unknown case", 404);
        const accepted = Date.now() - entry.created >= Math.max(20, delay() * 4);
        if (!accepted) {
          return { id: caseCode, status: "PENDING", hospitals_notified: DEMO_HOSPITALS_NOTIFIED, priority: "RED" };
        }
        return {
          id: caseCode,
          status: "ACCEPTED",
          priority: "RED",
          hospitals_notified: DEMO_HOSPITALS_NOTIFIED,
          accepted_by: DEMO_ACCEPTOR.name,
          accepted_hospital: Object.assign({}, DEMO_ACCEPTOR)
        };
      }
    };
  }
  const OUTBOX_KEY = "goldenhour.outbox";
  const MAX_QUEUED = 3;
  const STALE_MS = 15 * 60 * 1e3;
  function createOutbox(storage, options) {
    const opts = options || {};
    let entries = read();
    function read() {
      try {
        const raw = storage.getItem(OUTBOX_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.slice(0, MAX_QUEUED) : [];
      } catch (_) {
        return [];
      }
    }
    function persist() {
      try {
        storage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(0, MAX_QUEUED)));
        return true;
      } catch (err) {
        const stripped = entries.slice().reverse().find((e) => e.payload && e.payload.images && e.payload.images.length);
        if (stripped) {
          stripped.payload.images = [];
          stripped.photos_dropped = true;
          try {
            storage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(0, MAX_QUEUED)));
            return true;
          } catch (_) {
          }
        }
        return false;
      }
    }
    return {
      all() {
        return entries.slice();
      },
      count() {
        return entries.length;
      },
      isEmpty() {
        return entries.length === 0;
      },
      /** @returns true if the case is safely queued, false if it could not be. */
      enqueue(payload) {
        const entry = {
          id: "ob-" + Date.now() + "-" + Math.floor(Math.random() * 1e6).toString(36),
          payload,
          created_at: (/* @__PURE__ */ new Date()).toISOString(),
          attempts: 0,
          last_error: null,
          last_attempt_at: null
        };
        entries.unshift(entry);
        entries = entries.slice(0, MAX_QUEUED);
        return persist() ? entry : (entries = entries.filter((e) => e !== entry), false);
      },
      remove(id) {
        entries = entries.filter((e) => e.id !== id);
        persist();
      },
      clear() {
        entries = [];
        persist();
      },
      stale(now) {
        const cutoff = (now || Date.now()) - STALE_MS;
        return entries.filter((e) => new Date(e.created_at).getTime() <= cutoff);
      },
      /**
       * Try to send everything that is not stale. `send` is the transport's
       * broadcast(payload, clientRequestId) — reusing the entry id as the
       * idempotency key is what stops a double flush creating two cases.
       */
      async flush(send, now) {
        if (!entries.length) return { sent: [], kept: entries.length, stale: this.stale(now).length };
        const cutoff = (now || Date.now()) - STALE_MS;
        const sent = [];
        const keep = [];
        for (const entry of entries) {
          if (new Date(entry.created_at).getTime() <= cutoff) {
            keep.push(entry);
            continue;
          }
          try {
            const res = await send(entry.payload, entry.id);
            sent.push({ entry, response: res });
          } catch (err) {
            entry.attempts += 1;
            entry.last_attempt_at = (/* @__PURE__ */ new Date()).toISOString();
            entry.last_error = err && err.message || "unknown";
            if (err && err.status >= 400 && err.status < 500) {
              if (opts.onRejected) opts.onRejected(entry, err);
            } else {
              keep.push(entry);
            }
          }
        }
        entries = keep;
        persist();
        return { sent, kept: entries.length, stale: this.stale(now).length };
      }
    };
  }
  const CASES_KEY = "goldenhour.cases";
  const MAX_KEPT = 12;
  const OPEN_STATUSES = ["PENDING", "ACCEPTED"];
  const RECENT_ARRIVAL_MS = 5 * 60 * 1e3;
  function createCaseBook(storage) {
    let items = read();
    function read() {
      try {
        const raw = storage.getItem(CASES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.slice(0, MAX_KEPT) : [];
      } catch (_) {
        return [];
      }
    }
    function persist() {
      try {
        storage.setItem(CASES_KEY, JSON.stringify(items.slice(0, MAX_KEPT)));
      } catch (_) {
      }
    }
    return {
      all() {
        return items.slice();
      },
      /** The one case the crew is currently running, if any. */
      active() {
        return items.find((c) => OPEN_STATUSES.indexOf(c.status) !== -1) || null;
      },
      /**
       * What the Home screen should show.
       *
       * An open case, or — when there is none — a case that arrived in the last
       * few minutes. Without the second half, tapping "Reached hospital" made
       * the entire card vanish along with the confirmation that the arrival had
       * been recorded at all, which is the one moment the crew most needs to
       * see it. It clears itself; nothing has to be dismissed.
       */
      current(now) {
        const open = this.active();
        if (open) return open;
        const cutoff = (now || Date.now()) - RECENT_ARRIVAL_MS;
        return items.find((c) => c.status === "ARRIVED" && new Date(c.updated_at || c.created_at).getTime() > cutoff) || null;
      },
      get(caseCode) {
        return items.find((c) => c.case_code === caseCode) || null;
      },
      record(entry) {
        const existing = items.find((c) => c.case_code === entry.case_code);
        if (existing) {
          Object.assign(existing, entry, { updated_at: (/* @__PURE__ */ new Date()).toISOString() });
        } else {
          items.unshift(Object.assign({
            created_at: (/* @__PURE__ */ new Date()).toISOString(),
            updated_at: (/* @__PURE__ */ new Date()).toISOString(),
            status: "PENDING"
          }, entry));
          items = items.slice(0, MAX_KEPT);
        }
        persist();
        return this.get(entry.case_code);
      },
      setStatus(caseCode, status, extra) {
        const c = this.get(caseCode);
        if (!c) return null;
        c.status = status;
        c.updated_at = (/* @__PURE__ */ new Date()).toISOString();
        if (extra) Object.assign(c, extra);
        persist();
        return c;
      },
      clear() {
        items = [];
        persist();
      }
    };
  }
  function describePatient(entry) {
    if (!entry) return "—";
    const bits = [];
    if (entry.age !== null && entry.age !== void 0 && entry.age !== "") bits.push(String(entry.age));
    const sex = { M: "M", F: "F", O: "O" }[entry.gender];
    if (sex) bits.push(sex);
    return bits.length ? bits.join(" ") : "Age/sex not recorded";
  }
  const STATUS_TEXT = {
    PENDING: "Waiting for a hospital",
    ACCEPTED: "Accepted — en route",
    ARRIVED: "Arrived",
    EXPIRED: "No hospital accepted",
    REJECTED: "Declined by all",
    CANCELLED: "Cancelled",
    QUEUED: "Queued — no signal"
  };
  const STATUS_TONE = {
    PENDING: "caution",
    ACCEPTED: "good",
    ARRIVED: "good",
    EXPIRED: "critical",
    REJECTED: "critical",
    CANCELLED: "muted",
    QUEUED: "caution"
  };
  function describeWhen(iso, now) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const mins = Math.floor((Date.now() - t) / 6e4);
    if (mins < 1) return "just now";
    if (mins === 1) return "1 min ago";
    if (mins < 60) return mins + " min ago";
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours === 1 ? "1 hour ago" : hours + " hours ago";
    const days = Math.floor(hours / 24);
    return days === 1 ? "yesterday" : days + " days ago";
  }
  const PUBLIC_API = {
    MAX_IMAGES,
    VITAL_KEYS,
    DEMO_CASE_TYPES,
    CATEGORY_LABELS,
    getBandFor,
    isOutOfRange,
    toNumberOrNull,
    toTextOrNull,
    buildPayload,
    deriveNeeds,
    categoryOf
  };
  try {
    if (typeof module !== "undefined" && module && typeof module.exports === "object") {
      module.exports = PUBLIC_API;
    }
  } catch (_) {
  }
  if (typeof window !== "undefined") window.GH = PUBLIC_API;
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    if (document.getElementById("app")) start();
    else document.addEventListener("DOMContentLoaded", start);
  }
  function start() {
    try {
      boot(window, document);
    } catch (err) {
      try {
        const banner = document.getElementById("loadError");
        const text = document.getElementById("loadErrorText");
        if (text) text.textContent = "The app failed to start: " + (err && err.message || err);
        if (banner) banner.hidden = false;
      } catch (_) {
      }
      if (window.console && console.error) console.error("[GoldenHour] boot failed", err);
    }
  }
  function boot(win, doc) {
    const $ = (id) => doc.getElementById(id);
    const $$ = (sel) => Array.prototype.slice.call(doc.querySelectorAll(sel));
    const on = (el, evt, fn) => {
      if (el) el.addEventListener(evt, fn);
    };
    const storage = safeStorage(win);
    const env = resolveEnvironment({
      config: win.GH_CONFIG,
      location: win.location,
      capacitor: isCapacitorRuntime(win),
      forceDemo: typeof win.__GH_DEMO === "boolean" ? win.__GH_DEMO : void 0
    });
    const pollMs = () => Number(win.__GH_POLL_MS) > 0 ? Number(win.__GH_POLL_MS) : env.pollMs;
    const transport = env.demo ? createDemoTransport({
      caseTypes: DEMO_CASE_TYPES,
      postMs: () => Number(win.__GH_DEMO_POST_MS) || 300,
      shouldFail: () => !!win.__GH_DEMO_FAIL
    }) : createLiveTransport(env.apiRoot || "", (url, opts) => {
      if (typeof win.fetch !== "function") return Promise.reject(new NetworkError("No fetch in this runtime"));
      return win.fetch(url, opts);
    });
    const outbox = createOutbox(storage, {
      onRejected: (entry) => toast("A queued case was refused by the server and discarded")
    });
    const caseBook = createCaseBook(storage);
    const state = {
      demo: env.demo,
      caseTypes: DEMO_CASE_TYPES.slice(),
      selected: { caseTypeId: null, category: null, gender: "U", bloodGroup: null, consciousness: null, radiusKm: 15 },
      fastState: { face: false, arm: false, speech: false },
      needs: { ventilator: false, blood: false, imaging: false, ot: false, cathlab: false },
      needsTouched: false,
      location: { lat: null, lng: null, accuracy: null, source: null, status: "locating" },
      images: [],
      activeCaseCode: null,
      lastResponse: null,
      lastPayload: null,
      lastClientRequestId: null
    };
    let pollTimer = null;
    let flushTimer = null;
    let socket = null;
    let geoWatch = null;
    function applyTheme(value) {
      const v = value === "dark" || value === "light" ? value : "auto";
      if (v === "auto") doc.documentElement.removeAttribute("data-theme");
      else doc.documentElement.setAttribute("data-theme", v);
      try {
        storage.setItem("goldenhour.theme", JSON.stringify(v));
      } catch (_) {
      }
      const el = $("themeToggle");
      if (el) el.textContent = v === "dark" ? "☾" : v === "light" ? "☀" : "◐";
      $$("#themeSeg .seg-btn").forEach((b) => {
        const isOn = b.dataset.theme === v;
        b.classList.toggle("is-on", isOn);
        b.setAttribute("aria-checked", isOn ? "true" : "false");
      });
    }
    function currentTheme() {
      try {
        return JSON.parse(storage.getItem("goldenhour.theme") || '"auto"');
      } catch (_) {
        return "auto";
      }
    }
    applyTheme(currentTheme());
    on($("themeToggle"), "click", () => {
      const order = { auto: "light", light: "dark", dark: "auto" };
      applyTheme(order[currentTheme()] || "light");
    });
    on($("themeSeg"), "click", (e) => {
      const b = e.target.closest(".seg-btn");
      if (b) applyTheme(b.dataset.theme);
    });
    const VIEWS = { home: "homeView", new: "formScroll", cases: "casesView", settings: "formScroll" };
    function showView(name) {
      const target = VIEWS[name] || VIEWS.home;
      ["homeView", "formScroll", "casesView"].forEach((id) => {
        const el = $(id);
        if (el) el.hidden = id !== target;
      });
      $$("#tabbar .tab").forEach((t) => {
        const isOn = t.dataset.view === name;
        t.classList.toggle("is-on", isOn);
        if (isOn) t.setAttribute("aria-current", "page");
        else t.removeAttribute("aria-current");
      });
      if (name === "settings") {
        const more = $("moreCard");
        if (more) {
          more.open = true;
          more.scrollIntoView && more.scrollIntoView({ block: "start" });
        }
      }
      if (name === "home") renderHome();
      if (name === "cases") renderCaseList();
    }
    on($("tabbar"), "click", (e) => {
      const t = e.target.closest(".tab");
      if (t) showView(t.dataset.view);
    });
    on($("startAlertBtn"), "click", () => showView("new"));
    $$(".quick-row").forEach((row) => on(row, "click", () => {
      const go = row.dataset.go;
      if (go === "active") {
        showView("home");
        const box = $("activeCaseBox");
        if (box && !box.hidden && box.scrollIntoView) box.scrollIntoView({ block: "start" });
      } else showView(go === "new" ? "new" : "cases");
    }));
    on($("continueCaseBtn"), "click", () => {
      if (state.lastResponse) $("successOverlay").hidden = false;
      else showView("new");
    });
    function renderCaseTypes() {
      const sel = $("caseType");
      const quick = $("quickCase");
      if (!sel) return;
      const keep = sel.value;
      sel.textContent = "";
      const placeholder = doc.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Select a case type…";
      sel.appendChild(placeholder);
      CATEGORY_LABELS.forEach(([key, label]) => {
        const inGroup = state.caseTypes.filter((t) => t.category === key);
        if (!inGroup.length) return;
        const group = doc.createElement("optgroup");
        group.label = label;
        inGroup.forEach((t) => {
          const opt = doc.createElement("option");
          opt.value = String(t.id);
          opt.textContent = t.label;
          group.appendChild(opt);
        });
        sel.appendChild(group);
      });
      const known = CATEGORY_LABELS.map((c) => c[0]);
      const others = state.caseTypes.filter((t) => known.indexOf(t.category) === -1);
      if (others.length) {
        const group = doc.createElement("optgroup");
        group.label = "Other";
        others.forEach((t) => {
          const opt = doc.createElement("option");
          opt.value = String(t.id);
          opt.textContent = t.label;
          group.appendChild(opt);
        });
        sel.appendChild(group);
      }
      sel.value = keep;
      if (quick) {
        quick.textContent = "";
        state.caseTypes.filter((t) => t.quick).forEach((t) => {
          const b = doc.createElement("button");
          b.type = "button";
          b.className = "chip chip-xs";
          b.setAttribute("data-case-id", String(t.id));
          b.textContent = t.short || t.label;
          quick.appendChild(b);
        });
      }
    }
    function selectCaseType(id) {
      const n = toNumberOrNull(id);
      state.selected.caseTypeId = n;
      state.selected.category = categoryOf(state.caseTypes, n);
      const sel = $("caseType");
      if (sel) sel.value = n === null ? "" : String(n);
      $$("#quickCase .chip").forEach((c) => c.classList.toggle("is-on", toNumberOrNull(c.dataset.caseId) === n));
      const stroke = $("strokeSection");
      if (stroke) stroke.hidden = state.selected.category !== "STROKE";
      refreshNeeds();
      refreshSubmitHint();
    }
    on($("caseType"), "change", (e) => selectCaseType(e.target.value));
    on($("quickCase"), "click", (e) => {
      const chip = e.target.closest(".chip");
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
        setLoadError("Using the built-in case list — the server list could not be loaded.");
      }
    }
    function setLoadError(message) {
      const banner = $("loadError");
      const text = $("loadErrorText");
      if (!banner) return;
      if (!message) {
        banner.hidden = true;
        return;
      }
      if (text) text.textContent = message;
      banner.hidden = false;
    }
    on($("retryListsBtn"), "click", () => {
      setLoadError(null);
      loadCaseTypes();
    });
    function bindRadioGroup(containerId, attr, onPick) {
      const container = $(containerId);
      on(container, "click", (e) => {
        const b = e.target.closest("[" + attr + "]");
        if (!b || !container.contains(b)) return;
        container.querySelectorAll("[" + attr + "]").forEach((x) => {
          const isOn = x === b;
          x.classList.toggle("is-on", isOn);
          if (x.hasAttribute("role")) x.setAttribute("aria-checked", isOn ? "true" : "false");
        });
        onPick(b.getAttribute(attr), b);
      });
    }
    bindRadioGroup("genderSeg", "data-value", (v) => {
      state.selected.gender = v;
    });
    bindRadioGroup("consciousnessGroup", "data-value", (v) => {
      state.selected.consciousness = v;
      refreshNeeds();
    });
    ["fastFace", "fastArm", "fastSpeech"].forEach((id) => {
      bindRadioGroup(id, "data-yn", (v) => {
        state.fastState[id.replace("fast", "").toLowerCase()] = v === "yes";
      });
    });
    bindRadioGroup("editGender", "data-value", () => {
    });
    bindRadioGroup("editConsciousness", "data-value", () => {
    });
    on($("bloodChips"), "click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      const wasOn = chip.classList.contains("is-on");
      $$("#bloodChips .chip").forEach((c) => c.classList.remove("is-on"));
      if (wasOn) {
        state.selected.bloodGroup = null;
      } else {
        chip.classList.add("is-on");
        state.selected.bloodGroup = chip.dataset.blood;
      }
    });
    on($("editBloodRow"), "click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      const wasOn = chip.classList.contains("is-on");
      $$("#editBloodRow .chip").forEach((c) => c.classList.remove("is-on"));
      if (!wasOn) chip.classList.add("is-on");
    });
    function bindFillChips(containerId, dataKey, targetId, after) {
      on($(containerId), "click", (e) => {
        const chip = e.target.closest(".chip");
        if (!chip) return;
        $$("#" + containerId + " .chip").forEach((c) => c.classList.toggle("is-on", c === chip));
        const target = $(targetId);
        if (target) target.value = chip.dataset[dataKey];
        if (after) after(chip.dataset[dataKey]);
      });
    }
    bindFillChips("ageChips", "age", "age");
    bindFillChips("etaChips", "eta", "eta");
    bindFillChips("onsetChips", "onset", "onsetHours");
    bindFillChips("radiusChips", "radius", "radiusKm", (v) => setRadius(v));
    function setRadius(value) {
      const n = toNumberOrNull(value);
      if (n === null) return;
      state.selected.radiusKm = n;
      const out = $("radiusOut");
      if (out) out.textContent = n + " km";
      $$("#radiusChips .chip").forEach((c) => c.classList.toggle("is-on", toNumberOrNull(c.dataset.radius) === n));
    }
    on($("radiusKm"), "input", (e) => setRadius(e.target.value));
    on($("notes"), "input", (e) => {
      const count = $("notesCount");
      if (count) count.textContent = String(e.target.value.length) + " / 160";
    });
    on($("ambulanceId"), "change", (e) => {
      try {
        storage.setItem("goldenhour.ambulanceId", e.target.value);
      } catch (_) {
      }
    });
    try {
      const savedUnit = storage.getItem("goldenhour.ambulanceId");
      if (savedUnit && $("ambulanceId")) $("ambulanceId").value = savedUnit;
    } catch (_) {
    }
    const VITAL_FIELDS = [
      ["systolicBp", "sysChip"],
      ["diastolicBp", "diaChip"],
      ["heartRate", "hrChip"],
      ["respRate", "rrChip"],
      ["spo2", "spo2Chip"],
      ["glucose", "glcChip"]
    ];
    const BAND_WORD = { good: "Normal", caution: "Caution", critical: "Critical" };
    function paintVital(inputId, chipId) {
      const input = $(inputId);
      const chip = $(chipId);
      if (!input || !chip) return;
      const raw = input.value;
      input.classList.remove("in-good", "in-caution", "in-critical", "in-range");
      if (toNumberOrNull(raw) === null) {
        chip.hidden = true;
        chip.textContent = "";
        chip.className = "chip-state";
        return;
      }
      if (isOutOfRange(inputId, raw)) {
        chip.hidden = false;
        chip.className = "chip-state state-range";
        chip.textContent = "Check value";
        input.classList.add("in-range");
        return;
      }
      const band = getBandFor(inputId, raw);
      if (!band) {
        chip.hidden = true;
        chip.textContent = "";
        chip.className = "chip-state";
        return;
      }
      chip.hidden = false;
      chip.className = "chip-state state-" + band;
      chip.textContent = BAND_WORD[band];
      input.classList.add("in-" + band);
    }
    function readVitals() {
      const out = {};
      VITAL_FIELDS.forEach(([inputId]) => {
        const el = $(inputId);
        out[inputId] = el ? el.value : "";
      });
      return out;
    }
    VITAL_FIELDS.forEach(([inputId, chipId]) => {
      on($(inputId), "input", () => {
        paintVital(inputId, chipId);
        refreshNeeds();
      });
    });
    function repaintAllVitals() {
      VITAL_FIELDS.forEach(([i, c]) => paintVital(i, c));
    }
    const NEED_BUTTONS = { ventilator: "needVent", blood: "needBlood", imaging: "needImaging", ot: "needOt", cathlab: "needCath" };
    function refreshNeeds() {
      if (state.needsTouched) return paintNeeds();
      const v = readVitals();
      state.needs = deriveNeeds({
        category: state.selected.category,
        consciousness: state.selected.consciousness,
        vitals: { spo2: v.spo2, systolic_bp: v.systolicBp }
      });
      paintNeeds();
    }
    function paintNeeds() {
      Object.keys(NEED_BUTTONS).forEach((key) => {
        const b = $(NEED_BUTTONS[key]);
        if (!b) return;
        b.classList.toggle("is-on", !!state.needs[key]);
        b.setAttribute("aria-pressed", state.needs[key] ? "true" : "false");
      });
    }
    on($("needsChips"), "click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      const key = chip.dataset.need;
      if (!(key in state.needs)) return;
      state.needs[key] = !state.needs[key];
      state.needsTouched = true;
      paintNeeds();
    });
    function setLocation(fix) {
      state.location = {
        lat: fix.lat,
        lng: fix.lng,
        accuracy: fix.accuracy === void 0 ? null : fix.accuracy,
        source: fix.source,
        status: "ready"
      };
      const box = $("locBox");
      const measured = fix.source === "gps";
      if (box) box.className = "locbox " + (measured || fix.source === "demo" ? "loc-ready" : "loc-manual");
      const status = $("locationStatus");
      const meta = $("locationMeta");
      if (status) {
        status.textContent = fix.source === "gps" ? "GPS fix ready" : fix.source === "demo" ? "Demo position locked" : fix.source === "last-known" ? "Using the last fix from this shift" : "Using coordinates set by hand";
      }
      if (meta) {
        meta.textContent = measured && fix.accuracy != null ? "±" + Math.round(fix.accuracy) + " m · " + fix.lat.toFixed(4) + ", " + fix.lng.toFixed(4) : fix.lat.toFixed(4) + ", " + fix.lng.toFixed(4) + " · " + (SOURCE_LABELS[fix.source] || fix.source);
      }
      const fallback = $("locFallback");
      if (fallback) fallback.hidden = true;
      const retry = $("locRetryBtn");
      if (retry) retry.hidden = true;
      refreshSubmitHint();
    }
    function setLocationFailed(message) {
      state.location = { lat: null, lng: null, accuracy: null, source: null, status: "unavailable" };
      const box = $("locBox");
      if (box) box.className = "locbox loc-error";
      const status = $("locationStatus");
      if (status) status.textContent = message;
      const meta = $("locationMeta");
      if (meta) meta.textContent = "No position yet";
      const retry = $("locRetryBtn");
      if (retry) retry.hidden = false;
      renderFallbackChips();
      const fallback = $("locFallback");
      if (fallback) fallback.hidden = false;
      refreshSubmitHint();
    }
    function renderFallbackChips() {
      const wrap = $("locFallbackChips");
      if (!wrap) return;
      wrap.textContent = "";
      const last = readLastFix(storage, Date.now());
      if (last) {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "chip chip-xs";
        b.textContent = "Last fix · " + describeAge(last.age);
        b.addEventListener("click", () => setLocation({ lat: last.lat, lng: last.lng, accuracy: null, source: "last-known" }));
        wrap.appendChild(b);
      }
      const preset = env.fallbackOrigin;
      if (preset && toNumberOrNull(preset.lat) !== null) {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "chip chip-xs";
        b.textContent = preset.label || "Use city centre";
        b.addEventListener("click", () => setLocation({
          lat: Number(preset.lat),
          lng: Number(preset.lng),
          accuracy: null,
          source: "manual"
        }));
        wrap.appendChild(b);
      }
    }
    function useTypedCoordinates() {
      const coords = validCoords($("manualLat") && $("manualLat").value, $("manualLng") && $("manualLng").value);
      if (!coords) {
        toast("Those coordinates are not valid — check the latitude and longitude");
        return false;
      }
      setLocation({ lat: coords.lat, lng: coords.lng, accuracy: null, source: "manual" });
      return true;
    }
    on($("useManualBtn"), "click", useTypedCoordinates);
    function locate() {
      if (state.demo) {
        setLocation({ lat: 12.9716, lng: 77.5946, accuracy: null, source: "demo" });
        return;
      }
      const geo = win.navigator && win.navigator.geolocation;
      if (!geo || typeof geo.getCurrentPosition !== "function") {
        setLocationFailed(noGeolocationMessage());
        return;
      }
      state.location.status = "locating";
      const status = $("locationStatus");
      if (status) status.textContent = "Locating device…";
      try {
        geo.getCurrentPosition(
          (pos) => {
            const c = pos && pos.coords;
            const coords = validCoords(c && c.latitude, c && c.longitude);
            if (!coords) {
              setLocationFailed("The device returned an impossible position. Pick a starting point below.");
              return;
            }
            const accuracy = toNumberOrNull(c.accuracy);
            setLocation({ lat: coords.lat, lng: coords.lng, accuracy, source: "gps" });
            writeLastFix(storage, { lat: coords.lat, lng: coords.lng, accuracy });
          },
          (err) => setLocationFailed(describeGeoError(err)),
          { enableHighAccuracy: true, timeout: 8e3, maximumAge: 5e3 }
        );
      } catch (err) {
        setLocationFailed(noGeolocationMessage());
      }
    }
    on($("locRetryBtn"), "click", locate);
    function hasUsableLocation() {
      return state.location.status === "ready" && state.location.lat !== null && state.location.lng !== null;
    }
    function blockingReason() {
      if (state.selected.caseTypeId === null) return "Pick a case type to broadcast";
      if (!hasUsableLocation()) return "A position is needed before this can be sent";
      return null;
    }
    function refreshSubmitHint() {
      const hint = $("submitHint");
      const btn = $("submitBtn");
      if (!hint) return;
      const blocked = blockingReason();
      if (blocked) {
        hint.className = "submit-hint is-bad";
        hint.textContent = blocked;
      } else {
        hint.className = "submit-hint is-ok";
        const src = state.location.source;
        const detail = src === "gps" ? "GPS" + (state.location.accuracy != null ? " ±" + Math.round(state.location.accuracy) + " m" : "") : src === "demo" ? "demo position" : src === "last-known" ? "recalled fix, set by hand" : "position set by hand";
        hint.textContent = "Ready to broadcast · " + detail;
      }
      if (btn) btn.disabled = false;
    }
    function renderPhotos() {
      const grid = $("photoGrid");
      const count = $("photoCount");
      const add = $("addPhotoBtn");
      if (!grid) return;
      grid.querySelectorAll(".photo-tile").forEach((el) => el.remove());
      state.images.forEach((src, index) => {
        const tile = doc.createElement("div");
        tile.className = "photo-tile";
        const img = doc.createElement("img");
        img.alt = "Attached photo " + (index + 1);
        img.src = src;
        const remove = doc.createElement("button");
        remove.type = "button";
        remove.className = "photo-remove";
        remove.setAttribute("aria-label", "Remove photo " + (index + 1));
        remove.textContent = "×";
        remove.addEventListener("click", () => {
          state.images.splice(index, 1);
          renderPhotos();
        });
        tile.appendChild(img);
        tile.appendChild(remove);
        grid.insertBefore(tile, add || null);
      });
      if (count) count.textContent = state.images.length + " / " + MAX_IMAGES;
      if (add) add.hidden = state.images.length >= MAX_IMAGES;
    }
    async function addImage(dataUrl) {
      if (!dataUrl || state.images.length >= MAX_IMAGES) return false;
      state.images.push(dataUrl);
      renderPhotos();
      return true;
    }
    on($("addPhotoBtn"), "click", () => {
      const i = $("photoInput");
      if (i) i.click();
    });
    on($("photoInput"), "change", async (e) => {
      const files = Array.prototype.slice.call(e.target.files || []);
      for (const file of files) {
        if (state.images.length >= MAX_IMAGES) break;
        try {
          await addImage(await compressImage(file, 1280));
        } catch (_) {
          toast("That photo could not be read");
        }
      }
      e.target.value = "";
    });
    function compressImage(file, maxSide) {
      return new Promise((resolve, reject) => {
        const reader = new win.FileReader();
        reader.onerror = () => reject(new Error("read failed"));
        reader.onload = () => {
          const raw = reader.result;
          let canvas;
          try {
            canvas = doc.createElement("canvas");
          } catch (_) {
            return resolve(raw);
          }
          if (!canvas.getContext) return resolve(raw);
          const img = new win.Image();
          img.onerror = () => resolve(raw);
          img.onload = () => {
            try {
              const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
              canvas.width = Math.round(img.width * scale);
              canvas.height = Math.round(img.height * scale);
              canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
              resolve(canvas.toDataURL("image/jpeg", 0.72));
            } catch (_) {
              resolve(raw);
            }
          };
          img.src = raw;
        };
        reader.readAsDataURL(file);
      });
    }
    function collectForm() {
      const v = readVitals();
      return {
        caseTypeId: state.selected.caseTypeId,
        category: state.selected.category,
        age: $("age") ? $("age").value : "",
        gender: state.selected.gender,
        bloodGroup: state.selected.bloodGroup,
        systolicBp: v.systolicBp,
        diastolicBp: v.diastolicBp,
        heartRate: v.heartRate,
        respRate: v.respRate,
        spo2: v.spo2,
        glucose: v.glucose,
        consciousness: state.selected.consciousness,
        lat: state.location.lat,
        lng: state.location.lng,
        accuracy: state.location.accuracy,
        originSource: state.location.source,
        radiusKm: state.selected.radiusKm,
        images: state.images,
        eta: $("eta") ? $("eta").value : "",
        notes: $("notes") ? $("notes").value : "",
        ambulanceId: $("ambulanceId") ? $("ambulanceId").value : "",
        face: state.fastState.face,
        arm: state.fastState.arm,
        speech: state.fastState.speech,
        onsetHours: $("onsetHours") ? $("onsetHours").value : ""
      };
    }
    async function submitLoop() {
      const blocked = blockingReason();
      if (blocked) {
        toast(state.selected.caseTypeId === null ? "Pick a case type first" : blocked);
        refreshSubmitHint();
        return null;
      }
      const payload = buildPayload(collectForm());
      win.__GH_LAST_PAYLOAD = payload;
      state.lastPayload = payload;
      const btn = $("submitBtn");
      if (btn) {
        btn.disabled = true;
        btn.classList.add("is-loading");
      }
      const crid = state.lastClientRequestId || "cr-" + Date.now() + "-" + Math.floor(Math.random() * 1e6).toString(36);
      state.lastClientRequestId = crid;
      try {
        const res = await transport.broadcast(payload, crid);
        state.lastResponse = res;
        state.activeCaseCode = res.id;
        state.lastClientRequestId = null;
        setNetPill(state.demo ? "demo" : "live");
        recordCase(res, payload, "PENDING");
        openSuccess(res, payload);
        startPolling(res.id);
        followCase(res.id);
        return res;
      } catch (err) {
        if (err && err.network && !state.demo) queueForLater(payload);
        else showError(err && err.message || "The server refused this case.");
        return null;
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("is-loading");
        }
      }
    }
    function queueForLater(payload, err) {
      const queued = outbox.enqueue(payload);
      if (!queued) {
        showError("No signal, and this case could not be queued on the device. Please retry.");
        return;
      }
      setNetPill("offline");
      renderOutbox();
      const info = $("outboxInfo");
      if (info) info.textContent = "No signal. This case is queued and sends itself the moment you have a connection.";
      $("successOverlay").hidden = true;
      $("outboxOverlay").hidden = false;
      recordCase({ id: queued.id }, payload, "QUEUED");
    }
    on($("submitBtn"), "click", () => {
      submitLoop();
    });
    function openSuccess(res, payload) {
      const overlay = $("successOverlay");
      const info = $("broadcastInfo");
      if (info) {
        const count = Number(res.hospitals_notified) || 0;
        info.textContent = "Sent to " + count + " nearby hospital" + (count === 1 ? "" : "s") + " within " + payload.broadcast_radius_km + " km.";
      }
      updateStatusChip({ status: "PENDING" });
      const accepted = $("acceptedBox");
      if (accepted) accepted.hidden = true;
      ["callBtn", "navBtn"].forEach((id) => {
        const el = $(id);
        if (el) el.hidden = true;
      });
      if (overlay) overlay.hidden = false;
      $("errorOverlay").hidden = true;
    }
    function showError(message) {
      const el = $("errorMessage");
      if (el) el.textContent = message || "The case could not be sent.";
      $("successOverlay").hidden = true;
      $("errorOverlay").hidden = false;
    }
    on($("backBtn"), "click", () => {
      $("errorOverlay").hidden = true;
    });
    on($("retryBtn"), "click", () => {
      $("errorOverlay").hidden = true;
      submitLoop();
    });
    on($("newRequestBtn"), "click", () => {
      $("successOverlay").hidden = true;
      resetForNewCase();
      showView("new");
    });
    on($("retryConnBtn"), "click", () => {
      $("demoBanner").hidden = true;
      loadCaseTypes();
    });
    on($("outboxPill"), "click", () => {
      $("outboxOverlay").hidden = false;
    });
    on($("tryFlushBtn"), "click", () => flushOutbox());
    on($("discardQueuedBtn"), "click", () => {
      outbox.clear();
      renderOutbox();
      $("outboxOverlay").hidden = true;
    });
    function updateStatusChip(body) {
      const chip = $("statusChip");
      const text = $("statusChipText");
      const accepted = $("acceptedBox");
      if (!chip || !text) return;
      const status = body && body.status;
      if (status === "ACCEPTED" || status === "ARRIVED") {
        chip.className = "status-chip status-accepted";
        const name = body.accepted_hospital && body.accepted_hospital.name || body.accepted_by || "a hospital";
        text.textContent = status === "ARRIVED" ? "Arrived at " + name : "Accepted by " + name;
        if (body.accepted_hospital) paintAcceptedHospital(body.accepted_hospital, body.priority);
        return;
      }
      if (status === "EXPIRED" || status === "REJECTED" || status === "CANCELLED") {
        chip.className = "status-chip status-failed";
        text.textContent = status === "CANCELLED" ? "Cancelled" : "No hospital accepted";
        if (accepted) accepted.hidden = true;
        return;
      }
      chip.className = "status-chip status-pending";
      text.textContent = "Waiting for a hospital to accept…";
      if (accepted) accepted.hidden = true;
    }
    function paintAcceptedHospital(hospital, priority) {
      const box = $("acceptedBox");
      const name = $("acceptedName");
      const meta = $("acceptedMeta");
      if (name) name.textContent = hospital.name || "—";
      if (meta) {
        const bits = [];
        if (priority) bits.push(priority);
        if (hospital.distance_km != null) bits.push(Number(hospital.distance_km).toFixed(1) + " km");
        if (hospital.phone) bits.push("☎ " + hospital.phone);
        meta.textContent = bits.join(" · ");
      }
      if (box) box.hidden = false;
      const call = $("callBtn");
      if (call) {
        if (hospital.phone) {
          call.setAttribute("href", "tel:" + hospital.phone);
          call.hidden = false;
        } else call.hidden = true;
      }
      const nav = $("navBtn");
      if (nav) {
        if (hospital.lat != null && hospital.lng != null) {
          nav.setAttribute("href", "geo:" + hospital.lat + "," + hospital.lng + "?q=" + hospital.lat + "," + hospital.lng + "(" + encodeURIComponent(hospital.name || "Hospital") + ")");
          nav.hidden = false;
        } else nav.hidden = true;
      }
    }
    function stopPolling() {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      if (socket) {
        try {
          socket.disconnect();
        } catch (_) {
        }
        socket = null;
      }
      if (geoWatch != null && win.navigator && win.navigator.geolocation) {
        try {
          win.navigator.geolocation.clearWatch(geoWatch);
        } catch (_) {
        }
        geoWatch = null;
      }
    }
    function startPolling(caseCode) {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          const body = await transport.status(caseCode);
          applyStatus(body);
          if (body.status === "ARRIVED" || body.status === "EXPIRED" || body.status === "REJECTED" || body.status === "CANCELLED") {
            stopped = true;
            return;
          }
        } catch (_) {
        }
        if (!stopped) pollTimer = setTimeout(tick, pollMs());
      };
      pollTimer = setTimeout(tick, pollMs());
    }
    function applyStatus(body) {
      if (!body) return;
      updateStatusChip(body);
      if (state.activeCaseCode) {
        const extra = {};
        const acceptedBy = body.accepted_hospital && body.accepted_hospital.name || body.accepted_by;
        if (acceptedBy) extra.accepted_by = acceptedBy;
        if (body.live_eta_minutes != null) extra.eta_minutes = body.live_eta_minutes;
        if (body.eta_source) extra.eta_source = body.eta_source;
        caseBook.setStatus(state.activeCaseCode, body.status, extra);
      }
      if (body.status === "ACCEPTED") startSharingPosition();
      if (body.status === "ARRIVED") {
        const banner = $("arrivedBanner");
        if (banner) banner.hidden = false;
        stopSharingPosition();
      }
      renderHome();
    }
    function followCase(caseCode) {
      if (state.demo || !env.realtime || !win.io) return;
      try {
        socket = win.io(env.serverBase || void 0, { transports: ["websocket", "polling"] });
      } catch (_) {
        socket = null;
        return;
      }
      socket.on("connect", () => socket.emit("case:follow", caseCode));
      socket.on("case:status", (body) => applyStatus(normaliseStatus(body)));
      socket.on("case:position", (body) => paintTracking(body));
      socket.on("patient:updated", () => {
        const t = $("updateTicker");
        if (!t) return;
        t.textContent = "Patient details updated";
        setTimeout(() => {
          t.textContent = "";
        }, 2400);
      });
    }
    function normaliseStatus(body) {
      return body || {};
    }
    function startSharingPosition(body) {
      const tracking = $("activeTracking");
      if (tracking) tracking.hidden = false;
      if (state.demo || geoWatch != null) return;
      const geo = win.navigator && win.navigator.geolocation;
      if (!geo || typeof geo.watchPosition !== "function" || !socket) return;
      let lastSent = 0;
      geoWatch = geo.watchPosition((pos) => {
        const now = Date.now();
        if (now - lastSent < 1e4) return;
        const c = pos && pos.coords;
        const coords = validCoords(c && c.latitude, c && c.longitude);
        if (!coords || !socket) return;
        lastSent = now;
        socket.emit("ambulance:position", {
          case_code: state.activeCaseCode,
          lat: coords.lat,
          lng: coords.lng,
          accuracy_m: toNumberOrNull(c.accuracy),
          speed_kmh: c.speed != null ? Math.round(c.speed * 3.6) : null,
          source: "gps",
          at: (/* @__PURE__ */ new Date()).toISOString()
        });
      }, () => {
      }, { enableHighAccuracy: true, maximumAge: 5e3 });
    }
    function stopSharingPosition() {
      const tracking = $("activeTracking");
      if (tracking) tracking.hidden = true;
      if (geoWatch != null && win.navigator && win.navigator.geolocation) {
        try {
          win.navigator.geolocation.clearWatch(geoWatch);
        } catch (_) {
        }
        geoWatch = null;
      }
    }
    function paintTracking(body) {
      const text = $("trackingText");
      const eta = $("activeEta");
      if (body && body.live_eta_minutes != null && eta) eta.textContent = body.live_eta_minutes + " min";
      if (!text || !body) return;
      text.textContent = body.eta_source === "stalled" ? "Not moving — tell the hospital if you are delayed" : "Sharing location with the accepting hospital" + (body.live_eta_minutes != null ? " · " + body.live_eta_minutes + " min out" : "");
    }
    on($("delayedBtn"), "click", () => {
      if (!state.activeCaseCode || !socket) {
        toast("Not sharing location yet");
        return;
      }
      socket.emit("ambulance:delayed", { case_code: state.activeCaseCode, reason: "traffic" }, () => {
      });
      toast("The hospital has been told you are delayed");
    });
    let arrivalInFlight = false;
    on($("arrivedBtn"), "click", async () => {
      if (!state.activeCaseCode || arrivalInFlight) return;
      const entry = caseBook.get(state.activeCaseCode);
      if (entry && entry.status === "ARRIVED") {
        toast("Arrival is already recorded");
        return;
      }
      if (win.confirm && !win.confirm("Record arrival and close this case?")) return;
      arrivalInFlight = true;
      stopSharingPosition();
      try {
        if (socket && socket.connected) {
          await new Promise((resolve) => {
            let done = false;
            const finish = () => {
              if (!done) {
                done = true;
                resolve();
              }
            };
            socket.emit("ambulance:arrived", { case_code: state.activeCaseCode }, (body) => {
              if (body && body.success === false) toast(body.message || "The server refused the arrival");
              finish();
            });
            setTimeout(finish, 4e3);
          });
        } else if (!state.demo && env.apiRoot) {
          await win.fetch(env.apiRoot + "/requests/" + encodeURIComponent(state.activeCaseCode) + "/arrived", { method: "POST" });
        }
        caseBook.setStatus(state.activeCaseCode, "ARRIVED");
        updateStatusChip({ status: "ARRIVED", accepted_by: (caseBook.get(state.activeCaseCode) || {}).accepted_by });
        const banner = $("arrivedBanner");
        if (banner) banner.hidden = false;
        toast("Arrival recorded");
        renderHome();
      } catch (err) {
        toast("Arrival could not be recorded — try again");
      } finally {
        arrivalInFlight = false;
      }
    });
    on($("editPatientBtn"), "click", () => {
      if (!state.activeCaseCode) {
        toast("No active case to update");
        return;
      }
      const p = state.lastPayload || {};
      const v = p.vitals || {};
      const setVal = (id, value) => {
        const el = $(id);
        if (el) el.value = value == null ? "" : String(value);
      };
      setVal("editAge", p.age);
      setVal("editSys", v.systolic_bp);
      setVal("editDia", v.diastolic_bp);
      setVal("editHr", v.heart_rate);
      setVal("editRr", v.resp_rate);
      setVal("editSpo2", v.spo2);
      setVal("editGlc", v.glucose);
      setVal("editNotes", p.notes);
      const status = $("editStatus");
      if (status) status.textContent = "";
      $("editOverlay").hidden = false;
    });
    on($("editCancelBtn"), "click", () => {
      $("editOverlay").hidden = true;
    });
    on($("editSaveBtn"), "click", () => {
      const status = $("editStatus");
      if (!state.activeCaseCode) {
        if (status) status.textContent = "No active case.";
        return;
      }
      const selected = (sel) => {
        const el = doc.querySelector(sel);
        return el ? el : null;
      };
      const genderEl = selected("#editGender .seg-btn.is-on");
      const bloodEl = selected("#editBloodRow .chip.is-on");
      const consciousEl = selected("#editConsciousness .level.is-on");
      const patch = {
        age: toNumberOrNull($("editAge").value),
        gender: genderEl ? genderEl.dataset.value : void 0,
        blood_group: bloodEl ? bloodEl.dataset.blood : void 0,
        consciousness: consciousEl ? consciousEl.dataset.value : void 0,
        vitals: {
          systolic_bp: toNumberOrNull($("editSys").value),
          diastolic_bp: toNumberOrNull($("editDia").value),
          heart_rate: toNumberOrNull($("editHr").value),
          resp_rate: toNumberOrNull($("editRr").value),
          spo2: toNumberOrNull($("editSpo2").value),
          glucose: toNumberOrNull($("editGlc").value)
        },
        notes: toTextOrNull($("editNotes").value)
      };
      Object.keys(patch).forEach((k) => {
        if (patch[k] === void 0) delete patch[k];
      });
      if (state.demo) {
        applyLocalPatch(patch);
        if (status) status.textContent = "Saved on this device (demo mode).";
        setTimeout(() => {
          $("editOverlay").hidden = true;
        }, 700);
        return;
      }
      if (!socket || !socket.connected) {
        if (status) status.textContent = "Not connected — the hospital has not seen this change. It will need resending.";
        return;
      }
      if (status) status.textContent = "Sending…";
      socket.emit("patient:update", { case_code: state.activeCaseCode, patient: patch }, (body) => {
        if (body && body.success) {
          applyLocalPatch(patch);
          if (status) status.textContent = "Saved. The hospital has it.";
          setTimeout(() => {
            $("editOverlay").hidden = true;
          }, 700);
        } else if (status) {
          status.textContent = body && body.message || "The server refused this update.";
        }
      });
    });
    function applyLocalPatch(patch) {
      if (!state.lastPayload) return;
      if ("age" in patch) state.lastPayload.age = patch.age;
      if ("gender" in patch) state.lastPayload.gender = patch.gender;
      if ("blood_group" in patch) state.lastPayload.blood_group = patch.blood_group;
      if ("consciousness" in patch) state.lastPayload.consciousness = patch.consciousness;
      if ("notes" in patch) state.lastPayload.notes = patch.notes;
      if (patch.vitals) state.lastPayload.vitals = Object.assign({}, state.lastPayload.vitals, patch.vitals);
      if (state.activeCaseCode) {
        caseBook.record({
          case_code: state.activeCaseCode,
          age: state.lastPayload.age,
          gender: state.lastPayload.gender
        });
      }
      renderHome();
    }
    function renderOutbox() {
      const pill = $("outboxPill");
      const text = $("outboxText");
      const list = $("outboxList");
      const count = outbox.count();
      if (pill) pill.hidden = count === 0;
      if (text) text.textContent = count + " case" + (count === 1 ? "" : "s") + " queued";
      if (list) {
        list.textContent = "";
        outbox.all().forEach((entry) => {
          const row = doc.createElement("div");
          row.className = "recent-row";
          const main = doc.createElement("div");
          main.className = "recent-main";
          const title = doc.createElement("span");
          title.className = "recent-title";
          title.textContent = "Queued case";
          const meta = doc.createElement("span");
          meta.className = "recent-meta";
          meta.textContent = describeWhen(entry.created_at) + (entry.attempts ? " · " + entry.attempts + " attempt" + (entry.attempts === 1 ? "" : "s") : "") + (entry.photos_dropped ? " · photos dropped to fit" : "");
          main.appendChild(title);
          main.appendChild(meta);
          const status = doc.createElement("span");
          status.className = "recent-status tone-caution";
          status.textContent = "Queued";
          row.appendChild(main);
          row.appendChild(status);
          list.appendChild(row);
        });
      }
      if (count === 0) {
        const o = $("outboxOverlay");
        if (o) o.hidden = true;
      }
    }
    async function flushOutbox() {
      if (outbox.isEmpty() || state.demo) return;
      const stale = outbox.stale();
      if (stale.length) {
        const info = $("outboxInfo");
        if (info) {
          info.textContent = stale.length + " queued case" + (stale.length === 1 ? " has" : "s have") + " been waiting over 15 minutes. The patient may already be at a hospital — send or discard deliberately.";
        }
        if ($("outboxOverlay")) $("outboxOverlay").hidden = false;
      }
      try {
        const result = await outbox.flush((payload, id) => transport.broadcast(payload, id));
        if (result.sent.length) {
          toast(result.sent.length + " queued case" + (result.sent.length === 1 ? "" : "s") + " sent");
          setNetPill("live");
          const last = result.sent[result.sent.length - 1];
          state.activeCaseCode = last.response.id;
          state.lastResponse = last.response;
          recordCase(last.response, last.entry.payload, "PENDING");
          startPolling(last.response.id);
          followCase(last.response.id);
        }
      } catch (_) {
      }
      renderOutbox();
      renderHome();
    }
    function recordCase(res, payload, status) {
      const type = state.caseTypes.find((t) => Number(t.id) === Number(payload.case_type_id));
      caseBook.record({
        case_code: res.id,
        case_label: type ? type.short || type.label : "Case",
        age: payload.age,
        gender: payload.gender,
        status,
        eta_minutes: payload.eta_minutes
      });
      renderHome();
    }
    function renderHome() {
      const active = caseBook.current();
      const box = $("activeCaseBox");
      const quickActive = $("quickActiveSub");
      const quickRecent = $("quickRecentSub");
      const all = caseBook.all();
      if (quickRecent) {
        quickRecent.textContent = all.length ? all.length + " case" + (all.length === 1 ? "" : "s") + " on this device." : "Nothing yet this shift.";
      }
      if (!active) {
        if (box) box.hidden = true;
        if (quickActive) quickActive.textContent = "No case is running.";
      } else {
        if (box) box.hidden = false;
        if (quickActive) quickActive.textContent = active.case_label + " · " + (STATUS_TEXT[active.status] || active.status);
        const p = state.lastPayload || {};
        const v = p.vitals || {};
        const set = (id, value) => {
          const el = $(id);
          if (el) el.textContent = value === null || value === void 0 || value === "" ? "—" : String(value);
        };
        set("activeCaseCode", active.case_code);
        set("activePatientName", active.case_label);
        set("activeAgeBand", describePatient(active));
        set("activeGenderLabel", { M: "Male", F: "Female", O: "Other", U: "Unknown" }[active.gender] || "Unknown");
        set("activeBlood", p.blood_group);
        set("activeCondition", p.consciousness);
        set("activeHr", v.heart_rate);
        set("activeBp", (v.systolic_bp || "—") + "/" + (v.diastolic_bp || "—"));
        set("activeSpo2", v.spo2);
        set("activeStatusText", STATUS_TEXT[active.status] || active.status);
        set("activeEta", active.eta_minutes != null ? active.eta_minutes + " min" : "— min");
        set("activeFacility", active.accepted_by || "Waiting for a hospital");
        const notes = $("activeNotes");
        if (notes) notes.textContent = p.notes || "No additional notes";
        const arrived = active.status === "ARRIVED";
        const arrivedBtn = $("arrivedBtn");
        if (arrivedBtn) {
          arrivedBtn.disabled = active.status !== "ACCEPTED";
          arrivedBtn.hidden = arrived;
        }
        const banner = $("arrivedBanner");
        if (banner) banner.hidden = !arrived;
        ["editPatientBtn", "delayedBtn", "continueCaseBtn"].forEach((id) => {
          const el = $(id);
          if (el) el.hidden = arrived;
        });
      }
      renderRecentInto("homeRecentList", 4);
    }
    function renderRecentInto(containerId, limit) {
      const list = $(containerId);
      if (!list) return;
      const all = caseBook.all().slice(0, limit || 50);
      list.textContent = "";
      if (!all.length) {
        const p = doc.createElement("p");
        p.className = "empty-note";
        p.textContent = "Cases you send appear here.";
        list.appendChild(p);
        return;
      }
      all.forEach((entry) => {
        const row = doc.createElement("div");
        row.className = "recent-row";
        const main = doc.createElement("div");
        main.className = "recent-main";
        const title = doc.createElement("span");
        title.className = "recent-title";
        title.textContent = entry.case_label || "Case";
        const meta = doc.createElement("span");
        meta.className = "recent-meta";
        meta.textContent = describePatient(entry) + " · " + describeWhen(entry.created_at);
        main.appendChild(title);
        main.appendChild(meta);
        const status = doc.createElement("span");
        status.className = "recent-status tone-" + (STATUS_TONE[entry.status] || "muted");
        status.textContent = STATUS_TEXT[entry.status] || entry.status;
        row.appendChild(main);
        row.appendChild(status);
        list.appendChild(row);
      });
    }
    function renderCaseList() {
      renderRecentInto("caseList", 50);
    }
    function resetForNewCase() {
      state.selected.caseTypeId = null;
      state.selected.category = null;
      state.selected.gender = "U";
      state.selected.bloodGroup = null;
      state.selected.consciousness = null;
      state.fastState = { face: false, arm: false, speech: false };
      state.needsTouched = false;
      state.images = [];
      state.lastClientRequestId = null;
      ["age", "systolicBp", "diastolicBp", "heartRate", "respRate", "spo2", "glucose", "eta", "onsetHours", "notes"].forEach((id) => {
        const el = $(id);
        if (el) el.value = "";
      });
      const sel = $("caseType");
      if (sel) sel.value = "";
      const count = $("notesCount");
      if (count) count.textContent = "0 / 160";
      $$("#quickCase .chip, #bloodChips .chip, #ageChips .chip, #etaChips .chip, #onsetChips .chip").forEach((c) => c.classList.remove("is-on"));
      resetRadioGroup("genderSeg", "data-value", "U");
      resetRadioGroup("consciousnessGroup", "data-value", null);
      ["fastFace", "fastArm", "fastSpeech"].forEach((id) => resetRadioGroup(id, "data-yn", "no"));
      setRadius(15);
      const stroke = $("strokeSection");
      if (stroke) stroke.hidden = true;
      repaintAllVitals();
      renderPhotos();
      refreshNeeds();
      locate();
      refreshSubmitHint();
    }
    function resetRadioGroup(containerId, attr, value) {
      const container = $(containerId);
      if (!container) return;
      container.querySelectorAll("[" + attr + "]").forEach((x) => {
        const isOn = value !== null && x.getAttribute(attr) === value;
        x.classList.toggle("is-on", isOn);
        if (x.hasAttribute("role")) x.setAttribute("aria-checked", isOn ? "true" : "false");
      });
    }
    let toastTimer = null;
    function toast(message) {
      const el = $("toast");
      if (!el) return;
      el.textContent = message;
      el.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.hidden = true;
      }, 3e3);
    }
    function setNetPill(mode) {
      const pill = $("netPill");
      if (!pill) return;
      pill.className = "pill " + (mode === "live" ? "pill-good" : mode === "demo" ? "pill-caution" : "pill-critical");
      pill.textContent = mode === "live" ? "Live" : mode === "demo" ? "Demo" : "Offline";
    }
    renderCaseTypes();
    setRadius(15);
    repaintAllVitals();
    renderPhotos();
    refreshNeeds();
    renderOutbox();
    renderHome();
    locate();
    refreshSubmitHint();
    showView("home");
    if (state.demo) {
      setNetPill("demo");
      const banner = $("demoBanner");
      if (banner) banner.hidden = false;
    } else {
      setNetPill("live");
      const banner = $("demoBanner");
      if (banner) banner.hidden = true;
      loadCaseTypes();
      flushTimer = setInterval(() => {
        flushOutbox();
      }, 2e4);
      on(win, "online", () => {
        setNetPill("live");
        flushOutbox();
      });
      on(win, "offline", () => setNetPill("offline"));
    }
    win.__GH = {
      state: () => ({
        demo: state.demo,
        location: Object.assign({}, state.location),
        selected: Object.assign({}, state.selected),
        fastState: Object.assign({}, state.fastState),
        needs: Object.assign({}, state.needs),
        images: state.images.slice(),
        activeCaseCode: state.activeCaseCode
      }),
      buildPayload,
      getBandFor,
      isOutOfRange,
      submitLoop,
      addImage,
      useTypedCoordinates,
      hasUsableLocation,
      updateStatusChip,
      stopPolling,
      locate,
      flushOutbox,
      showView,
      env
    };
  }
  function safeStorage(win) {
    const memory = {};
    let real = null;
    try {
      real = win.localStorage;
      real.getItem("__gh_probe__");
    } catch (_) {
      real = null;
    }
    return {
      getItem(k) {
        try {
          return real ? real.getItem(k) : k in memory ? memory[k] : null;
        } catch (_) {
          return k in memory ? memory[k] : null;
        }
      },
      setItem(k, v) {
        memory[k] = String(v);
        try {
          if (real) real.setItem(k, v);
        } catch (_) {
        }
      },
      removeItem(k) {
        delete memory[k];
        try {
          if (real) real.removeItem(k);
        } catch (_) {
        }
      }
    };
  }
})();
