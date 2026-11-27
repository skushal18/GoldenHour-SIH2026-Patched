/* ============================================================================
   Ambulances — one row per vehicle on GoldenHour, and its sign-in.

   Each ambulance signs in to the app on ONE phone with a one-time sign-in
   code from the administrator (only the code's SHA-256 is stored). Signing
   in records the phone it is installed on; the crew on shift is kept with
   the vehicle. token_version voids every token issued before a new code,
   a sign-out or a disable.

   Shape:
     { ambulance_id, registration, unit_name, operator, vehicle_type,
       base_location, phone, status ('PENDING'|'ACTIVE'|'DISABLED'),
       code_hash, code_expires_at, token_version, paired_at, last_seen_at,
       device {…}, crew [{name, role, phone}], crew_updated_at,
       created_by, created_at, updated_at }
   ========================================================================== */
'use strict';

const FIELDS = ['registration', 'unit_name', 'operator', 'vehicle_type', 'base_location', 'phone', 'status',
  'code_hash', 'code_expires_at', 'token_version', 'paired_at', 'last_seen_at', 'device', 'crew', 'crew_updated_at'];
const DATES = ['code_expires_at', 'paired_at', 'last_seen_at', 'crew_updated_at'];
const JSONS = ['device', 'crew'];

function duplicate() { const e = new Error('Registration already on GoldenHour'); e.code = 'DUPLICATE'; return e; }

function createMemoryAmbulances() {
  const rows = new Map();
  let seq = 0;
  const clone = a => (a ? JSON.parse(JSON.stringify(a)) : null);
  return {
    driver: 'memory',
    async init() {},
    async list() { return Array.from(rows.values()).map(clone).sort((a, b) => a.ambulance_id - b.ambulance_id); },
    async findById(id) { return clone(rows.get(Number(id))); },
    async findByRegistration(reg) {
      for (const a of rows.values()) if (a.registration === reg) return clone(a);
      return null;
    },
    async findByCodeHash(hash) {
      if (!hash) return null;
      for (const a of rows.values()) if (a.code_hash === hash) return clone(a);
      return null;
    },
    async create(f) {
      for (const a of rows.values()) if (a.registration === f.registration) throw duplicate();
      const now = new Date().toISOString();
      const row = Object.assign({ ambulance_id: ++seq, status: 'PENDING', token_version: 0, device: null, crew: [], paired_at: null,
        last_seen_at: null, crew_updated_at: null, code_hash: null, code_expires_at: null, created_at: now, updated_at: now }, f);
      rows.set(row.ambulance_id, row);
      return clone(row);
    },
    async update(id, patch) {
      const a = rows.get(Number(id));
      if (!a) return null;
      if (patch.registration && patch.registration !== a.registration) {
        for (const b of rows.values()) if (b.registration === patch.registration && b.ambulance_id !== a.ambulance_id) throw duplicate();
      }
      for (const k of FIELDS) if (k in patch) a[k] = patch[k];
      a.updated_at = new Date().toISOString();
      return clone(a);
    },
    /* Single use: only succeeds while the row still holds this code. */
    async pair(id, hash, patch) {
      const a = rows.get(Number(id));
      if (!a || a.code_hash !== hash || a.status !== 'PENDING') return null;
      return this.update(id, patch);
    },
    async reset() { rows.clear(); seq = 0; },
  };
}

function createMysqlAmbulances(pool) {
  const toIso = v => (v ? (v instanceof Date ? v.toISOString() : new Date(v).toISOString()) : null);
  const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } };
  const hydrate = r => r && ({
    ambulance_id: Number(r.ambulance_id), registration: r.registration, unit_name: r.unit_name, operator: r.operator,
    vehicle_type: r.vehicle_type, base_location: r.base_location, phone: r.phone, status: r.status,
    code_hash: r.code_hash || null, code_expires_at: toIso(r.code_expires_at), token_version: Number(r.token_version) || 0,
    paired_at: toIso(r.paired_at), last_seen_at: toIso(r.last_seen_at), device: parse(r.device), crew: parse(r.crew) || [],
    crew_updated_at: toIso(r.crew_updated_at), created_by: r.created_by, created_at: toIso(r.created_at), updated_at: toIso(r.updated_at),
  });
  function assignments(patch) {
    const sets = [], vals = [];
    for (const k of FIELDS) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (DATES.indexOf(k) !== -1) v = v ? new Date(v) : null;
      if (JSONS.indexOf(k) !== -1) v = v == null ? null : JSON.stringify(v);
      sets.push('`' + k + '`=?'); vals.push(v);
    }
    return { sets, vals };
  }
  const dupe = err => { if (err && err.code === 'ER_DUP_ENTRY') throw duplicate(); throw err; };
  return {
    driver: 'mysql',
    async init() {},
    async list() { const [r] = await pool.query('SELECT * FROM ambulances ORDER BY ambulance_id'); return r.map(hydrate); },
    async findById(id) { const [r] = await pool.query('SELECT * FROM ambulances WHERE ambulance_id=?', [Number(id)]); return hydrate(r[0]) || null; },
    async findByRegistration(reg) { const [r] = await pool.query('SELECT * FROM ambulances WHERE registration=? LIMIT 1', [String(reg)]); return hydrate(r[0]) || null; },
    async findByCodeHash(hash) {
      if (!hash) return null;
      const [r] = await pool.query('SELECT * FROM ambulances WHERE code_hash=? LIMIT 1', [String(hash)]);
      return hydrate(r[0]) || null;
    },
    async create(f) {
      try {
        const [res] = await pool.query(
          'INSERT INTO ambulances (registration, unit_name, operator, vehicle_type, base_location, phone, status, code_hash, code_expires_at, crew, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [f.registration, f.unit_name || null, f.operator || null, f.vehicle_type || null, f.base_location || null, f.phone || null,
            f.status || 'PENDING', f.code_hash || null, f.code_expires_at ? new Date(f.code_expires_at) : null, JSON.stringify(f.crew || []), f.created_by || null]);
        return this.findById(res.insertId);
      } catch (err) { return dupe(err); }
    },
    async update(id, patch) {
      const { sets, vals } = assignments(patch);
      try { if (sets.length) await pool.query('UPDATE ambulances SET ' + sets.join(', ') + ' WHERE ambulance_id=?', vals.concat(Number(id))); }
      catch (err) { return dupe(err); }
      return this.findById(id);
    },
    /* Single use: two phones racing with one code get one winner. */
    async pair(id, hash, patch) {
      const { sets, vals } = assignments(patch);
      const [res] = await pool.query('UPDATE ambulances SET ' + sets.join(', ') + " WHERE ambulance_id=? AND status='PENDING' AND code_hash=?",
        vals.concat(Number(id), String(hash)));
      return res.affectedRows ? this.findById(id) : null;
    },
  };
}

module.exports = { createMemoryAmbulances, createMysqlAmbulances };
