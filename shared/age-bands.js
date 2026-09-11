/* ============================================================================
   Age bands — one definition, both front-ends.

   `age` on the wire is, and stays, a single number: the backend, the triage
   service, the validator and the ER board all already expect one. What
   changed is how a crew supplies it. A paramedic at a roadside rarely knows a
   patient's age and should not have to invent a number to get past a form,
   but they can always say which of these five a person is.

   So each band carries a representative value that travels, and
   `describeAgeBand()` maps any number back to the band it belongs to. Both
   front-ends display the band. That distinction matters clinically: showing a
   selected "Adult" to a doctor as the bare number 35 would present a
   precision that nobody ever measured.

   This file is imported by the ambulance app and by the ER desk board, so the
   two can never drift into disagreeing about what "Child" means.
   ========================================================================== */

export const AGE_BANDS = [
  { id: 'baby',    label: 'Baby',           hint: 'Under 2',   value: 1,    min: 0,    max: 1 },
  { id: 'child',   label: 'Child',          hint: '2 – 12',    value: 8,    min: 2,    max: 12 },
  { id: 'adult',   label: 'Adult',          hint: '13 – 64',   value: 35,   min: 13,   max: 64 },
  { id: 'senior',  label: 'Senior citizen', hint: '65+',       value: 75,   min: 65,   max: 130 },
  { id: 'unknown', label: 'Unknown',        hint: 'Not known', value: null, min: null, max: null },
];

const UNKNOWN = AGE_BANDS[AGE_BANDS.length - 1];

export function ageBandById(id) {
  return AGE_BANDS.find(b => b.id === id) || null;
}

/** The band a stored age falls in — the inverse of the mapping above. */
export function describeAgeBand(age) {
  if (age === null || age === undefined || age === '') return UNKNOWN;
  const n = Number(age);
  if (!Number.isFinite(n)) return UNKNOWN;
  return AGE_BANDS.find(b => b.min !== null && n >= b.min && n <= b.max) || AGE_BANDS[2];
}

export function ageBandLabel(age) {
  return describeAgeBand(age).label;
}
