/* ============================================================================
   Validation of what an ambulance sends.

   Two principles run through this file.

   First: reject nonsense, never silently correct it. A systolic of 8000 is a
   typo, and turning it into 300 would put a fabricated number in front of a
   doctor. Say no and let the crew fix it.

   Second: never reject something merely unusual. A 104-year-old patient, a
   heart rate of 22, a case with no vitals at all — these are all real, and a
   validator that refuses them stops a genuine emergency from being broadcast.
   The bounds below are the limits of physical possibility, not of the normal
   range; deciding what is *clinically* alarming is the triage service's job.
   ========================================================================== */
'use strict';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;      // ~3 MB per photo after compression
const MAX_NOTES = 500;
const MAX_UNIT_ID = 40;

/* [min, max] of what a human body can actually produce. */
const VITAL_BOUNDS = {
  systolic_bp: [40, 300],
  diastolic_bp: [20, 200],
  heart_rate: [20, 300],
  resp_rate: [4, 80],
  spo2: [50, 100],
  glucose: [10, 900],
};

const GENDERS = ['M', 'F', 'O', 'U'];
const ORIGIN_SOURCES = ['gps', 'manual', 'last-known', 'demo'];

function isBlank(v) { return v === null || v === undefined || v === ''; }

/**
 * A coordinate, or null.
 *
 * The explicit blank check before Number() is the whole point: Number(null)
 * and Number('') are both 0, and 0°,0° is a real place in the Gulf of Guinea.
 * A case created there is dispatchable-looking and matchable to nothing.
 */
function coord(raw, limit) {
  if (isBlank(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < -limit || n > limit) return null;
  return n;
}

/**
 * @returns {{ok:true}} or {{ok:false, message, field}}
 */
function validateBroadcast(body) {
  const b = body || {};
  const fail = (message, field) => ({ ok: false, message, field });

  if (isBlank(b.case_type_id)) return fail('case_type_id is required', 'case_type_id');
  if (!Number.isFinite(Number(b.case_type_id))) return fail('case_type_id must be a number', 'case_type_id');

  const lat = b.origin ? coord(b.origin.lat, 90) : null;
  const lng = b.origin ? coord(b.origin.lng, 180) : null;
  if (lat === null || lng === null) {
    return fail('origin.lat and origin.lng are required and must be real coordinates', 'origin');
  }
  if (lat === 0 && lng === 0) {
    return fail('origin 0,0 is not a real dispatch location', 'origin');
  }
  if (b.origin && !isBlank(b.origin.source) && ORIGIN_SOURCES.indexOf(String(b.origin.source)) === -1) {
    return fail('origin.source must be one of: ' + ORIGIN_SOURCES.join(', '), 'origin.source');
  }
  if (b.origin && !isBlank(b.origin.accuracy_m)) {
    const acc = Number(b.origin.accuracy_m);
    if (!Number.isFinite(acc) || acc < 0 || acc > 100000) return fail('origin.accuracy_m is out of range', 'origin.accuracy_m');
  }

  if (!isBlank(b.age)) {
    const age = Number(b.age);
    if (!Number.isFinite(age) || age < 0 || age > 130) return fail('age must be between 0 and 130', 'age');
  }
  if (!isBlank(b.gender) && GENDERS.indexOf(String(b.gender)) === -1) {
    return fail('gender must be one of: ' + GENDERS.join(', '), 'gender');
  }
  if (!isBlank(b.blood_group) && String(b.blood_group).length > 8) {
    return fail('blood_group is too long', 'blood_group');
  }

  const vitals = b.vitals || {};
  for (const key of Object.keys(VITAL_BOUNDS)) {
    if (isBlank(vitals[key])) continue;
    const n = Number(vitals[key]);
    const [min, max] = VITAL_BOUNDS[key];
    if (!Number.isFinite(n)) return fail(key + ' must be a number', 'vitals.' + key);
    if (n < min || n > max) return fail(key + ' of ' + n + ' is outside the possible range ' + min + '–' + max, 'vitals.' + key);
  }

  if (!isBlank(b.eta_minutes)) {
    const eta = Number(b.eta_minutes);
    if (!Number.isFinite(eta) || eta < 0 || eta > 600) return fail('eta_minutes must be between 0 and 600', 'eta_minutes');
  }
  if (!isBlank(b.broadcast_radius_km)) {
    const r = Number(b.broadcast_radius_km);
    if (!Number.isFinite(r) || r <= 0 || r > 500) return fail('broadcast_radius_km must be between 1 and 500', 'broadcast_radius_km');
  }
  if (!isBlank(b.notes) && String(b.notes).length > MAX_NOTES) {
    return fail('notes must be ' + MAX_NOTES + ' characters or fewer', 'notes');
  }
  if (!isBlank(b.ambulance_id) && String(b.ambulance_id).length > MAX_UNIT_ID) {
    return fail('ambulance_id is too long', 'ambulance_id');
  }

  if (b.images !== undefined && b.images !== null) {
    if (!Array.isArray(b.images)) return fail('images must be a list', 'images');
    if (b.images.length > MAX_IMAGES) return fail('at most ' + MAX_IMAGES + ' photos may be attached', 'images');
    for (let i = 0; i < b.images.length; i++) {
      const img = b.images[i];
      if (typeof img !== 'string') return fail('images[' + i + '] is not an image', 'images');
      /* Only inline image data. A remote URL here would make the ER board
         fetch whatever an unauthenticated POST told it to. */
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(img)) {
        return fail('images[' + i + '] must be inline base64 image data', 'images');
      }
      if (img.length > MAX_IMAGE_BYTES) return fail('images[' + i + '] is too large', 'images');
    }
  }

  if (b.stroke_assessment !== undefined && b.stroke_assessment !== null) {
    const s = b.stroke_assessment;
    if (typeof s !== 'object' || Array.isArray(s)) return fail('stroke_assessment must be an object', 'stroke_assessment');
    if (!isBlank(s.onset_hours)) {
      const h = Number(s.onset_hours);
      if (!Number.isFinite(h) || h < 0 || h > 168) return fail('stroke_assessment.onset_hours must be between 0 and 168', 'stroke_assessment.onset_hours');
    }
  }

  if (!isBlank(b.client_request_id) && String(b.client_request_id).length > 100) {
    return fail('client_request_id is too long', 'client_request_id');
  }

  return { ok: true };
}

module.exports = {
  validateBroadcast, coord,
  MAX_IMAGES, MAX_IMAGE_BYTES, MAX_NOTES, MAX_UNIT_ID, VITAL_BOUNDS, GENDERS, ORIGIN_SOURCES,
};
