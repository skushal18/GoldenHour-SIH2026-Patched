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
   Mirrors backend/src/data/caseTypes.js. Bundled so the APK can show a
   usable form with no server at all — a dead zone must not mean a blank
   dropdown. The server's list wins whenever one can be fetched. */

export const DEMO_CASE_TYPES = [
  { id: 1,  category: 'TRAUMA',    label: 'Road accident — multiple injuries', quick: true, short: 'Road accident' },
  { id: 2,  category: 'TRAUMA',    label: 'Head injury',                       quick: true, short: 'Head injury' },
  { id: 3,  category: 'TRAUMA',    label: 'Fall from height' },
  { id: 4,  category: 'TRAUMA',    label: 'Crush injury / amputation' },
  { id: 5,  category: 'TRAUMA',    label: 'Penetrating injury / stabbing' },
  { id: 6,  category: 'TRAUMA',    label: 'Major burns' },
  { id: 7,  category: 'TRAUMA',    label: 'Spinal injury suspected' },
  { id: 8,  category: 'CARDIAC',   label: 'Chest pain — suspected heart attack', quick: true, short: 'Chest pain' },
  { id: 9,  category: 'CARDIAC',   label: 'Cardiac arrest',                    quick: true, short: 'Cardiac arrest' },
  { id: 10, category: 'CARDIAC',   label: 'Irregular heartbeat / palpitations' },
  { id: 11, category: 'CARDIAC',   label: 'Heart failure / severe swelling' },
  { id: 12, category: 'STROKE',    label: 'Stroke — sudden weakness or slurred speech', quick: true, short: 'Stroke' },
  { id: 13, category: 'STROKE',    label: 'Transient ischaemic attack' },
  { id: 14, category: 'NEURO',     label: 'Seizure / fitting' },
  { id: 15, category: 'NEURO',     label: 'Unresponsive — cause unknown' },
  { id: 16, category: 'RESP',      label: 'Severe breathlessness',             quick: true, short: 'Breathless' },
  { id: 17, category: 'RESP',      label: 'Asthma attack' },
  { id: 18, category: 'RESP',      label: 'Choking / airway obstruction' },
  { id: 19, category: 'RESP',      label: 'Drowning / near-drowning' },
  { id: 20, category: 'OBSTETRIC', label: 'Labour / imminent delivery' },
  { id: 21, category: 'OBSTETRIC', label: 'Pregnancy complication / bleeding' },
  { id: 22, category: 'OBSTETRIC', label: 'Eclampsia / seizure in pregnancy' },
  { id: 23, category: 'PAEDIATRIC',label: 'Child — serious illness' },
  { id: 24, category: 'PAEDIATRIC',label: 'Child — injury' },
  { id: 25, category: 'PAEDIATRIC',label: 'Newborn in distress' },
  { id: 26, category: 'TOXIC',     label: 'Poisoning / overdose' },
  { id: 27, category: 'TOXIC',     label: 'Snake or animal bite' },
  { id: 28, category: 'TOXIC',     label: 'Severe allergic reaction' },
  { id: 29, category: 'TOXIC',     label: 'Smoke or gas inhalation' },
  { id: 30, category: 'MEDICAL',   label: 'Diabetic emergency' },
  { id: 31, category: 'MEDICAL',   label: 'Heavy bleeding — non-trauma' },
  { id: 32, category: 'MEDICAL',   label: 'Severe abdominal pain' },
  { id: 33, category: 'MEDICAL',   label: 'Severe infection / sepsis suspected' },
];

/* Order matters: the group a crew reaches for most often is first. */
export const CATEGORY_LABELS = [
  ['TRAUMA',     'Trauma & injury'],
  ['CARDIAC',    'Cardiac'],
  ['STROKE',     'Stroke'],
  ['NEURO',      'Neurological'],
  ['RESP',       'Breathing & airway'],
  ['OBSTETRIC',  'Pregnancy & birth'],
  ['PAEDIATRIC', 'Children'],
  ['TOXIC',      'Poisoning & bites'],
  ['MEDICAL',    'Other medical'],
];

export function categoryOf(caseTypes, id) {
  const n = toNumberOrNull(id);
  if (n === null) return null;
  const t = (caseTypes || []).find(c => Number(c.id) === n);
  return t ? t.category : null;
}
