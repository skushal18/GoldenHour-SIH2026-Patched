/* ============================================================================
   An in-memory index over a list of hospitals: lookup by id, radius search
   on a grid, word search, per-state counts and a location-quality summary.

   Used twice: by directoryService for the GoldenHour network (the hospitals
   table in MySQL) and by catalogueService for the all-India CSV the admin
   imports from. Radius search over a grid in memory answers in microseconds
   with no database round trip, and works the same under the memory store.

   Locations come in three grades, and callers must keep them apart:
     coord_source = 'listed'   — the directory's own coordinates
     coord_source = 'pincode'  — the centre of the hospital's PIN code
     coord_source = 'district' — the centre of its district
   ========================================================================== */
'use strict';

const CELL = 0.1;               // degrees per grid cell (~11 km)

function cellKey(lat, lng) { return Math.floor(lat / CELL) + ':' + Math.floor(lng / CELL); }

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function createIndex() {
  let byId = new Map();
  let grid = new Map();
  let all = [];

  function add(h) {
    byId.set(h.hospital_id, h);
    all.push(h);
    if (h.lat != null && h.lng != null) {
      const k = cellKey(h.lat, h.lng);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(h);
    }
  }

  return {
    /** Replace the whole index. */
    replace(records) {
      byId = new Map(); grid = new Map(); all = [];
      for (const h of records) add(h);
      all.sort((a, b) => a.hospital_id - b.hospital_id);
    },
    /** Add or replace one hospital. */
    put(h) {
      const rest = all.filter(x => x.hospital_id !== h.hospital_id);
      this.replace(rest.concat([h]));
    },

    get(id) { return byId.get(Number(id)) || null; },
    all() { return all; },
    count() { return all.length; },

    /** Hospitals within radiusKm of a point, nearest first, with distance_km. */
    nearby(lat, lng, radiusKm, options) {
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
    },

    /** Name / district / pincode search; every word must match. */
    search(query, options) {
      const opts = options || {};
      const q = String(query || '').trim().toLowerCase();
      const state = opts.state ? String(opts.state).toLowerCase() : null;
      const limit = Math.min(Number(opts.limit) || 25, opts.maxLimit || 200);
      const terms = q.split(/\s+/).filter(Boolean);
      const out = [];
      for (const h of all) {
        if (state && String(h.state || '').toLowerCase() !== state) continue;
        if (opts.emergencyOnly && !h.emergency_likely) continue;
        if (opts.filter && !opts.filter(h)) continue;
        if (terms.length) {
          const hay = (h.name + ' ' + h.district + ' ' + (h.pincode || '') + ' ' + h.state).toLowerCase();
          if (!terms.every(t => hay.indexOf(t) !== -1)) continue;
        }
        out.push(h);
        if (out.length >= limit) break;
      }
      return out;
    },

    states() {
      const counts = new Map();
      for (const h of all) counts.set(h.state, (counts.get(h.state) || 0) + 1);
      return Array.from(counts.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    },

    summary() {
      let listed = 0, pincode = 0, district = 0, none = 0, emergency = 0;
      for (const h of all) {
        if (h.coord_source === 'listed') listed++;
        else if (h.coord_source === 'pincode') pincode++;
        else if (h.coord_source === 'district') district++;
        else none++;
        if (h.emergency_likely) emergency++;
      }
      return { records: all.length, location_listed: listed, location_pincode: pincode, location_district: district, no_location: none,
        emergency_likely: emergency, states: this.states().length };
    },
  };
}

module.exports = { createIndex, haversine };
