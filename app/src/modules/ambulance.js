/* ============================================================================
   This ambulance's login, the phone it runs on, and its calls to the server.

   Each ambulance signs in once on its phone with the one-time code from the
   GoldenHour administrator. The token is kept on the phone; every case the
   phone sends carries it, so the hospital and the administrator see which
   vehicle sent it. The phone reports what it is (model, OS, app version,
   screen, memory, battery, network, location permission) when it signs in
   and every few minutes, and the crew on shift is kept with the vehicle.

   Self-contained (no imports) so the unit tests can load it on its own.
   ========================================================================== */

export const APP_VERSION = '7.2.0';
export const AUTH_KEY = 'goldenhour.ambulance';
export const INSTALL_KEY = 'goldenhour.installationId';
export const CREW_ROLES = ['Driver', 'EMT', 'Paramedic', 'Nurse', 'Doctor', 'Other'];

export function readAuth(storage) {
  try { const raw = storage.getItem(AUTH_KEY); const v = raw ? JSON.parse(raw) : null; return v && v.token ? v : null; }
  catch (_) { return null; }
}
export function writeAuth(storage, value) {
  try { if (value) storage.setItem(AUTH_KEY, JSON.stringify(value)); else storage.removeItem(AUTH_KEY); } catch (_) {}
}

/** A random id for this installation, kept for the life of the app's storage. */
export function installationId(storage, rand) {
  try {
    let id = storage.getItem(INSTALL_KEY);
    if (!id) {
      const r = rand || (() => Math.random().toString(16).slice(2));
      id = (r() + r() + r()).replace(/[^0-9a-f]/g, '').slice(0, 24).padEnd(24, '0');
      storage.setItem(INSTALL_KEY, id);
    }
    return id;
  } catch (_) { return null; }
}

/** Model, maker and OS from a user-agent string (Android WebView / Chrome / iOS / desktop). */
export function parseUserAgent(ua) {
  const s = String(ua || '');
  const out = { os: null, os_version: null, model: null, manufacturer: null };
  let m = s.match(/Android\s+([\d.]+)(?:;\s*([^;)]+))?/);
  if (m) {
    out.os = 'Android'; out.os_version = m[1];
    const model = (m[2] || '').replace(/\s+Build\/.*$/, '').trim();
    if (model && model !== 'K' && !/^wv$/i.test(model)) out.model = model;
    if (out.model) {
      const makers = [[/^SM-|Samsung/i, 'Samsung'], [/^Pixel/i, 'Google'], [/^(Redmi|Mi |POCO|M\d{4})/i, 'Xiaomi'], [/^(CPH|OPPO)/i, 'OPPO'],
        [/^(RMX|realme)/i, 'realme'], [/^(V\d{4}|vivo)/i, 'vivo'], [/^(moto|XT\d)/i, 'Motorola'], [/^(ONEPLUS|[A-Z]{2}\d{4}$)/i, 'OnePlus'], [/^Nokia/i, 'Nokia']];
      for (const [re, name] of makers) if (re.test(out.model)) { out.manufacturer = name; break; }
    }
    return out;
  }
  if ((m = s.match(/(iPhone|iPad).*?OS\s+([\d_]+)/))) { out.os = 'iOS'; out.os_version = m[2].replace(/_/g, '.'); out.model = m[1]; out.manufacturer = 'Apple'; return out; }
  if ((m = s.match(/Windows NT\s+([\d.]+)/))) { out.os = 'Windows'; out.os_version = m[1]; return out; }
  if ((m = s.match(/Mac OS X\s+([\d_]+)/))) { out.os = 'macOS'; out.os_version = m[1].replace(/_/g, '.'); return out; }
  if (/Linux/.test(s)) out.os = 'Linux';
  return out;
}

/** What this phone is, as far as the web platform can tell. Never throws. */
export async function describeDevice(win, storage, native) {
  const nav = (win && win.navigator) || {};
  const ua = nav.userAgent || '';
  const p = parseUserAgent(ua);
  const scr = win && win.screen;
  const dpr = (win && win.devicePixelRatio) || 1;
  const out = {
    installation_id: installationId(storage),
    platform: native ? 'android' : 'web',
    model: p.model, manufacturer: p.manufacturer, os: p.os, os_version: p.os_version,
    app_version: APP_VERSION,
    webview: (ua.match(/Chrome\/([\d.]+)/) || [])[1] ? 'Chrome ' + ua.match(/Chrome\/([\d.]+)/)[1] : null,
    screen: scr && scr.width ? Math.round(scr.width * dpr) + '×' + Math.round(scr.height * dpr) : null,
    memory_gb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    cpu_cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    network: nav.connection && nav.connection.effectiveType ? nav.connection.effectiveType : null,
    online: typeof nav.onLine === 'boolean' ? nav.onLine : null,
    language: nav.language || null,
    user_agent: ua.slice(0, 300),
    battery_pct: null, charging: null, location_permission: null,
  };
  try {
    if (nav.getBattery) {
      const b = await Promise.race([nav.getBattery(), new Promise(r => setTimeout(() => r(null), 800))]);
      if (b) { out.battery_pct = Math.round(b.level * 100); out.charging = !!b.charging; }
    }
  } catch (_) {}
  try {
    if (nav.permissions && nav.permissions.query) {
      const st = await Promise.race([nav.permissions.query({ name: 'geolocation' }), new Promise(r => setTimeout(() => r(null), 800))]);
      if (st && st.state) out.location_permission = st.state;
    }
  } catch (_) {}
  return out;
}

/* ── server calls ─────────────────────────────────────────────────────── */
async function call(fetcher, url, opts) {
  let res;
  try { res = await fetcher(url, opts); }
  catch (_) { const e = new Error('Cannot reach GoldenHour. Check the signal and try again.'); e.network = true; throw e; }
  let body = {};
  try { body = await res.json(); } catch (_) {}
  if (!res.ok || body.success === false) {
    const e = new Error(body.message || 'Request failed (' + res.status + ')');
    e.status = res.status; e.reason = body.reason; throw e;
  }
  return body;
}
const json = (method, token, body) => ({ method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
  body: body === undefined ? undefined : JSON.stringify(body) });

export function signIn(fetcher, apiRoot, code, device) { return call(fetcher, apiRoot + '/auth/ambulance/pair', json('POST', null, { code, device })); }
export function heartbeat(fetcher, apiRoot, token, device) { return call(fetcher, apiRoot + '/ambulance/heartbeat', json('POST', token, { device })); }
export function saveCrew(fetcher, apiRoot, token, crew) { return call(fetcher, apiRoot + '/ambulance/crew', json('PUT', token, { crew })); }
export function signOut(fetcher, apiRoot, token) { return call(fetcher, apiRoot + '/ambulance/sign-out', json('POST', token, {})); }
export function fetchRoute(fetcher, apiRoot, caseCode, crewToken) {
  return call(fetcher, apiRoot + '/requests/' + encodeURIComponent(caseCode) + '/route', { headers: { 'X-Crew-Token': crewToken || '' } });
}

/** A server answer that means "this phone is no longer signed in". */
export function isSignedOut(err) {
  return !!err && (err.reason === 'AMBULANCE_SIGN_IN' || err.reason === 'AMBULANCE_DISABLED');
}

/* ── navigation helpers ───────────────────────────────────────────────── */
export function metres(a, b) {
  if (!a || !b) return null;
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * The next instruction from where the ambulance is: the first maneuver after
 * the one nearest to it (or that one, if it is still ahead).
 * @returns {{index, step, metres}|null}
 */
export function nextStep(steps, here) {
  const list = (steps || []).filter(s => s && s.at);
  if (!list.length || !here) return null;
  let best = 0, bestD = Infinity;
  list.forEach((s, i) => { const d = metres(here, s.at); if (d < bestD) { bestD = d; best = i; } });
  let i = best;
  if (list[i].type === 'depart' || bestD < 30) i = Math.min(best + 1, list.length - 1);
  return { index: i, step: list[i], metres: Math.round(metres(here, list[i].at)) };
}

export function formatDistance(m) {
  if (m == null || !Number.isFinite(m)) return '—';
  if (m < 1000) return (m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50) + ' m';
  return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
}
