/* ============================================================================
   The all-India hospital directory.

   29,844 hospitals built from the Government of India's National Hospital
   Directory (data.gov.in, NIHFW, Government Open Data Licence – India) plus
   GoldenHour's curated Bengaluru list. See data/hospitals/README.md for how
   the file is built and what each column means.

   It is loaded into memory once at boot. That is deliberate: it is a few MB,
   it changes only when the data file is rebuilt, and every broadcast needs a
   radius query over it — a grid index in memory answers that in microseconds
   with no database round trip, and works identically under the memory store.

   Locations come in two grades, and callers must keep them apart:
     coord_source = 'listed'  — the directory's own coordinates
     coord_source = 'pincode' — the centre of the hospital's PIN code, which
                                can be several kilometres out
     coord_source = 'district' — the centre of its district, where the PIN
                                code's location was implausible
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', '..', '..', 'data', 'hospitals', 'india_hospitals.csv');
const CELL = 0.1;               // degrees per grid cell (~11 km)

let byId = new Map();
let grid = new Map();
let all = [];
let loadedFrom = null;

/* RFC 4180 CSV, quoted fields with embedded commas, quotes and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toRecord(cols, values) {
  const r = {};
  cols.forEach((c, i) => { r[c] = values[i] === undefined ? '' : values[i]; });
  const lat = r.lat === '' ? null : Number(r.lat);
  const lng = r.lng === '' ? null : Number(r.lng);
  return {
    hospital_id: Number(r.id),
    source_id: r.source_id,
    name: r.name,
    state: r.state,
    district: r.district,
    pincode: r.pincode || null,
    address: r.address || null,
    contact: r.phone || null,
    ownership: r.ownership || null,
    care_type: r.care_type || null,
    system: r.system || null,
    specialties: r.specialties || null,
    beds: r.beds === '' ? null : Number(r.beds),
    emergency_likely: r.emergency_likely === '1',
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    coord_source: r.coord_source || null,
    curated: r.curated === '1',
  };
}

function cellKey(lat, lng) { return Math.floor(lat / CELL) + ':' + Math.floor(lng / CELL); }

function load(file) {
  const target = file || process.env.HOSPITAL_DIRECTORY_FILE || DEFAULT_FILE;
  byId = new Map(); grid = new Map(); all = [];
  let text;
  try { text = fs.readFileSync(target, 'utf8'); }
  catch (err) {
    console.warn('⚠️  hospital directory not loaded (' + target + '): ' + err.message);
    loadedFrom = null;
    return 0;
  }
  const rows = parseCsv(text);
  const cols = rows.shift() || [];
  for (const values of rows) {
    if (values.length < 3) continue;
    const h = toRecord(cols, values);
    if (!Number.isInteger(h.hospital_id) || !h.name) continue;
    byId.set(h.hospital_id, h);
    all.push(h);
    if (h.lat !== null && h.lng !== null) {
      const k = cellKey(h.lat, h.lng);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(h);
    }
  }
  loadedFrom = target;
  return all.length;
}

function ensureLoaded() { if (!loadedFrom && !all.length) load(); }

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Hospitals within radiusKm of a point, nearest first, with distance_km. */
function nearby(lat, lng, radiusKm, options) {
  ensureLoaded();
  const opts = options || {};
  const la = Number(lat), lo = Number(lng), r = Number(radiusKm) || 15;
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return [];
  const span = Math.ceil((r / 111) / CELL) + 1;
  const ci = Math.floor(la / CELL), cj = Math.floor(lo / CELL);
  const out = [];
  for (let i = ci - span; i <= ci + span; i++) {
    for (let j = cj - span; j <= cj + span; j++) {
      const bucket = grid.get(i + ':' + j);
      if (!bucket) continue;
      for (const h of bucket) {
        if (opts.emergencyOnly && !h.emergency_likely) continue;
        if (opts.filter && !opts.filter(h)) continue;
        const d = haversine(la, lo, h.lat, h.lng);
        if (d <= r) out.push(Object.assign({}, h, { distance_km: Math.round(d * 10) / 10 }));
      }
    }
  }
  out.sort((a, b) => a.distance_km - b.distance_km);
  return opts.limit ? out.slice(0, opts.limit) : out;
}

function get(id) { ensureLoaded(); return byId.get(Number(id)) || null; }

/** Name / district / pincode search for the admin console. */
function search(query, options) {
  ensureLoaded();
  const opts = options || {};
  const q = String(query || '').trim().toLowerCase();
  const state = opts.state ? String(opts.state).toLowerCase() : null;
  const limit = Math.min(Number(opts.limit) || 25, 200);
  const terms = q.split(/\s+/).filter(Boolean);
  const out = [];
  for (const h of all) {
    if (state && h.state.toLowerCase() !== state) continue;
    if (opts.emergencyOnly && !h.emergency_likely) continue;
    if (terms.length) {
      const hay = (h.name + ' ' + h.district + ' ' + (h.pincode || '') + ' ' + h.state).toLowerCase();
      if (!terms.every(t => hay.indexOf(t) !== -1)) continue;
    }
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

function states() {
  ensureLoaded();
  const counts = new Map();
  for (const h of all) counts.set(h.state, (counts.get(h.state) || 0) + 1);
  return Array.from(counts.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}

function summary() {
  ensureLoaded();
  let listed = 0, pincode = 0, district = 0, none = 0, emergency = 0;
  for (const h of all) {
    if (h.coord_source === 'listed') listed++;
    else if (h.coord_source === 'pincode') pincode++;
    else if (h.coord_source === 'district') district++;
    else none++;
    if (h.emergency_likely) emergency++;
  }
  return { records: all.length, location_listed: listed, location_pincode: pincode, location_district: district, no_location: none,
    emergency_likely: emergency, states: states().length, file: loadedFrom ? path.basename(loadedFrom) : null };
}

function count() { ensureLoaded(); return all.length; }

/** Test hook: load a small fixture instead of the national file. */
function loadRecords(records) {
  byId = new Map(); grid = new Map(); all = [];
  for (const raw of records) {
    const h = Object.assign({ coord_source: 'listed', emergency_likely: true, state: '', district: '' }, raw);
    byId.set(h.hospital_id, h); all.push(h);
    if (h.lat != null && h.lng != null) {
      const k = cellKey(h.lat, h.lng);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(h);
    }
  }
  loadedFrom = 'fixture';
}

module.exports = { load, get, nearby, search, states, summary, count, haversine, parseCsv, loadRecords };
