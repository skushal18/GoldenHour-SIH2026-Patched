/* ============================================================================
   The all-India hospital catalogue — the CSV the network is built from.

   29,844 hospitals from the Government of India's National Hospital
   Directory (data.gov.in, NIHFW, Government Open Data Licence – India) plus
   GoldenHour's curated Bengaluru list. See data/hospitals/README.md.

   This is NOT what ambulances are matched against: that is the GoldenHour
   network, the hospitals table in MySQL (directoryService). The catalogue is
   the source the administrator imports more hospitals from, and the seed
   script reads the first 100 from it (data/hospitals/network_hospitals.csv).

   Loaded on first use, so a server that never imports does not hold it.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { createIndex } = require('./hospitalIndex');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data', 'hospitals');
const DEFAULT_FILE = path.join(DATA_DIR, 'india_hospitals.csv');
const NETWORK_FILE = path.join(DATA_DIR, 'network_hospitals.csv');

const index = createIndex();
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

function load(file) {
  const target = file || process.env.HOSPITAL_DIRECTORY_FILE || DEFAULT_FILE;
  let text;
  try { text = fs.readFileSync(target, 'utf8'); }
  catch (err) {
    console.warn('⚠️  hospital catalogue not loaded (' + target + '): ' + err.message);
    index.replace([]); loadedFrom = null;
    return 0;
  }
  const rows = parseCsv(text);
  const cols = rows.shift() || [];
  const records = [];
  for (const values of rows) {
    if (values.length < 3) continue;
    const h = toRecord(cols, values);
    if (!Number.isInteger(h.hospital_id) || !h.name) continue;
    records.push(h);
  }
  index.replace(records);
  loadedFrom = target;
  return records.length;
}

function ensureLoaded() { if (!loadedFrom) load(); }

/** The directory ids of the hospitals the network starts with, in file order. */
function networkIds(file) {
  const rows = parseCsv(fs.readFileSync(file || process.env.HOSPITAL_NETWORK_FILE || NETWORK_FILE, 'utf8'));
  const cols = rows.shift() || [];
  const at = cols.indexOf('id');
  return rows.map(r => Number(r[at])).filter(Number.isInteger);
}

/** The network's starting hospitals as catalogue records (missing ids are skipped). */
function networkSeed(file) {
  ensureLoaded();
  return networkIds(file).map(id => index.get(id)).filter(Boolean);
}

module.exports = {
  load,
  get(id) { ensureLoaded(); return index.get(id); },
  nearby(lat, lng, km, opts) { ensureLoaded(); return index.nearby(lat, lng, km, opts); },
  search(q, opts) { ensureLoaded(); return index.search(q, opts); },
  states() { ensureLoaded(); return index.states(); },
  summary() { ensureLoaded(); return Object.assign(index.summary(), { file: loadedFrom ? path.basename(loadedFrom) : null }); },
  count() { ensureLoaded(); return index.count(); },
  networkIds, networkSeed, parseCsv,
};
