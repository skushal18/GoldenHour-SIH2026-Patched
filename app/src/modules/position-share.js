/* ============================================================================
   Sharing the ambulance's GPS with the accepting hospital.

   Two rules, both learned from desks that showed "no fix yet" for a whole
   journey:

   1. A rough fix is still a fix. A phone indoors or a browser on Wi-Fi
      location reports hundreds of metres of uncertainty; dropping those fixes
      meant the ER saw nothing at all. Anything up to MAX_ACCURACY_M is sent,
      marked with its accuracy, and the desk draws it as approximate.

   2. The socket is not the only road. If it is down, or the acknowledgement
      never comes back, the same fix goes over HTTP with the crew token
      (POST /requests/:code/position). The server treats a repeat of the same
      fix as already recorded, so sending it twice is harmless.

   Self-contained (no imports) so the unit tests can load it on its own.
   ========================================================================== */

export const MAX_ACCURACY_M = 2000;
export const PRECISE_ACCURACY_M = 200;
export const MAX_FIX_AGE_MS = 30000;

/**
 * A browser / Capacitor position → the fix to send, or why not.
 * @returns {{ok:true, fix}|{ok:false, reason:'NO_COORDS'|'OLD_FIX'|'TOO_ROUGH', accuracy_m?:number}}
 */
export function fixFromPosition(pos, now) {
  const t = now == null ? Date.now() : now;
  const c = pos && pos.coords;
  const lat = c ? Number(c.latitude) : NaN, lng = c ? Number(c.longitude) : NaN;
  if (!c || c.latitude == null || c.longitude == null || !Number.isFinite(lat) || !Number.isFinite(lng) ||
      Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return { ok: false, reason: 'NO_COORDS' };
  const ts = pos.timestamp;
  if (!Number.isFinite(ts) || t - ts > MAX_FIX_AGE_MS || ts > t + 30000) return { ok: false, reason: 'OLD_FIX' };
  const accuracy = c.accuracy == null || !Number.isFinite(Number(c.accuracy)) ? null : Math.round(Number(c.accuracy));
  if (accuracy != null && accuracy > MAX_ACCURACY_M) return { ok: false, reason: 'TOO_ROUGH', accuracy_m: accuracy };
  return { ok: true, fix: {
    lat, lng, accuracy_m: accuracy,
    speed_kmh: c.speed != null && Number.isFinite(Number(c.speed)) && c.speed >= 0 ? Math.round(c.speed * 3.6) : null,
    at: new Date(ts).toISOString(),
    approximate: accuracy != null && accuracy > PRECISE_ACCURACY_M,
  } };
}

/**
 * Send one fix. Resolves { success, via:'socket'|'http', approximate, reason?, message? };
 * never rejects, because a lost fix is replaced by the next one ten seconds later.
 */
export async function sharePosition({ socket, fetch: fetcher, apiRoot, caseCode, crewToken, fix, timeoutMs = 6000 }) {
  const payload = { case_code: caseCode, crew_token: crewToken, lat: fix.lat, lng: fix.lng,
    accuracy_m: fix.accuracy_m, speed_kmh: fix.speed_kmh, source: 'gps', at: fix.at };
  if (socket && socket.connected) {
    const ack = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      try { socket.emit('ambulance:position', payload, body => { clearTimeout(timer); resolve(body || null); }); }
      catch (_) { clearTimeout(timer); resolve(null); }
    });
    if (ack && ack.success === true) return { success: true, via: 'socket', approximate: !!fix.approximate };
    /* The server looked at the fix and said no: HTTP would get the same answer. */
    if (ack && ack.success === false) return { success: false, via: 'socket', reason: ack.reason, message: ack.message };
  }
  if (!apiRoot || typeof fetcher !== 'function') return { success: false, via: 'none', reason: 'OFFLINE', message: 'No connection to the server' };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetcher(apiRoot + '/requests/' + encodeURIComponent(caseCode) + '/position', {
      method: 'POST', signal: controller ? controller.signal : undefined,
      headers: { 'Content-Type': 'application/json', 'X-Crew-Token': crewToken || '' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body && body.success === true) return { success: true, via: 'http', approximate: !!fix.approximate };
    return { success: false, via: 'http', reason: (body && body.reason) || 'HTTP_' + response.status, message: body && body.message };
  } catch (err) {
    return { success: false, via: 'http', reason: 'OFFLINE', message: 'No connection to the server' };
  } finally { if (timer) clearTimeout(timer); }
}

/** What the crew sees under "Live tracking" for a result or a refused fix. */
export function describeShare(result) {
  if (!result) return 'Waiting for GPS…';
  if (result.reason === 'TOO_ROUGH') return 'GPS too rough to share (±' + (result.accuracy_m >= 1000 ? (result.accuracy_m / 1000).toFixed(1) + ' km' : result.accuracy_m + ' m') + ') — move into the open';
  if (result.reason === 'OLD_FIX') return 'Waiting for a fresh GPS fix…';
  if (result.reason === 'NO_COORDS') return 'Waiting for GPS…';
  if (result.success) {
    const how = result.via === 'http' ? ' (backup connection)' : '';
    return result.approximate
      ? 'Approximate location shared with the hospital' + how + ' — GPS is rough here'
      : 'GPS location delivered to the accepting hospital' + how;
  }
  if (result.reason === 'OFFLINE') return 'No connection — location will be sent when the signal returns';
  if (result.reason === 'NOT_TRACKING') return 'Location sharing has ended for this case';
  return 'Location was not accepted — waiting for a fresh fix';
}
