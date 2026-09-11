/* ============================================================================
   In-memory store — v5 extension.
   Adds: appendHistory(), position buffer via trackingService is separate.
   ========================================================================== */
'use strict';
function nowIso(){ return new Date().toISOString(); }
function createMemoryStore() {
  const broadcasts = new Map();
  let counter = 0;
  return {
    driver: 'memory',
    async init(){ return { driver:'memory' }; },
    /* Always healthy: the store is this process. What /health really reports
       for this driver is that nothing survives a restart. */
    async ping(){ return true; },
    async nextCaseCode(){ const y=new Date().getFullYear(); let c; do { counter+=1; c=`GH-${y}-${String(counter).padStart(4,'0')}`; } while (broadcasts.has(c)); return c; },
    async insertBroadcast(record){ broadcasts.set(record.case_code, record); return record; },
    async getBroadcast(code){ return broadcasts.get(code) || null; },
    async listForHospital(hospitalId, options){
      const opts = options || {}; const id = Number(hospitalId);
      const out = [];
      for (const r of broadcasts.values()){
        const t = r.targets.find(x => x.hospital_id === id); if (!t) continue;
        if (r.accepted_hospital_id && Number(r.accepted_hospital_id) !== id) continue;
        if (!opts.includeResolved && r.status === 'ARRIVED') continue;
        if (!opts.includeResolved && t.status === 'DECLINED') continue;
        out.push(r);
      }
      return out.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
    },
    async listAll(limit){ const all = Array.from(broadcasts.values()).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)); return limit?all.slice(0,limit):all; },
    async claim(code, hid){ const id=Number(hid); const r=broadcasts.get(code);
      if (!r) return { ok:false, reason:'NOT_FOUND', record:null };
      const t = r.targets.find(x=>x.hospital_id===id);
      if (!t) return { ok:false, reason:'NOT_TARGETED', record:r };
      if (r.status === 'ACCEPTED') return { ok:false, reason:'ALREADY_ACCEPTED', record:r };
      if (r.status !== 'PENDING') return { ok:false, reason:r.status, record:r };
      r.status='ACCEPTED'; r.accepted_hospital_id=id; r.accepted_at=nowIso();
      r.targets.forEach(x => x.status = x.hospital_id===id?'ACCEPTED':'CANCELLED');
      return { ok:true, record:r };
    },
    async decline(code, hid){ const id=Number(hid); const r=broadcasts.get(code);
      if (!r) return { ok:false, reason:'NOT_FOUND', record:null };
      const t = r.targets.find(x=>x.hospital_id===id); if (!t) return { ok:false, reason:'NOT_TARGETED', record:r };
      if (t.status==='PENDING') t.status='DECLINED';
      const anyLeft = r.targets.some(x=>x.status==='PENDING');
      if (!anyLeft && r.status==='PENDING') r.status='REJECTED';
      return { ok:true, record:r };
    },
    async cancel(code){ const r=broadcasts.get(code); if (!r) return { ok:false, reason:'NOT_FOUND', record:null };
      if (r.status==='PENDING'){ r.status='CANCELLED'; r.targets.forEach(x=>{ if(x.status==='PENDING') x.status='CANCELLED'; }); }
      return { ok:true, record:r };
    },
    async expireOverdue(){ const now=Date.now(); const out=[];
      for (const r of broadcasts.values()){ if (r.status!=='PENDING'||!r.expires_at) continue;
        if (new Date(r.expires_at).getTime()>now) continue;
        r.status='EXPIRED'; r.targets.forEach(x=>{ if (x.status==='PENDING') x.status='EXPIRED'; });
        out.push(r); }
      return out;
    },
    async updatePatientFields(code, patch){ const r=broadcasts.get(code); if (!r) return { ok:false, reason:'NOT_FOUND' };
      if (r.status!=='ACCEPTED' || r.arrived_at) return { ok:false, reason:'NOT_ACTIVE' };
      Object.assign(r, patch); return { ok:true, record:r }; },
    async appendHistory(code, history){ const r=broadcasts.get(code); if (!r) return; r.patient_history = history; },
    async markArrived(code){ const r=broadcasts.get(code); if (!r) return { ok:false, reason:'NOT_FOUND' };
      if (r.status==='ARRIVED') return { ok:true, record:r, already:true };
      if (r.status!=='ACCEPTED') return { ok:false, reason:'NOT_ACCEPTED' };
      r.status='ARRIVED'; r.arrived_at=nowIso();
      r.targets.forEach(x=>{ if (x.status==='ACCEPTED') x.status='CLOSED'; });
      return { ok:true, record:r };
    },
    async reset(){ broadcasts.clear(); counter=0; },
  };
}
module.exports = { createMemoryStore };
