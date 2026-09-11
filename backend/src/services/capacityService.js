/* ============================================================================
   capacityService — desk-side capacity strip.

   In-memory persistence by hospital_id; capacity:changed broadcasts to every
   hospital so the "Network status" sidebar reflects reality.
   ========================================================================== */
'use strict';

const caps = new Map();        // hospital_id -> capacity record
let listeners = [];            // (event, payload) => void

function nowIso(){ return new Date().toISOString(); }

function get(hospitalId){
  return caps.get(Number(hospitalId)) || null;
}

function all(){
  return Array.from(caps.entries()).map(([id, c]) => ({ hospital_id: id, ...c }));
}

function upsert(hospitalId, patch){
  const id = Number(hospitalId);
  const prev = caps.get(id) || {};
  const next = {
    resus_bays_available: Number(patch.resus_bays_available ?? prev.resus_bays_available ?? 0),
    ct_available: patch.ct_available !== undefined ? !!patch.ct_available : (prev.ct_available !== false),
    ot_available: patch.ot_available !== undefined ? !!patch.ot_available : (prev.ot_available !== false),
    blood_available: patch.blood_available !== undefined ? !!patch.blood_available : (prev.blood_available !== false),
    ventilators_available: Number(patch.ventilators_available ?? prev.ventilators_available ?? 0),
    cathlab_available: patch.cathlab_available !== undefined ? !!patch.cathlab_available : (prev.cathlab_available !== false),
    diversion_active: !!patch.diversion_active,
    updated_at: nowIso(),
  };
  caps.set(id, next);
  emit('capacity:changed', { hospital_id: id, capacity: next, at: next.updated_at });
  return next;
}

function emit(evt, payload){
  for (const l of listeners){ try{ l(evt, payload); } catch(_){ } }
}
function onListener(fn){ listeners.push(fn); }
function clearListeners(){ listeners = []; }

function minutesSince(updatedAt){
  if (!updatedAt) return Infinity;
  const t = new Date(updatedAt).getTime();
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

module.exports = { get, all, upsert, onListener, clearListeners, minutesSince };
