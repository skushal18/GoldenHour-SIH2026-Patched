/* ============================================================================
   MySQL store — v5 extension. Same surface as memoryStore plus appendHistory.
   ========================================================================== */
'use strict';
const { PRIORITY_TO_DB } = require('../services/triage');
function parseJson(v, fb){ if (v==null) return fb; if (typeof v==='object') return v;
  try{ return JSON.parse(v); } catch(_){ return fb; }
}
function toIso(v){ if (!v) return null; return v instanceof Date ? v.toISOString() : new Date(v).toISOString(); }

function createMysqlStore(pool) {
  function hydrate(row, targetRows){
    const snapshot = parseJson(row.payload, {});
    return {
      case_code: row.case_code, case_id: row.legacy_case_id||null, status: row.status,
      priority: row.priority, created_at: toIso(row.created_at), expires_at: toIso(row.expires_at),
      accepted_hospital_id: row.accepted_hospital_id||null, accepted_at: toIso(row.accepted_at),
      arrived_at: toIso(row.arrived_at), ...snapshot,
      targets: (targetRows||[]).map(t => ({
        hospital_id:t.hospital_id, name:t.hospital_name, contact:t.hospital_contact,
        lat: t.hospital_lat==null?null:Number(t.hospital_lat),
        lng: t.hospital_lng==null?null:Number(t.hospital_lng),
        distance_km: t.distance_km==null?null:Number(t.distance_km), status:t.status
      }))
    };
  }
  async function loadTargets(conn, code){
    const [rows] = await conn.query('SELECT * FROM broadcast_targets WHERE case_code = ? ORDER BY distance_km IS NULL, distance_km ASC, hospital_id ASC', [code]);
    return rows;
  }
  async function loadOne(pool, code){ const [rows]=await pool.query('SELECT * FROM broadcasts WHERE case_code=?',[code]); return rows.length ? hydrate(rows[0], await loadTargets(pool,code)) : null; }

  return {
    driver:'mysql',
    async init(){ const c=await pool.getConnection(); c.release(); return { driver:'mysql' }; },
    /* Used by /health. A pool that hands out a connection but cannot answer
       SELECT 1 is a database that has gone away underneath us — which is
       exactly the state a load balancer needs to see as unhealthy. */
    async ping(){
      try { const [rows] = await pool.query('SELECT 1 AS ok'); return !!(rows && rows.length); }
      catch(_){ return false; }
    },
    async nextCaseCode(){ const y=new Date().getFullYear();
      const [rows]=await pool.query('SELECT COUNT(*) AS n FROM broadcasts WHERE YEAR(created_at)=?',[y]);
      let n=Number(rows[0].n)+1;
      for (let i=0;i<50;i++){ const code=`GH-${y}-${String(n).padStart(4,'0')}`;
        const [clash]=await pool.query('SELECT case_code FROM broadcasts WHERE case_code=?',[code]); if (!clash.length) return code; n++; }
      throw new Error('Could not allocate case code'); },
    async insertBroadcast(record){ const conn=await pool.getConnection();
      try{ await conn.beginTransaction();
        const { targets, ...snap } = record;
        delete snap.status; delete snap.priority; delete snap.created_at; delete snap.expires_at;
        delete snap.accepted_hospital_id; delete snap.accepted_at; delete snap.case_id;
        await conn.query(`INSERT INTO broadcasts (case_code, status, priority, payload, expires_at) VALUES (?, 'PENDING', ?, ?, ?)`,
          [record.case_code, record.priority, JSON.stringify(snap), new Date(record.expires_at)]);
        delete snap.arrived_at; delete snap.last_patient_updated_at;
        for (const t of targets){ await conn.query(`INSERT INTO broadcast_targets (case_code, hospital_id, hospital_name, hospital_contact, hospital_lat, hospital_lng, distance_km, status) VALUES (?,?,?,?,?,?,?,'PENDING')`,
          [record.case_code, t.hospital_id, t.name, t.contact||null, t.lat, t.lng, t.distance_km]); }
        await conn.commit();
      }catch(e){ await conn.rollback(); conn.release(); throw e; } finally{ conn.release(); }
      return record; },
    async getBroadcast(code){ return loadOne(pool, code); },
    async listForHospital(hospitalId, options){
      const opts=options||{};
      const [rows]=await pool.query(`SELECT b.*, t.status AS target_status FROM broadcasts b JOIN broadcast_targets t ON t.case_code=b.case_code WHERE t.hospital_id=? ORDER BY b.created_at DESC LIMIT 100`,[Number(hospitalId)]);
      const keep=rows.filter(r=>{
        if (r.accepted_hospital_id && Number(r.accepted_hospital_id)!==Number(hospitalId)) return false;
        if (opts.includeResolved) return true;
        if (r.status==='ARRIVED') return false;
        if (r.target_status==='DECLINED') return false;
        return r.status==='PENDING' || r.status==='ACCEPTED';
      });
      const out=[]; for (const row of keep) out.push(hydrate(row, await loadTargets(pool, row.case_code)));
      return out;
    },
    async listAll(limit){ const [rows]=await pool.query('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT ?', [Number(limit)||50]);
      const out=[]; for (const row of rows) out.push(hydrate(row, await loadTargets(pool, row.case_code))); return out; },
    async claim(code, hid){ const id=Number(hid); const conn=await pool.getConnection();
      try{ await conn.beginTransaction();
        const [trows]=await conn.query('SELECT * FROM broadcast_targets WHERE case_code=? AND hospital_id=? FOR UPDATE', [code,id]);
        if (!trows.length){ const [exists]=await conn.query('SELECT case_code FROM broadcasts WHERE case_code=?',[code]); await conn.commit(); return { ok:false, reason:exists.length?'NOT_TARGETED':'NOT_FOUND', record: await loadOne(pool,code) }; }
        const [u]=await conn.query(`UPDATE broadcasts SET status='ACCEPTED', accepted_hospital_id=?, accepted_at=NOW() WHERE case_code=? AND status='PENDING'`,[id,code]);
        if (!u.affectedRows){ const [cur]=await conn.query('SELECT status FROM broadcasts WHERE case_code=?',[code]); await conn.commit();
          return { ok:false, reason: cur.length?(cur[0].status==='ACCEPTED'?'ALREADY_ACCEPTED':cur[0].status):'NOT_FOUND', record: await loadOne(pool,code) }; }
        await conn.query(`UPDATE broadcast_targets SET status=CASE WHEN hospital_id=? THEN 'ACCEPTED' ELSE 'CANCELLED' END WHERE case_code=?`,[id,code]);
        await conn.commit();
      }catch(e){ await conn.rollback(); conn.release(); throw e; } finally{ conn.release(); }
      return { ok:true, record: await loadOne(pool, code) };
    },
    async decline(code, hid){ const id=Number(hid);
      await pool.query(`UPDATE broadcast_targets SET status='DECLINED' WHERE case_code=? AND hospital_id=? AND status='PENDING'`,[code,id]);
      const [left]=await pool.query(`SELECT COUNT(*) AS n FROM broadcast_targets WHERE case_code=? AND status='PENDING'`,[code]);
      if (!Number(left[0].n)) await pool.query(`UPDATE broadcasts SET status='REJECTED' WHERE case_code=? AND status='PENDING'`,[code]);
      const r=await loadOne(pool, code); return r?{ ok:true, record:r }:{ ok:false, reason:'NOT_FOUND', record:null };
    },
    async cancel(code){ await pool.query(`UPDATE broadcasts SET status='CANCELLED' WHERE case_code=? AND status='PENDING'`,[code]);
      await pool.query(`UPDATE broadcast_targets SET status='CANCELLED' WHERE case_code=? AND status='PENDING'`,[code]);
      const r=await loadOne(pool,code); return r?{ ok:true, record:r }:{ ok:false, reason:'NOT_FOUND', record:null }; },
    async expireOverdue(){ const [due]=await pool.query(`SELECT case_code FROM broadcasts WHERE status='PENDING' AND expires_at IS NOT NULL AND expires_at <= NOW()`);
      const out=[]; for (const row of due){ const [u]=await pool.query(`UPDATE broadcasts SET status='EXPIRED' WHERE case_code=? AND status='PENDING'`,[row.case_code]);
        if (!u.affectedRows) continue;
        await pool.query(`UPDATE broadcast_targets SET status='EXPIRED' WHERE case_code=? AND status='PENDING'`,[row.case_code]);
        out.push(await loadOne(pool, row.case_code));
      } return out;
    },
    async updatePatientFields(code, patch){ const conn=await pool.getConnection();
      try{ await conn.beginTransaction();
        const [cur]=await conn.query('SELECT payload, status, arrived_at FROM broadcasts WHERE case_code=? FOR UPDATE',[code]);
        if (!cur.length) { await conn.commit(); return { ok:false, reason:'NOT_FOUND' }; }
        if (cur[0].status!=='ACCEPTED' || cur[0].arrived_at) { await conn.commit(); return { ok:false, reason:'NOT_ACTIVE' }; }
        const snap = parseJson(cur[0].payload, {}); snap.patient = patch.patient||snap.patient||{};
        if ('notes' in patch) snap.notes = patch.notes;
        if ('last_patient_updated_at' in patch) snap.last_patient_updated_at = patch.last_patient_updated_at;
        await conn.query('UPDATE broadcasts SET payload=? WHERE case_code=?',[JSON.stringify(snap), code]);
        await conn.commit();
      }catch(e){ await conn.rollback(); throw e; } finally{ conn.release(); }
      return { ok:true, record: await loadOne(pool, code) };
    },
    async appendHistory(code, history){ const conn=await pool.getConnection();
      try{ await conn.beginTransaction();
        const [cur]=await conn.query('SELECT payload FROM broadcasts WHERE case_code=? FOR UPDATE',[code]);
        if (!cur.length) { await conn.commit(); return; }
        const snap = parseJson(cur[0].payload, {}); snap.patient_history = history;
        await conn.query('UPDATE broadcasts SET payload=? WHERE case_code=?',[JSON.stringify(snap), code]);
        await conn.commit();
      }catch(e){ await conn.rollback(); } finally{ conn.release(); }
    },
    async markArrived(code){ const conn=await pool.getConnection();
      try{ await conn.beginTransaction();
        const [u]=await conn.query(`UPDATE broadcasts SET status='ARRIVED', arrived_at=NOW() WHERE case_code=? AND status='ACCEPTED'`,[code]);
        await conn.commit();
        if (!u.affectedRows){ const r=await loadOne(pool,code); return r && r.status==='ARRIVED' ? { ok:true, record:r, already:true } : { ok:false, reason:'NOT_ACCEPTED' }; }
      }catch(e){ await conn.rollback(); throw e; } finally{ conn.release(); }
      return { ok:true, record: await loadOne(pool, code) };
    },
  };
}
module.exports = { createMysqlStore };
