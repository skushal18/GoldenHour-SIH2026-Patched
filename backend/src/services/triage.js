/* ============================================================================
   Triage + geometry helpers.

   The ambulance app deliberately never sends a priority — the crew are busy
   and a colour on a phone is not a triage decision. The server computes it.
   ========================================================================== */

'use strict';

/** Great-circle distance between two points, in kilometres. */
function haversine(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => v === null || v === undefined || isNaN(Number(v)))) return null;
  const R = 6371;
  const toRad = d => (Number(d) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function roundKm(km) {
  return km === null || km === undefined ? null : Math.round(km * 10) / 10;
}

const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

/**
 * RED / AMBER / GREEN from the vitals block.
 * Null means "not measured" and must never be read as zero.
 */
function computePriority(vitals, consciousness, caseTypeId) {
  const v = vitals || {};
  const sbp = num(v.systolic_bp);
  const spo2 = num(v.spo2);
  const hr = num(v.heart_rate);
  const rr = num(v.resp_rate);

  if (Number(caseTypeId) === 9) return 'RED';            // cardiac arrest, CPR in progress
  if (consciousness === 'Unconscious') return 'RED';
  if (sbp !== null && sbp < 90) return 'RED';
  if (spo2 !== null && spo2 < 90) return 'RED';
  if (hr !== null && (hr > 150 || hr < 40)) return 'RED';
  if (rr !== null && (rr > 30 || rr < 8)) return 'RED';

  if (consciousness === 'Semi-Conscious') return 'AMBER';
  if (sbp !== null && sbp < 110) return 'AMBER';
  if (spo2 !== null && spo2 < 95) return 'AMBER';
  if (hr !== null && (hr > 120 || hr < 50)) return 'AMBER';
  if (rr !== null && (rr > 24 || rr < 10)) return 'AMBER';

  return 'GREEN';
}

/** Flags the ER board highlights at a glance. */
function criticalFlags(vitals, consciousness, caseTypeId) {
  const v = vitals || {};
  return {
    shock: num(v.systolic_bp) !== null && num(v.systolic_bp) < 90,
    hypoxia: num(v.spo2) !== null && num(v.spo2) < 90,
    low_gcs: consciousness === 'Unconscious',
    cardiac_arrest: Number(caseTypeId) === 9,
    airway_compromise: Number(caseTypeId) === 18
  };
}

const PRIORITY_TO_DB = { RED: 'CRITICAL', AMBER: 'HIGH', GREEN: 'MEDIUM' };

module.exports = { haversine, roundKm, computePriority, criticalFlags, PRIORITY_TO_DB };
