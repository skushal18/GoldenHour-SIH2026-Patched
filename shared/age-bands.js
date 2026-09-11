/* Display ranges follow the requested labels. Overlap boundaries map to the
   older group: 3 = child, 60 = senior. max is exclusive.
   Representative values preserve the existing numeric API contract. */
export const AGE_BANDS = [
  { id: 'baby',    label: 'Baby',           hint: '0 – 3',     value: 1,    min: 0,    max: 3 },
  { id: 'child',   label: 'Child',          hint: '3 – 17',    value: 8,    min: 3,    max: 18 },
  { id: 'adult',   label: 'Adult',          hint: '18 – 60',   value: 35,   min: 18,   max: 60 },
  { id: 'senior',  label: 'Senior citizen', hint: '60+',       value: 75,   min: 60,   max: 131 },
  { id: 'unknown', label: 'Unknown',        hint: 'Not known', value: null, min: null, max: null },
];

const UNKNOWN = AGE_BANDS[AGE_BANDS.length - 1];

export function ageBandById(id) {
  return AGE_BANDS.find(b => b.id === id) || null;
}

/** The band a stored age falls in — the inverse of the mapping above. */
export function describeAgeBand(age) {
  if (age === null || age === undefined ||
      !['number', 'string'].includes(typeof age) || String(age).trim() === '') return UNKNOWN;
  const n = Number(age);
  if (!Number.isFinite(n) || n < 0 || n > 130) return UNKNOWN;
  return AGE_BANDS.find(b => b.min !== null && n >= b.min && n < b.max) || UNKNOWN;
}

export function ageBandLabel(age) {
  return describeAgeBand(age).label;
}
