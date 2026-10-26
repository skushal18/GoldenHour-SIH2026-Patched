/* ============================================================================
   Hospital and administrator accounts — the central login database.

   One account = one username + password = one hospital's ER desk (role
   HOSPITAL_STAFF, hospital_id set), or a GoldenHour administrator (role
   SUPER_ADMIN, no hospital). Same surface for both drivers.

   Account shape:
     { account_id, username, password_hash, role, hospital_id, status,
       must_change_password, failed_attempts, locked_until, token_version,
       last_login_at, activation_code_hash, activation_expires_at,
       activated_at, created_by, created_at }

   status PENDING: created by the administrator with a one-time activation
   code; username and password are null until the hospital activates it and
   chooses both. Only the code's SHA-256 is stored.
   ========================================================================== */
'use strict';

const PUBLIC_FIELDS = ['account_id', 'username', 'role', 'hospital_id', 'status', 'must_change_password',
  'locked_until', 'last_login_at', 'activation_expires_at', 'activated_at', 'created_by', 'created_at'];

function publicView(a) {
  if (!a) return null;
  const out = {};
  for (const k of PUBLIC_FIELDS) out[k] = a[k] === undefined ? null : a[k];
  out.must_change_password = !!a.must_change_password;
  return out;
}

const UPDATABLE = ['username', 'password_hash', 'status', 'must_change_password', 'failed_attempts', 'locked_until',
  'token_version', 'last_login_at', 'hospital_id', 'activation_code_hash', 'activation_expires_at', 'activated_at'];
const DATES = ['locked_until', 'last_login_at', 'activation_expires_at', 'activated_at'];

function duplicate() { const e = new Error('Username taken'); e.code = 'DUPLICATE'; return e; }

function createMemoryAccounts() {
  const rows = new Map();
  let seq = 0;
  const clone = a => (a ? Object.assign({}, a) : null);
  return {
    driver: 'memory',
    async init() {},
    async count() { return rows.size; },
    async countByRole(role) { let n = 0; for (const a of rows.values()) if (a.role === role) n++; return n; },
    async findByUsername(username) {
      const u = String(username || '').toLowerCase();
      if (!u) return null;
      for (const a of rows.values()) if (a.username === u) return clone(a);
      return null;
    },
    async findById(id) { return clone(rows.get(Number(id))); },
    async findByActivationHash(hash) {
      if (!hash) return null;
      for (const a of rows.values()) if (a.activation_code_hash === hash) return clone(a);
      return null;
    },
    /* Single use: succeeds only while the account still holds this code. */
    async activate(id, hash, patch) {
      const a = rows.get(Number(id));
      if (!a || a.status !== 'PENDING' || a.activation_code_hash !== hash) return null;
      const u = String(patch.username).toLowerCase();
      for (const b of rows.values()) if (b !== a && b.username === u) throw duplicate();
      for (const k of UPDATABLE) if (k in patch) a[k] = patch[k];
      a.username = u;
      return clone(a);
    },
    async findByHospital(hospitalId) {
      const out = [];
      for (const a of rows.values()) if (a.hospital_id === Number(hospitalId)) out.push(clone(a));
      return out;
    },
    async list() { return Array.from(rows.values()).map(clone).sort((a, b) => a.account_id - b.account_id); },
    async activeHospitalIds() {
      const ids = new Set();
      for (const a of rows.values()) if (a.role === 'HOSPITAL_STAFF' && a.status === 'ACTIVE' && a.hospital_id) ids.add(a.hospital_id);
      return Array.from(ids);
    },
    async create(fields) {
      const username = fields.username == null ? null : String(fields.username).toLowerCase();
      if (username) for (const a of rows.values()) if (a.username === username) throw duplicate();
      seq += 1;
      const a = {
        account_id: seq, username, password_hash: fields.password_hash || null, role: fields.role,
        hospital_id: fields.hospital_id == null ? null : Number(fields.hospital_id),
        status: fields.status || 'ACTIVE', must_change_password: fields.must_change_password !== false,
        failed_attempts: 0, locked_until: null, token_version: 0, last_login_at: null,
        activation_code_hash: fields.activation_code_hash || null, activation_expires_at: fields.activation_expires_at || null,
        activated_at: null, created_by: fields.created_by || null, created_at: new Date().toISOString(),
      };
      rows.set(seq, a);
      return clone(a);
    },
    async update(id, patch) {
      const a = rows.get(Number(id));
      if (!a) return null;
      if (patch.username) {
        const u = String(patch.username).toLowerCase();
        for (const b of rows.values()) if (b !== a && b.username === u) throw duplicate();
        patch = Object.assign({}, patch, { username: u });
      }
      for (const k of UPDATABLE) if (k in patch) a[k] = patch[k];
      return clone(a);
    },
    async reset() { rows.clear(); seq = 0; },
  };
}

function createMysqlAccounts(pool) {
  const toIso = v => (v ? (v instanceof Date ? v.toISOString() : new Date(v).toISOString()) : null);
  const hydrate = r => r && ({
    account_id: r.account_id, username: r.username, password_hash: r.password_hash, role: r.role,
    hospital_id: r.hospital_id == null ? null : Number(r.hospital_id), status: r.status,
    must_change_password: !!r.must_change_password, failed_attempts: Number(r.failed_attempts) || 0,
    locked_until: toIso(r.locked_until), token_version: Number(r.token_version) || 0,
    last_login_at: toIso(r.last_login_at), activation_code_hash: r.activation_code_hash || null,
    activation_expires_at: toIso(r.activation_expires_at), activated_at: toIso(r.activated_at),
    created_by: r.created_by, created_at: toIso(r.created_at),
  });
  const asDate = v => (v ? new Date(v) : null);
  function assignments(patch) {
    const sets = [], vals = [];
    for (const k of UPDATABLE) {
      if (!(k in patch)) continue;
      let v = patch[k];
      if (DATES.indexOf(k) !== -1) v = asDate(v);
      if (k === 'must_change_password') v = v ? 1 : 0;
      sets.push('`' + k + '`=?'); vals.push(v);
    }
    return { sets, vals };
  }
  return {
    driver: 'mysql',
    async init() {},
    async count() { const [r] = await pool.query('SELECT COUNT(*) AS n FROM accounts'); return Number(r[0].n); },
    async countByRole(role) { const [r] = await pool.query('SELECT COUNT(*) AS n FROM accounts WHERE role=?', [role]); return Number(r[0].n); },
    async findByUsername(username) {
      const u = String(username || '').toLowerCase();
      if (!u) return null;
      const [r] = await pool.query('SELECT * FROM accounts WHERE username=? LIMIT 1', [u]);
      return hydrate(r[0]) || null;
    },
    async findById(id) { const [r] = await pool.query('SELECT * FROM accounts WHERE account_id=?', [Number(id)]); return hydrate(r[0]) || null; },
    async findByActivationHash(hash) {
      if (!hash) return null;
      const [r] = await pool.query('SELECT * FROM accounts WHERE activation_code_hash=? LIMIT 1', [String(hash)]);
      return hydrate(r[0]) || null;
    },
    /* Single use: the WHERE clause makes two concurrent activations of one code
       race to a single winner. */
    async activate(id, hash, patch) {
      const { sets, vals } = assignments(Object.assign({}, patch, { username: String(patch.username).toLowerCase() }));
      try {
        const [res] = await pool.query('UPDATE accounts SET ' + sets.join(', ') +
          " WHERE account_id=? AND status='PENDING' AND activation_code_hash=?", vals.concat(Number(id), String(hash)));
        if (!res.affectedRows) return null;
      } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') throw duplicate();
        throw err;
      }
      return this.findById(id);
    },
    async findByHospital(hospitalId) {
      const [r] = await pool.query('SELECT * FROM accounts WHERE hospital_id=?', [Number(hospitalId)]);
      return r.map(hydrate);
    },
    async list() { const [r] = await pool.query('SELECT * FROM accounts ORDER BY account_id'); return r.map(hydrate); },
    async activeHospitalIds() {
      const [r] = await pool.query("SELECT DISTINCT hospital_id FROM accounts WHERE role='HOSPITAL_STAFF' AND status='ACTIVE' AND hospital_id IS NOT NULL");
      return r.map(x => Number(x.hospital_id));
    },
    async create(f) {
      try {
        const [res] = await pool.query(
          'INSERT INTO accounts (username, password_hash, role, hospital_id, status, must_change_password, activation_code_hash, activation_expires_at, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
          [f.username == null ? null : String(f.username).toLowerCase(), f.password_hash || null, f.role,
            f.hospital_id == null ? null : Number(f.hospital_id), f.status || 'ACTIVE', f.must_change_password === false ? 0 : 1,
            f.activation_code_hash || null, asDate(f.activation_expires_at), f.created_by || null]);
        return this.findById(res.insertId);
      } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') throw duplicate();
        throw err;
      }
    },
    async update(id, patch) {
      const { sets, vals } = assignments(patch.username ? Object.assign({}, patch, { username: String(patch.username).toLowerCase() }) : patch);
      try {
        if (sets.length) await pool.query('UPDATE accounts SET ' + sets.join(', ') + ' WHERE account_id=?', vals.concat(Number(id)));
      } catch (err) {
        if (err && err.code === 'ER_DUP_ENTRY') throw duplicate();
        throw err;
      }
      return this.findById(id);
    },
  };
}

module.exports = { createMemoryAccounts, createMysqlAccounts, publicView };
