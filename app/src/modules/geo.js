/* ============================================================================
   Location — and, more importantly, honesty about location.

   A phone browser opening the app from a laptop's LAN address gets its
   geolocation request refused by Chrome, because a private-IP http origin is
   not a secure context. That is not a bug the crew can fix at 3 a.m., so the
   app always offers a way through: GPS, then the last fix from this shift,
   then a one-tap preset, then typed coordinates.

   Every one of those is tagged with how it was obtained, and the tag travels
   all the way to the ER board. A hospital reads "1.8 km away" very
   differently when the 1.8 km was measured than when it was typed.
   ========================================================================== */

import { toNumberOrNull } from './logic.js';

export const LAST_FIX_KEY = 'gh_last_fix';

/** A recalled fix older than this could be in a different part of the city. */
export const LAST_FIX_MAX_AGE_MS = 20 * 60 * 1000;

export const SOURCE_LABELS = {
  'gps': 'GPS',
  'last-known': 'recalled fix',
  'manual': 'set by hand',
  'demo': 'demo position',
};

export function validCoords(lat, lng) {
  const a = toNumberOrNull(lat);
  const b = toNumberOrNull(lng);
  if (a === null || b === null) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < -90 || a > 90) return null;
  if (b < -180 || b > 180) return null;
  /* 0,0 is a real point in the Gulf of Guinea and never an Indian ambulance.
     It is what a null coordinate looks like after a careless Number(). */
  if (a === 0 && b === 0) return null;
  return { lat: a, lng: b };
}

/**
 * Turn a GeolocationPositionError into something that tells the crew what to
 * do next, not just what broke. The secure-origin case gets its own wording
 * because "permission denied" is actively misleading there — nobody denied
 * anything, the browser refused to ask.
 */
export function describeGeoError(err) {
  const code = err && err.code;
  const raw = String((err && err.message) || '');

  if (/secure origin|secure context|only secure/i.test(raw)) {
    return 'This page is on plain http, so the browser will not release GPS. ' +
           'Use the app build, or pick a starting point below.';
  }
  if (code === 1) {
    return 'Location permission was refused. Pick a starting point below, ' +
           'or allow location and try again.';
  }
  if (code === 2) {
    return 'The device could not get a fix. Pick a starting point below, ' +
           'or type the coordinates.';
  }
  if (code === 3) {
    return 'Locating timed out. Pick a starting point below, or type the coordinates.';
  }
  return 'Location is unavailable. Pick a starting point below, or type the coordinates.';
}

export function noGeolocationMessage() {
  return 'This device offers no location service. Pick a starting point below, ' +
         'or type the coordinates.';
}

/** "4 min ago" / "just now" — the age is what makes a recalled fix judgeable. */
export function describeAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return mins + ' min ago';
  const hours = Math.floor(mins / 60);
  return hours === 1 ? '1 hour ago' : hours + ' hours ago';
}

export function readLastFix(storage, now) {
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
  } catch (_) { return null; }
}

export function writeLastFix(storage, fix) {
  try {
    storage.setItem(LAST_FIX_KEY, JSON.stringify({
      lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy == null ? null : fix.accuracy, ts: Date.now(),
    }));
    return true;
  } catch (_) { return false; }
}
