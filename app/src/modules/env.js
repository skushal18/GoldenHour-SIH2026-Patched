/* ============================================================================
   Where the app thinks its backend is.

   This is the subtlest file in the app. Capacitor serves the APK's own assets
   from https://localhost, so the obvious rule — "use the page origin" —
   silently resolves to https://localhost/api/v1, a server that does not
   exist. The crew would see a form that submits into nothing and never says
   why. So an APK with no SERVER_BASE configured falls back to DEMO mode,
   loudly, rather than pretending to be live.
   ========================================================================== */

const PLACEHOLDER = /replace[-_ ]?with|your[-_ ]?backend|example\.com|changeme/i;

export const DEFAULT_CONFIG = {
  SERVER_BASE: '',
  API_PATH: '/api/v1',
  MODE: 'auto',
  REALTIME: true,
  POLL_MS: 4000,
  FALLBACK_ORIGIN: { lat: 12.9716, lng: 77.5946, label: 'Bengaluru city centre' },
};

/** A SERVER_BASE that is blank, whitespace or a leftover placeholder is unset. */
export function usableServerBase(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/\/+$/, '');
  if (!s) return null;
  if (PLACEHOLDER.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

export function isCapacitorRuntime(win) {
  try {
    const cap = win && win.Capacitor;
    if (!cap) return false;
    if (typeof cap.isNativePlatform === 'function') return !!cap.isNativePlatform();
    return !!cap.isNative;
  } catch (_) { return false; }
}

/**
 * Decide live-vs-demo and the API root, from the config file, the page URL
 * and the runtime. Pure: everything it needs is passed in.
 */
export function resolveEnvironment(options) {
  const opts = options || {};
  const cfg = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
  const loc = opts.location || {};
  const protocol = String(loc.protocol || '').toLowerCase();
  const origin = loc.origin && loc.origin !== 'null' ? String(loc.origin).replace(/\/+$/, '') : null;
  const apiPath = cfg.API_PATH || '/api/v1';
  const base = usableServerBase(cfg.SERVER_BASE);
  const capacitor = !!opts.capacitor;

  let demo;
  let reason;

  if (typeof opts.forceDemo === 'boolean') {
    demo = opts.forceDemo; reason = 'forced by test harness';
  } else if (cfg.MODE === 'demo') {
    demo = true; reason = 'config MODE is demo';
  } else if (cfg.MODE === 'live') {
    demo = false; reason = 'config MODE is live';
  } else if (base) {
    demo = false; reason = 'SERVER_BASE is configured';
  } else if (capacitor) {
    /* The whole reason this file exists. */
    demo = true; reason = 'running as an APK with no SERVER_BASE set';
  } else if (protocol === 'file:') {
    demo = true; reason = 'opened straight off disk — there is no server to talk to';
  } else if (protocol === 'http:' || protocol === 'https:') {
    demo = false; reason = 'served over the network — using the page origin';
  } else {
    demo = true; reason = 'no reachable backend could be determined';
  }

  const root = base || (demo ? null : origin);
  return {
    demo,
    reason,
    serverBase: base,
    apiRoot: root ? root + apiPath : null,
    realtime: cfg.REALTIME !== false,
    pollMs: Number(cfg.POLL_MS) > 0 ? Number(cfg.POLL_MS) : 4000,
    fallbackOrigin: cfg.FALLBACK_ORIGIN || null,
    config: cfg,
  };
}
