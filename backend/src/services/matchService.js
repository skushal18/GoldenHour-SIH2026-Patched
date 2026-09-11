/* ============================================================================
   matchService — score per target hospital so the desk board can sort.

   Capacity ranks and warns. It never blocks a broadcast. Unknown capacity is
   penalised but NEVER excluded. Diversion does not remove a target.
   ========================================================================== */
'use strict';

const STALE_MIN = Number(process.env.CAPACITY_STALE_MINUTES || 60);

function needsFromCase(record) {
  const flags = record.critical_flags || {};
  const cat = record.case_category || 'OTHER';
  return {
    needs_ventilator: !!(flags.low_gcs || flags.hypoxia || flags.airway_compromise),
    needs_blood:      !!(flags.shock || cat === 'TRAUMA' || cat === 'OBSTETRIC'),
    needs_imaging:    ['STROKE', 'TRAUMA', 'NEURO', 'CARDIAC'].includes(cat),
    needs_ot:         ['TRAUMA', 'OBSTETRIC'].includes(cat),
    needs_cathlab:    cat === 'CARDIAC',
  };
}

function ageMinutes(updatedAt) {
  if (!updatedAt) return Infinity;
  const t = new Date(updatedAt).getTime();
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

function scoreFor(record, hospital, capacity) {
  let s = 100;
  const dist = (hospital.distance_km == null) ? 0 : hospital.distance_km;
  s -= dist * 4;

  if (capacity) {
    if (capacity.diversion_active) s -= 40;
    const needs = needsFromCase(record);
    if (needs.needs_ventilator && (capacity.ventilators_available|0) === 0) s -= 25;
    if (needs.needs_blood && !capacity.blood_available) s -= 15;
    if (needs.needs_imaging && !capacity.ct_available) s -= 10;
    if (needs.needs_ot && !capacity.ot_available) s -= 10;
    if (needs.needs_cathlab && !capacity.cathlab_available) s -= 10;
    s += Math.min(capacity.resus_bays_available|0, 4) * 3;
    if (ageMinutes(capacity.updated_at) > STALE_MIN) s -= 10;
  } else {
    // Unknown ≠ available. Penalise but don't remove.
    s -= 5;
  }
  return Math.round(s * 10) / 10;
}

function reasonsFor(record, hospital, capacity) {
  const out = [`${(hospital.distance_km || 0).toFixed(1)} km away`];
  if (!capacity) return out.concat(['Capacity unknown']);

  const needs = needsFromCase(record);
  const reasons = [];
  if (capacity.diversion_active) reasons.push('on diversion');
  if (needs.needs_ventilator && (capacity.ventilators_available|0) === 0) reasons.push('no ventilator available');
  if (needs.needs_blood && !capacity.blood_available) reasons.push('no blood available');
  if (needs.needs_imaging && !capacity.ct_available) reasons.push('no CT available');
  if (needs.needs_ot && !capacity.ot_available) reasons.push('no OT available');
  if (needs.needs_cathlab && !capacity.cathlab_available) reasons.push('no cath-lab available');
  if (ageMinutes(capacity.updated_at) > STALE_MIN) reasons.push('capacity stale');
  return out.concat(reasons);
}

module.exports = { scoreFor, reasonsFor, needsFromCase };
