/* ============================================================================
   The GoldenHour hospital network — the hospitals ambulances are matched to.

   The source of truth is the `hospitals` table in MySQL (RDS in production).
   It is read once at boot into an in-memory index (hospitalIndex) and every
   change made through this module goes to the table first and the index
   second, so a radius query per broadcast never needs a database round trip
   and the index can never hold a hospital the table does not.

   The table starts with the 100 hospitals in data/hospitals/
   network_hospitals.csv (seedNetwork, run by scripts/seed-hospitals.js); the
   administrator adds more from the all-India catalogue (catalogueService).

   Under the memory store (demos, tests) the same 100 are loaded straight
   from the catalogue, so a demo sees the same network production does.

   A hospital with active = 0 stays in the table (its logins and history
   still point at it) but is never offered a case.
   ========================================================================== */
'use strict';

const { createIndex, haversine } = require('./hospitalIndex');
const catalogue = require('./catalogueService');

const index = createIndex();
let pool = null;
let source = null;          // 'mysql' | 'memory' | 'fixture'

const COLUMNS = ['id', 'source_id', 'name', 'state', 'district', 'pincode', 'address', 'phone', 'ownership',
  'care_type', 'specialties', 'beds', 'emergency_likely', 'lat', 'lng', 'coord_source', 'active'];

function fromRow(r) {
  const num = v => (v == null || v === '' ? null : Number(v));
  return {
    hospital_id: Number(r.id), source_id: r.source_id || null, name: r.name, state: r.state || '', district: r.district || '',
    pincode: r.pincode || null, address: r.address || null, contact: r.phone || null, ownership: r.ownership || null,
    care_type: r.care_type || null, specialties: r.specialties || null, beds: num(r.beds),
    emergency_likely: !!Number(r.emergency_likely), lat: num(r.lat), lng: num(r.lng),
    coord_source: r.coord_source || null, active: r.active === undefined ? true : !!Number(r.active),
  };
}

function toRow(h) {
  const cut = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
  return [Number(h.hospital_id), cut(h.source_id, 40), cut(h.name, 255), cut(h.state, 80), cut(h.district, 120),
    cut(h.pincode, 10), cut(h.address, 500), cut(h.contact, 120), cut(h.ownership, 60), cut(h.care_type, 80),
    cut(h.specialties, 255), h.beds == null ? null : Number(h.beds), h.emergency_likely ? 1 : 0,
    h.lat == null ? null : Number(h.lat), h.lng == null ? null : Number(h.lng), cut(h.coord_source, 10),
    h.active === false ? 0 : 1];
}

const INSERT_IGNORE = 'INSERT IGNORE INTO hospitals (' + COLUMNS.join(', ') + ') VALUES ?';

/* ── Loading ─────────────────────────────────────────────────────────────── */

/** MySQL is live: read the network from the hospitals table. */
async function attach(mysqlPool) {
  pool = mysqlPool;
  source = 'mysql';
  return reload();
}

async function reload() {
  if (!pool) return index.count();
  const [rows] = await pool.query('SELECT * FROM hospitals ORDER BY id');
  index.replace(rows.map(fromRow));
  return index.count();
}

/** Memory store: the starting network straight from the catalogue. */
function useMemory() {
  pool = null;
  source = 'memory';
  index.replace(catalogue.networkSeed().map(h => Object.assign({}, h, { active: true })));
  return index.count();
}

/**
 * Inserts the starting network into the hospitals table. Idempotent: rows that
 * exist are left exactly as they are (INSERT IGNORE), so re-running it — or an
 * administrator having switched a hospital off — changes nothing.
 * @returns {Promise<{inserted:number, already:number, missing:number[]}>}
 */
async function seedNetwork(mysqlPool, file) {
  const ids = catalogue.networkIds(file);
  const records = ids.map(id => catalogue.get(id));
  const missing = ids.filter((id, i) => !records[i]);
  const present = records.filter(Boolean);
  if (!present.length) return { inserted: 0, already: 0, missing };
  const [res] = await mysqlPool.query(INSERT_IGNORE, [present.map(toRow)]);
  const inserted = Number(res.affectedRows) || 0;
  return { inserted, already: present.length - inserted, missing };
}

/* ── Changes (admin console) ─────────────────────────────────────────────── */

/** Adds catalogue hospitals to the network. Hospitals already in it are left alone. */
async function importFromCatalogue(ids) {
  const want = Array.from(new Set((ids || []).map(Number).filter(Number.isInteger)));
  const added = [], already = [], missing = [];
  const fresh = [];
  for (const id of want) {
    if (index.get(id)) { already.push(id); continue; }
    const h = catalogue.get(id);
    if (!h) { missing.push(id); continue; }
    fresh.push(Object.assign({}, h, { active: true }));
  }
  if (fresh.length) {
    if (pool) { await pool.query(INSERT_IGNORE, [fresh.map(toRow)]); await reload(); }
    else fresh.forEach(h => index.put(h));
    fresh.forEach(h => added.push(h.hospital_id));
  }
  return { added, already, missing };
}

async function setActive(id, active) {
  const h = index.get(id);
  if (!h) return null;
  if (pool) { await pool.query('UPDATE hospitals SET active=? WHERE id=?', [active ? 1 : 0, Number(id)]); await reload(); }
  else index.put(Object.assign({}, h, { active: !!active }));
  return index.get(id);
}

/* ── Queries ─────────────────────────────────────────────────────────────── */

const isActive = h => h.active !== false;

/** Any network hospital, active or not (logins and old cases still point at it). */
function get(id) { return index.get(id); }

/** Active network hospitals within radiusKm, nearest first. */
function nearby(lat, lng, radiusKm, options) {
  const opts = Object.assign({}, options);
  const extra = opts.filter;
  opts.filter = h => isActive(h) && (!extra || extra(h));
  return index.nearby(lat, lng, radiusKm, opts);
}

function search(query, options) {
  const opts = Object.assign({ maxLimit: 500 }, options);
  if (!opts.includeInactive) {
    const extra = opts.filter;
    opts.filter = h => isActive(h) && (!extra || extra(h));
  }
  return index.search(query, opts);
}

function states() { return index.states(); }

function summary() {
  return Object.assign(index.summary(), { active: index.all().filter(isActive).length, source });
}

function count() { return index.count(); }
function list() { return index.all().slice(); }

/** Test hook: a small fixture instead of the network. */
function loadRecords(records) {
  pool = null;
  source = 'fixture';
  index.replace(records.map(raw => Object.assign({ coord_source: 'listed', emergency_likely: true, state: '', district: '', active: true }, raw)));
}

module.exports = {
  attach, reload, useMemory, seedNetwork, importFromCatalogue, setActive,
  get, nearby, search, states, summary, count, list, loadRecords,
  haversine, parseCsv: catalogue.parseCsv, fromRow, toRow, COLUMNS,
};
