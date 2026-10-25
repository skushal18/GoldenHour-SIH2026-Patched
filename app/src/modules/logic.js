/* ============================================================================
   GoldenHour — pure domain logic for the ambulance app.

   Nothing in this file touches the DOM, the network, or any global. That is
   deliberate: every rule a paramedic depends on is unit-testable in plain
   Node, and the DOM layer in ui.js is left with nothing but wiring.
   ========================================================================== */

export const MAX_IMAGES = 4;

/* ── Coercion ───────────────────────────────────────────────────────────────
   The one rule that matters: "0" is a real, dangerous reading (a glucose of
   zero, a systolic of zero) and must never collapse to null. Blank must. */

export function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toTextOrNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/* ── Vital bands ────────────────────────────────────────────────────────────
   Each vital has a plausible measurement range and a set of bands inside it.
   A value outside the range is NOT a band — it is a typo, and saying
   "critical" for a typo trains the crew to ignore the colour. */

const VITALS = {
  systolicBp:  { range: [40, 300], bands: [[90, 'critical'], [100, 'caution'], [140, 'good'], [180, 'caution'], [Infinity, 'critical']] },
  diastolicBp: { range: [20, 200], bands: [[50, 'critical'], [60, 'caution'], [90, 'good'], [120, 'caution'], [Infinity, 'critical']] },
  heartRate:   { range: [20, 300], bands: [[50, 'critical'], [60, 'caution'], [101, 'good'], [121, 'caution'], [Infinity, 'critical']] },
  respRate:    { range: [4, 80],   bands: [[9, 'critical'], [12, 'caution'], [21, 'good'], [30, 'caution'], [Infinity, 'critical']] },
  spo2:        { range: [50, 100], bands: [[90, 'critical'], [95, 'caution'], [Infinity, 'good']] },
  glucose:     { range: [10, 900], bands: [[60, 'critical'], [70, 'caution'], [141, 'good'], [250, 'caution'], [Infinity, 'critical']] },
};

export const VITAL_KEYS = Object.keys(VITALS);

/** The band a reading falls in, or null for blank / non-numeric / impossible. */
export function getBandFor(key, value) {
  const spec = VITALS[key];
  if (!spec) return null;
  const n = toNumberOrNull(value);
  if (n === null) return null;
  if (n < spec.range[0] || n > spec.range[1]) return null;
  for (const [ceiling, band] of spec.bands) if (n < ceiling) return band;
  return null;
}

/** True only for a value that was actually entered and is outside the range. */
export function isOutOfRange(key, value) {
  const spec = VITALS[key];
  if (!spec) return false;
  const n = toNumberOrNull(value);
  if (n === null) return false;
  return n < spec.range[0] || n > spec.range[1];
}

export function vitalRange(key) {
  const spec = VITALS[key];
  return spec ? spec.range.slice() : null;
}

/* ── Age bands ──────────────────────────────────────────────────────────────
   Defined in shared/age-bands.js and re-exported here, because the ER desk
   board needs exactly the same mapping and two copies of a clinical banding
   is how they end up disagreeing about what "Child" means. */

export { AGE_BANDS, ageBandById, describeAgeBand, ageBandLabel } from '../../../shared/age-bands.js';

/* ── Resource needs ─────────────────────────────────────────────────────────
   Derived, never asked for. A crew doing compressions cannot fill in a
   resource checklist, so the system infers what the receiving ER will need
   and lets the crew override with one tap. */

export function deriveNeeds(form) {
  const f = form || {};
  const v = f.vitals || {};
  const needs = { ventilator: false, blood: false, imaging: false, ot: false, cathlab: false };
  const spo2 = toNumberOrNull(v.spo2);
  const sbp = toNumberOrNull(v.systolic_bp);

  if (f.consciousness === 'Unconscious') needs.ventilator = true;
  if (spo2 !== null && spo2 < 90) needs.ventilator = true;
  if (sbp !== null && sbp < 90) needs.blood = true;

  switch (f.category) {
    case 'TRAUMA':
    case 'OBSTETRIC':
      needs.blood = true; needs.imaging = true; needs.ot = true; break;
    case 'STROKE':
    case 'NEURO':
      needs.imaging = true; break;
    case 'CARDIAC':
      needs.imaging = true; needs.cathlab = true; break;
    default: break;
  }
  return needs;
}

/* ── Payload ────────────────────────────────────────────────────────────────
   The exact body the backend's POST /api/v1/requests expects.

   Three invariants worth naming, because each one was a bug once:
     * No `priority` field. Triage is the server's job — a crew under
       pressure must not be asked to grade their own patient.
     * No hospital list. The crew broadcasts; hospitals answer.
     * `origin.source` always travels, and a hand-typed position never
       carries an accuracy figure. An ER reads "2 km away" very differently
       when the 2 km was measured than when it was guessed. */

export function buildPayload(form) {
  const f = form || {};
  const source = toTextOrNull(f.originSource);
  const isMeasured = source === 'gps' || source === 'last-known';

  const payload = {
    case_type_id: toNumberOrNull(f.caseTypeId),
    age: toNumberOrNull(f.age),
    gender: toTextOrNull(f.gender) || 'U',
    blood_group: toTextOrNull(f.bloodGroup),
    vitals: {
      systolic_bp: toNumberOrNull(f.systolicBp),
      diastolic_bp: toNumberOrNull(f.diastolicBp),
      heart_rate: toNumberOrNull(f.heartRate),
      resp_rate: toNumberOrNull(f.respRate),
      spo2: toNumberOrNull(f.spo2),
      glucose: toNumberOrNull(f.glucose),
    },
    consciousness: toTextOrNull(f.consciousness),
    origin: {
      lat: toNumberOrNull(f.lat),
      lng: toNumberOrNull(f.lng),
      accuracy_m: isMeasured ? toNumberOrNull(f.accuracy) : null,
      source: source,
    },
    broadcast_radius_km: toNumberOrNull(f.radiusKm) === null ? 15 : toNumberOrNull(f.radiusKm),
    images: Array.isArray(f.images) ? f.images.slice(0, MAX_IMAGES) : [],
    eta_minutes: toNumberOrNull(f.eta),
    notes: toTextOrNull(f.notes),
    ambulance_id: toTextOrNull(f.ambulanceId),
  };

  /* FAST answers are meaningless outside a stroke case, and shipping them
     anyway invites the ER to read a trauma case as a stroke. */
  if (f.category === 'STROKE') {
    payload.stroke_assessment = {
      face: !!f.face,
      arm: !!f.arm,
      speech: !!f.speech,
      onset_hours: toNumberOrNull(f.onsetHours),
    };
  }
  return payload;
}

/* ── Reference data ─────────────────────────────────────────────────────────
   An exact copy of backend/src/data/caseTypes.js — same ids, same labels,
   same categories — bundled so the APK can show a usable form with no
   server at all. It MUST stay identical: a case is sent by id, so a list
   that drifts sends one emergency and the hospital reads another (the v5
   copy had different ids from 4 onwards — "Eclampsia" arrived as "Heat
   stroke"). app/tests/test.js fails the build if the two lists differ, and
   the server refuses an id it does not know. The server's list wins
   whenever one can be fetched. */

export const DEMO_CASE_TYPES = [
  { id: 1, category: 'TRAUMA', label: 'Road accident — multiple injuries', quick: true, short: 'Road accident' },
  { id: 2, category: 'TRAUMA', label: 'Head injury', quick: true, short: 'Head injury' },
  { id: 3, category: 'TRAUMA', label: 'Fall from height' },
  { id: 4, category: 'TRAUMA', label: 'Stab / gunshot / penetrating wound' },
  { id: 5, category: 'TRAUMA', label: 'Major burns' },
  { id: 6, category: 'TRAUMA', label: 'Crush injury / amputation' },
  { id: 7, category: 'TRAUMA', label: 'Suspected spinal injury' },
  { id: 8, category: 'CARDIAC', label: 'Chest pain / suspected heart attack', quick: true, short: 'Chest pain' },
  { id: 9, category: 'CARDIAC', label: 'Cardiac arrest — CPR in progress', quick: true, short: 'Cardiac arrest' },
  { id: 10, category: 'CARDIAC', label: 'Irregular heartbeat / arrhythmia' },
  { id: 11, category: 'CARDIAC', label: 'Heart failure / fluid in lungs' },
  { id: 12, category: 'STROKE', label: 'Stroke / sudden weakness or slurred speech', quick: true, short: 'Stroke' },
  { id: 13, category: 'STROKE', label: 'Suspected TIA' },
  { id: 14, category: 'NEURO', label: 'Seizure / fits' },
  { id: 15, category: 'NEURO', label: 'Unresponsive — cause unknown' },
  { id: 16, category: 'RESP', label: 'Severe breathlessness / asthma attack', quick: true, short: 'Breathless' },
  { id: 17, category: 'RESP', label: 'COPD flare-up' },
  { id: 18, category: 'RESP', label: 'Choking / blocked airway' },
  { id: 19, category: 'RESP', label: 'Drowning' },
  { id: 20, category: 'METABOLIC', label: 'Low blood sugar' },
  { id: 21, category: 'METABOLIC', label: 'High blood sugar / DKA' },
  { id: 22, category: 'METABOLIC', label: 'Heat stroke' },
  { id: 23, category: 'OBSTETRIC', label: 'Labour / delivery imminent' },
  { id: 24, category: 'OBSTETRIC', label: 'Pregnancy emergency' },
  { id: 25, category: 'OBSTETRIC', label: 'Newborn in distress' },
  { id: 26, category: 'PAEDIATRIC', label: 'Sick child' },
  { id: 27, category: 'PAEDIATRIC', label: 'Injured child' },
  { id: 28, category: 'POISONING', label: 'Poisoning / overdose' },
  { id: 29, category: 'POISONING', label: 'Snake bite / animal bite' },
  { id: 30, category: 'ALLERGY', label: 'Severe allergic reaction (anaphylaxis)' },
  { id: 31, category: 'OTHER', label: 'Heavy bleeding (not from injury)' },
  { id: 32, category: 'OTHER', label: 'Psychiatric emergency' },
  { id: 33, category: 'OTHER', label: 'Other emergency' },
];

/* Order matters: the group a crew reaches for most often is first. */
export const CATEGORY_LABELS = [
  ['TRAUMA',     'Trauma & injury'],
  ['CARDIAC',    'Cardiac'],
  ['STROKE',     'Stroke'],
  ['NEURO',      'Neurological'],
  ['RESP',       'Breathing & airway'],
  ['METABOLIC',  'Sugar, heat & metabolic'],
  ['OBSTETRIC',  'Pregnancy & birth'],
  ['PAEDIATRIC', 'Children'],
  ['POISONING',  'Poisoning & bites'],
  ['ALLERGY',    'Allergy'],
  ['OTHER',      'Other emergencies'],
];

export function categoryOf(caseTypes, id) {
  const n = toNumberOrNull(id);
  if (n === null) return null;
  const t = (caseTypes || []).find(c => Number(c.id) === n);
  return t ? t.category : null;
}
