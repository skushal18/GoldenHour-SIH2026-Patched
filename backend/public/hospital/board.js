/* ============================================================================
   GoldenHour desk — the ER board (window.GHBoard).

   Keyed rendering: each case card is created once and then updated in place,
   so an en-route card's Leaflet map survives every repaint instead of being
   torn down and rebuilt each time a vital or a GPS fix changes.
   ========================================================================== */
(function () {
  'use strict';
  var GH = window.GH, $ = GH.$, $$ = GH.$$, esc = GH.esc, cfg = GH.cfg;

  var DWELL = Number(cfg.ARRIVED_DWELL_MS) || 25000;
  var DELAY_LABEL = { traffic: 'traffic', road_blocked: 'road blocked', vehicle_issue: 'vehicle problem',
    patient_deteriorating: 'patient deteriorating', diverting: 'taking another route', other: 'other reason' };

  var state = null;

  function freshState(account, hospital) {
    return {
      account: account, hospital: hospital, socket: null, timers: [],
      pending: {}, active: {}, order: { pending: [], active: [] },
      els: {}, maps: {}, delays: {}, arrivals: {}, arrivedSeen: {},
      capacity: { resus_bays_available: 0, ventilators_available: 0, ct_available: true, ot_available: true, blood_available: true, cathlab_available: true, diversion_active: false, updated_at: null },
      sound: cfg.ENABLE_SOUND !== false, audio: null, started: false,
    };
  }

  /* ── clinical bands (display only; triage is the server's) ─────────────── */
  function band(key, v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v); if (!isFinite(n)) return null;
    var T = {
      systolic_bp: [[90, 'critical', 'Low'], [100, 'caution', 'Low'], [140, null, ''], [180, 'caution', 'High'], [1e9, 'critical', 'High']],
      diastolic_bp: [[50, 'critical', 'Low'], [60, 'caution', 'Low'], [90, null, ''], [120, 'caution', 'High'], [1e9, 'critical', 'High']],
      heart_rate: [[50, 'critical', 'Low'], [60, 'caution', 'Low'], [101, null, ''], [121, 'caution', 'High'], [1e9, 'critical', 'High']],
      resp_rate: [[9, 'critical', 'Low'], [12, 'caution', 'Low'], [21, null, ''], [30, 'caution', 'Raised'], [1e9, 'critical', 'High']],
      spo2: [[90, 'critical', 'Low'], [95, 'caution', 'Low'], [1e9, null, '']],
      glucose: [[60, 'critical', 'Low'], [70, 'caution', 'Low'], [141, null, ''], [250, 'caution', 'High'], [1e9, 'critical', 'High']],
    }[key];
    for (var i = 0; i < T.length; i++) if (n < T[i][0]) return { cls: T[i][1], word: T[i][2] };
    return null;
  }
  function worst(a, b) {
    var rank = { critical: 2, caution: 1 };
    return ((a && rank[a.cls]) || 0) >= ((b && rank[b.cls]) || 0) ? a : b;
  }

  /* ── pieces ──────────────────────────────────────────────────────────── */
  function vitalsHtml(p) {
    var v = (p && p.vitals) || {};
    var bp = (v.systolic_bp != null && v.diastolic_bp != null) ? v.systolic_bp + '/' + v.diastolic_bp : (v.systolic_bp != null ? v.systolic_bp + '/—' : '—');
    var cells = [
      ['BP', bp, worst(band('systolic_bp', v.systolic_bp), band('diastolic_bp', v.diastolic_bp))],
      ['HR', v.heart_rate != null ? v.heart_rate : '—', band('heart_rate', v.heart_rate)],
      ['RR', v.resp_rate != null ? v.resp_rate : '—', band('resp_rate', v.resp_rate)],
      ['SpO₂', v.spo2 != null ? v.spo2 + '%' : '—', band('spo2', v.spo2)],
      ['Glucose', v.glucose != null ? v.glucose : '—', band('glucose', v.glucose)],
      ['Blood', (p && p.blood_group) || '—', null],
    ];
    return '<div class="vitals">' + cells.map(function (c) {
      var b = c[2], cls = b && b.cls ? ' is-' + b.cls : '';
      var sub = c[1] === '—' ? (c[0] === 'Blood' ? 'Not reported' : 'Not taken') : (b && b.word ? b.word : (c[0] === 'Blood' ? 'Reported' : ''));
      return '<div class="vital' + cls + '"><span class="k">' + esc(c[0]) + '</span><span class="v">' + esc(c[1]) + '</span><span class="s">' + esc(sub) + '</span></div>';
    }).join('') + '</div>';
  }

  function needsHtml(card) {
    var n = card.needs, c = card.capacity;
    if (!n) return '';
    var items = [
      ['Ventilator', n.needs_ventilator, c ? (c.ventilators_available | 0) > 0 : null, c ? (c.ventilators_available | 0) + ' free' : ''],
      ['Blood', n.needs_blood, c ? !!c.blood_available : null, ''],
      ['CT', n.needs_imaging, c ? !!c.ct_available : null, ''],
      ['Theatre', n.needs_ot, c ? !!c.ot_available : null, ''],
      ['Cath lab', n.needs_cathlab, c ? !!c.cathlab_available : null, ''],
    ].filter(function (x) { return x[1]; });
    if (!items.length) return '';
    return '<div class="chips"><span class="lead">Will need</span>' + items.map(function (x) {
      var cls = x[2] === null ? 'unknown' : (x[2] ? 'met' : 'unmet');
      var word = x[2] === null ? '· not reported' : (x[2] ? '· available' : '· none free');
      return '<span class="chip ' + cls + '">' + esc(x[0]) + ' ' + word + '</span>';
    }).join('') + '</div>';
  }

  function unmet(card) {
    var n = card.needs || {}, c = card.capacity;
    if (!c) return [];
    var out = [];
    if (n.needs_ventilator && (c.ventilators_available | 0) === 0) out.push('ventilator');
    if (n.needs_blood && !c.blood_available) out.push('blood');
    if (n.needs_imaging && !c.ct_available) out.push('CT');
    if (n.needs_ot && !c.ot_available) out.push('theatre');
    if (n.needs_cathlab && !c.cathlab_available) out.push('cath lab');
    return out;
  }

  function flagsHtml(card) {
    var f = card.critical_flags || {}, out = [];
    if (f.cardiac_arrest) out.push('cardiac arrest');
    if (f.airway_compromise) out.push('airway compromise');
    if (f.shock) out.push('shock');
    if (f.hypoxia) out.push('hypoxia');
    if (f.low_gcs) out.push('unconscious');
    var extra = [];
    if (card.stroke_assessment) {
      var s = card.stroke_assessment;
      var pos = ['face', 'arm', 'speech'].filter(function (k) { return s[k]; });
      extra.push('<span class="chip met">FAST: ' + esc(pos.length ? pos.join(' + ') : 'no deficit') + ' · ' + esc(s.onset_hours != null ? s.onset_hours + ' h since onset' : 'onset unknown') + '</span>');
    }
    if (card.origin && card.origin.source && card.origin.source !== 'gps') {
      extra.push('<span class="chip hand">Position ' + esc(card.origin.source === 'manual' ? 'set by hand' : card.origin.source) + ' — distance is an estimate</span>');
    }
    if (!out.length && !extra.length) return '';
    return '<div class="chips">' + out.map(function (x) { return '<span class="chip flag">' + esc(x) + '</span>'; }).join('') + extra.join('') + '</div>';
  }

  function shotsHtml(card) {
    var imgs = Array.isArray(card.images) ? card.images : [];
    if (!imgs.length) return '';
    return '<div class="shots">' + imgs.map(function (src, i) {
      return '<button type="button" class="shot" aria-label="Open photo ' + (i + 1) + ' of ' + imgs.length + '"><img src="' + esc(src) + '" alt="Photograph ' + (i + 1) + ' from the crew"></button>';
    }).join('') + '</div>';
  }

  function subline(card, extra) {
    var p = card.patient || {};
    var parts = ['<span class="mono">' + esc(card.case_code) + '</span>', esc(GH.ageBand(p.age)), esc(GH.SEX[p.gender || 'U'] || 'Sex unknown')];
    if (p.consciousness) parts.push(esc(p.consciousness));
    if (card.ambulance_id) parts.push('Ambulance ' + esc(card.ambulance_id));
    if (extra) parts.push(extra);
    return parts.join(' · ');
  }

  function prioPill(p) {
    var word = { RED: 'RED · CRITICAL', AMBER: 'AMBER · URGENT', GREEN: 'GREEN · STABLE' }[p || 'GREEN'];
    return '<span class="prio prio-' + esc(p || 'GREEN') + '">' + word + '</span>';
  }

  function countdown(expires) {
    var ms = new Date(expires).getTime() - Date.now();
    if (!isFinite(ms)) return '';
    if (ms <= 0) return 'expiring';
    var s = Math.round(ms / 1000);
    return 'expires in ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /* ── pending card ────────────────────────────────────────────────────── */
  function pendingBody(card) {
    var miss = unmet(card), diverting = state.capacity.diversion_active;
    var label = (miss.length || diverting) ? 'Accept anyway' : 'Accept';
    var warn = miss.length ? 'You reported no ' + miss.join(', ') + ' free' : (diverting ? 'You are on diversion' : '');
    var others = Math.max(0, (card.hospitals_notified || 1) - 1);
    var eta = card.eta_minutes != null ? card.eta_minutes + ' min' : '—';
    var dist = card.distance_km != null ? card.distance_km.toFixed(1) + ' km' : '';
    return '' +
      '<div class="case-top">' + prioPill(card.priority) +
        '<div class="titles"><h3>' + esc(card.chief_complaint || 'Emergency') + '</h3><span class="sub">' + subline(card) + '</span></div>' +
        '<div class="eta"><b>' + esc(eta) + '</b><span>' + esc(dist) + (dist ? ' · ' : '') + '<span class="countdown" data-expires="' + esc(card.expires_at || '') + '">' + esc(countdown(card.expires_at)) + '</span></span></div>' +
      '</div>' +
      vitalsHtml(card.patient) + flagsHtml(card) + needsHtml(card) + shotsHtml(card) +
      (card.notes ? '<p class="note-block"><b>Crew note:</b> ' + esc(card.notes) + '</p>' : '') +
      '<div class="actions">' +
        '<button type="button" class="g-btn g-btn-act" data-act="accept" data-cc="' + esc(card.case_code) + '">' + label + '</button>' +
        '<button type="button" class="g-btn" data-act="decline" data-cc="' + esc(card.case_code) + '">Decline</button>' +
        (warn ? '<span class="warn">' + esc(warn) + '</span>' : '') +
        '<span class="why">' + (others ? 'Also offered to ' + others + ' other hospital' + (others === 1 ? '' : 's') : 'Offered only to you') + '</span>' +
      '</div>';
  }

  /* ── en-route card ───────────────────────────────────────────────────── */
  function trackView(card) {
    var p = card.last_position;
    var valid = p && p.lat != null && p.lng != null;
    var age = valid ? Date.now() - Date.parse(p.at) : Infinity;
    var stale = valid && (!isFinite(age) || age > 30000);
    var src = stale ? 'stale' : (card.eta_source || 'crew');
    var live = valid && !stale && src === 'live' && card.live_eta_minutes != null;
    return {
      valid: valid, stale: stale, age: age,
      eta: live ? card.live_eta_minutes + ' min' : (card.eta_minutes != null ? card.eta_minutes + ' min' : '—'),
      etaNote: live ? 'Live GPS' : (src === 'stalled' ? 'Not moving' : src === 'stationary' ? 'Slow / stopped' : src === 'stale' ? 'Location stale' : (card.eta_minutes != null ? 'Crew estimate' : 'ETA unavailable')),
      etaCls: live ? 'live' : (src === 'stale' || src === 'stalled' ? 'stale' : ''),
    };
  }

  function lastUpdateLine(card) {
    var h = card.patient_history || [];
    if (!h.length) return '';
    var last = h[h.length - 1];
    var names = { 'vitals.systolic_bp': 'Systolic', 'vitals.diastolic_bp': 'Diastolic', 'vitals.heart_rate': 'HR', 'vitals.resp_rate': 'RR',
      'vitals.spo2': 'SpO₂', 'vitals.glucose': 'Glucose', age: 'Age', gender: 'Sex', blood_group: 'Blood group', consciousness: 'Consciousness' };
    var bits = Object.keys(last.changed || {}).slice(0, 4).map(function (k) {
      var pair = last.changed[k];
      var from = k === 'age' ? GH.ageBand(pair[0]) : (pair[0] == null ? '—' : pair[0]);
      var to = k === 'age' ? GH.ageBand(pair[1]) : (pair[1] == null ? '—' : pair[1]);
      return (names[k] || k) + ' ' + from + ' → ' + to;
    });
    return '<div class="update-line">Crew update ' + esc(GH.timeOf(last.at)) + ' — ' + esc(bits.join(', ') || 'details changed') + '</div>';
  }

  function delayHtml(code) {
    var d = state.delays[code];
    if (!d) return '';
    return '<div class="alert-delay" role="alert"><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2l7.5 13h-15z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 7v3.5M9 12.6v.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
      'Crew reported a delay: ' + esc(DELAY_LABEL[d.reason] || 'other reason') + (d.extra_minutes ? ', about ' + d.extra_minutes + ' min more' : '') + ' · ' + esc(GH.ago(d.at)) + '</div>';
  }

  function activeBody(card) {
    var arrived = card.status === 'ARRIVED';
    var t = trackView(card);
    var dist = card.remaining_distance_km != null ? card.remaining_distance_km.toFixed(1) + ' km' : (card.distance_km != null ? card.distance_km.toFixed(1) + ' km' : '—');
    var fix = t.valid ? Math.max(0, Math.round(t.age / 1000)) + ' s' : '—';
    var acc = card.last_position && card.last_position.accuracy_m != null ? '±' + Math.round(card.last_position.accuracy_m) + ' m' : 'no fix yet';
    return '' +
      '<div class="case-top">' + prioPill(card.priority) +
        '<div class="titles"><h3>' + esc(card.chief_complaint || 'Emergency') + '</h3><span class="sub">' + subline(card, 'accepted ' + esc(GH.timeOf(card.accepted_at))) + '</span></div>' +
      '</div>' +
      (arrived ? '<span class="arrived-ribbon">✓ Arrived at ' + esc(GH.timeOf(card.arrived_at)) + ' — case closed</span>' : delayHtml(card.case_code)) +
      (arrived ? '' : '<div class="stats">' +
        '<div class="stat"><span class="k">ETA</span><span class="v">' + esc(t.eta) + '</span><span class="s ' + t.etaCls + '">' + esc(t.etaNote) + '</span></div>' +
        '<div class="stat"><span class="k">Distance</span><span class="v">' + esc(dist) + '</span><span class="s">straight line</span></div>' +
        '<div class="stat"><span class="k">Last fix</span><span class="v">' + esc(fix) + '</span><span class="s">' + esc(acc) + '</span></div>' +
      '</div>') +
      lastUpdateLine(card) + vitalsHtml(card.patient) + flagsHtml(card) + shotsHtml(card) +
      (card.notes ? '<p class="note-block"><b>Crew note:</b> ' + esc(card.notes) + '</p>' : '') +
      '<div class="actions">' +
        (arrived ? '' : '<button type="button" class="g-btn g-btn-act" data-act="arrived" data-cc="' + esc(card.case_code) + '"' + (state.arrivals[card.case_code] ? ' disabled' : '') + '>' + (state.arrivals[card.case_code] ? 'Recording…' : 'Mark arrived') + '</button>') +
        '<button type="button" class="g-btn" data-act="handover" data-cc="' + esc(card.case_code) + '">Handover sheet</button>' +
        '<button type="button" class="g-btn" data-act="timeline" data-cc="' + esc(card.case_code) + '">Timeline</button>' +
      '</div>';
  }

  /* ── keyed rendering ─────────────────────────────────────────────────── */
  function ensureEl(card, kind) {
    var code = card.case_code, el = state.els[code];
    if (el && el.dataset.kind !== kind) { destroyMap(code); el.remove(); el = null; }
    if (!el) {
      el = document.createElement('article');
      el.dataset.case = code; el.dataset.kind = kind;
      if (kind === 'active') {
        el.className = 'case case-active glass';
        el.innerHTML = '<div class="body"></div><div class="mapbox"><div class="map"></div><div class="map-fallback" hidden></div><span class="map-tag" hidden></span></div>';
      } else {
        el.className = 'case glass';
      }
      state.els[code] = el;
    }
    return el;
  }

  function paint() {
    if (!state) return;
    var pend = Object.keys(state.pending).map(function (k) { return state.pending[k]; })
      .sort(function (a, b) { return prioRank(b) - prioRank(a) || new Date(a.created_at) - new Date(b.created_at); });
    var act = Object.keys(state.active).map(function (k) { return state.active[k]; })
      .sort(function (a, b) { return (a.status === 'ARRIVED') - (b.status === 'ARRIVED') || new Date(a.accepted_at) - new Date(b.accepted_at); });

    var keep = {};
    var pl = $('#pendingList'), al = $('#activeList');
    pend.forEach(function (c) { var el = ensureEl(c, 'pending'); el.innerHTML = pendingBody(c); pl.appendChild(el); keep[c.case_code] = 1; });
    act.forEach(function (c) {
      var el = ensureEl(c, 'active');
      el.classList.toggle('case-arrived', c.status === 'ARRIVED');
      $('.body', el).innerHTML = activeBody(c);
      al.appendChild(el); keep[c.case_code] = 1;
      updateMap(c);
    });
    Object.keys(state.els).forEach(function (code) {
      if (!keep[code]) { destroyMap(code); state.els[code].remove(); delete state.els[code]; }
    });
    setEmpty(pl, pend.length, 'No incoming cases. New ones appear here with a chime.');
    setEmpty(al, act.length, 'No ambulances on their way to you.');
    $('#cntPending').textContent = pend.length;
    $('#cntActive').textContent = act.filter(function (c) { return c.status !== 'ARRIVED'; }).length;
    document.title = (pend.length ? '(' + pend.length + ') ' : '') + 'GoldenHour · ' + (state.hospital ? state.hospital.name : 'ER desk');
  }
  function prioRank(c) { return { RED: 3, AMBER: 2, GREEN: 1 }[c.priority] || 0; }
  function setEmpty(list, n, text) {
    var e = $('.empty', list);
    if (n) { if (e) e.remove(); return; }
    if (!e) { e = document.createElement('div'); e.className = 'empty'; list.appendChild(e); }
    e.textContent = text;
  }

  /* ── map ─────────────────────────────────────────────────────────────── */
  function hospitalPoint(card) {
    var h = card.tracking_hospital || state.hospital;
    return h && h.lat != null && h.lng != null ? [Number(h.lat), Number(h.lng)] : null;
  }
  function trackPoints(card) {
    var pts = (card.track || []).filter(function (p) { return p && p.lat != null && p.lng != null; }).map(function (p) { return [Number(p.lat), Number(p.lng)]; });
    var lp = card.last_position;
    if (lp && lp.lat != null && (!pts.length || pts[pts.length - 1][0] !== Number(lp.lat) || pts[pts.length - 1][1] !== Number(lp.lng))) pts.push([Number(lp.lat), Number(lp.lng)]);
    return pts.slice(-120);
  }
  function updateMap(card) {
    var el = state.els[card.case_code]; if (!el) return;
    var box = $('.mapbox', el), mapEl = $('.map', box), fb = $('.map-fallback', box), tag = $('.map-tag', box);
    var pts = trackPoints(card), hp = hospitalPoint(card);
    var useLeaflet = window.L && cfg.MAP_TILE_URL && card.status !== 'ARRIVED';
    if (card.status === 'ARRIVED') {
      destroyMap(card.case_code);
      mapEl.hidden = true; fb.hidden = false; tag.hidden = true;
      fb.innerHTML = '<span class="map-readout">Arrival confirmed · location sharing has ended.</span>';
      return;
    }
    if (!useLeaflet) {
      mapEl.hidden = true; fb.hidden = false;
      fb.innerHTML = trailSvg(pts, hp);
      tag.hidden = false; tag.textContent = 'GPS trail · not a road map';
      return;
    }
    mapEl.hidden = false; fb.hidden = true;
    var m = state.maps[card.case_code];
    if (!m) {
      var map = L.map(mapEl, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
      L.tileLayer(cfg.MAP_TILE_URL, { maxZoom: 19, attribution: cfg.MAP_ATTRIBUTION || '' }).addTo(map);
      m = state.maps[card.case_code] = { map: map, trail: L.polyline([], { color: '#00869A', weight: 4, opacity: .85 }).addTo(map), amb: null, hosp: null, fitted: false };
      if (hp) m.hosp = L.marker(hp, { icon: L.divIcon({ className: '', html: '<div class="hosp-marker" aria-hidden="true">+</div>', iconSize: [24, 24], iconAnchor: [12, 12] }), title: state.hospital ? state.hospital.name : 'Hospital' }).addTo(map);
      map.setView(hp || [12.9716, 77.5946], 14);
      setTimeout(function () { map.invalidateSize(); }, 50);
    }
    m.trail.setLatLngs(pts);
    if (pts.length) {
      var last = pts[pts.length - 1];
      if (!m.amb) m.amb = L.marker(last, { icon: L.divIcon({ className: '', html: '<div class="amb-marker" aria-hidden="true"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), title: 'Ambulance' }).addTo(m.map);
      else m.amb.setLatLng(last);
      if (!m.fitted || pts.length % 6 === 0) {
        var b = L.latLngBounds(pts.concat(hp ? [hp] : []));
        m.map.fitBounds(b.pad(0.25), { maxZoom: 16 });
        m.fitted = true;
      }
      tag.hidden = true;
    } else {
      tag.hidden = false; tag.textContent = 'Waiting for the ambulance’s first GPS fix';
    }
  }
  function destroyMap(code) {
    var m = state && state.maps[code];
    if (m) { try { m.map.remove(); } catch (_) {} delete state.maps[code]; }
  }
  /* Offline fallback: a plot of the trail, north up — no map service involved. */
  function trailSvg(pts, hp) {
    if (!pts.length) return '<span class="map-readout">Waiting for the ambulance’s first GPS fix…</span>';
    var all = pts.concat(hp ? [hp] : []);
    var mid = pts[pts.length - 1][0] * Math.PI / 180;
    var xs = all.map(function (p) { return p[1] * Math.cos(mid); }), ys = all.map(function (p) { return -p[0]; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, sc = Math.max((maxX - minX) / 260, (maxY - minY) / 130, 0.000002);
    function xy(p) { return [150 + (p[1] * Math.cos(mid) - cx) / sc, 85 + (-p[0] - cy) / sc]; }
    var line = pts.map(function (p) { return xy(p).map(function (n) { return n.toFixed(1); }).join(','); }).join(' ');
    var a = xy(pts[pts.length - 1]), h = hp ? xy(hp) : null;
    return '<svg class="gps-trail" viewBox="0 0 300 170" role="img" aria-label="Ambulance GPS trail toward the hospital, north up">' +
      '<path d="M0 42H300M0 85H300M0 128H300M75 0V170M150 0V170M225 0V170" class="trail-grid"/>' +
      '<polyline points="' + line + '" class="trail-line"/>' +
      (h ? '<rect x="' + (h[0] - 7).toFixed(1) + '" y="' + (h[1] - 7).toFixed(1) + '" width="14" height="14" rx="3" class="trail-hospital"/>' : '') +
      '<circle cx="' + a[0].toFixed(1) + '" cy="' + a[1].toFixed(1) + '" r="7" class="trail-ambulance"/><text x="290" y="16" class="trail-north">N ↑</text></svg>';
  }

  /* ── data ────────────────────────────────────────────────────────────── */
  function refreshQueue() {
    return GH.api('/desk/queue').then(function (body) {
      if (!state) return;
      var pending = {}, active = {};
      (body.pending || []).forEach(function (c) { pending[c.case_code] = c; });
      (body.active || []).forEach(function (c) {
        /* A poll that left the server before the arrival was recorded still
           lists the case as en route. Once this desk has seen the arrival
           confirmed, that stale answer must not bring the case back. */
        if (state.arrivedSeen[c.case_code]) return;
        active[c.case_code] = mergeLive(state.active[c.case_code], c);
      });
      /* An arrival keeps its confirmation dwell even when the queue no
         longer lists it. */
      Object.keys(state.active).forEach(function (k) { if (state.active[k].status === 'ARRIVED') active[k] = state.active[k]; });
      state.pending = pending; state.active = active;
      paint();
    }).catch(function () { /* the socket keeps us current; the next poll retries */ });
  }
  /* Keep a fresher socket position than the poll snapshot. */
  function mergeLive(prev, next) {
    if (!prev || !prev.last_position || !next.last_position) return next;
    return Date.parse(prev.last_position.at) > Date.parse(next.last_position.at)
      ? Object.assign({}, next, { last_position: prev.last_position, track: prev.track, live_eta_minutes: prev.live_eta_minutes, eta_source: prev.eta_source, remaining_distance_km: prev.remaining_distance_km })
      : next;
  }

  function loadCapacity() {
    return GH.api('/desk/capacity').then(function (b) {
      if (b.capacity) state.capacity = Object.assign(state.capacity, b.capacity);
      else publishCapacity();      // first time: tell the network what we have
      paintCapacity();
    }).catch(function () {});
  }

  function loadNearby() {
    GH.api('/desk/nearby?km=5').then(function (b) {
      var list = b.hospitals || [];
      $('#nearList').innerHTML = list.length ? list.slice(0, 8).map(function (h) {
        var st = !h.on_goldenhour ? '<span class="st st-off">Not on GoldenHour</span>'
          : (h.capacity && h.capacity.diversion_active ? '<span class="st st-divert">On diversion</span>' : '<span class="st st-on">On GoldenHour</span>');
        return '<div class="net-row"><span class="n">' + esc(h.name) + '<small>' + (h.location_quality === 'listed' ? '' : '≈ ') + h.distance_km.toFixed(1) + ' km' + (h.phone ? ' · ' + esc(h.phone) : '') + '</small></span>' + st + '</div>';
      }).join('') : '<div class="map-readout">No other hospitals within 5 km in the directory.</div>';
    }).catch(function () { $('#nearList').innerHTML = '<div class="map-readout">Nearby hospitals unavailable.</div>'; });
  }

  function loadNumbers() {
    GH.api('/desk/analytics?scope=hospital').then(function (d) {
      $('#tAccepted').textContent = d.counts ? d.counts.accepted : '—';
      $('#tArrived').textContent = d.counts ? d.counts.arrived : '—';
      $('#tMedian').textContent = GH.secs(d.time_to_accept && d.time_to_accept.median);
      $('#storeNote').textContent = d.store === 'memory' ? 'resets on restart' : 'last 90 days';
    }).catch(function () {});
  }

  /* ── capacity ────────────────────────────────────────────────────────── */
  function paintCapacity() {
    var c = state.capacity;
    $$('.stepper').forEach(function (s) {
      var k = s.dataset.cap, n = c[k] | 0;
      $('b', s).textContent = n;
      s.classList.toggle('is-zero', n === 0);
    });
    $$('.toggle[data-flag]').forEach(function (t) { t.setAttribute('aria-pressed', c[t.dataset.flag] ? 'true' : 'false'); });
    var d = $('#divertBtn');
    d.classList.toggle('is-on', !!c.diversion_active);
    d.setAttribute('aria-pressed', c.diversion_active ? 'true' : 'false');
    d.textContent = c.diversion_active ? 'On diversion — end' : 'Go on diversion';
    $('#diversionBand').hidden = !c.diversion_active;
    $('#capUpdated').textContent = c.updated_at ? 'updated ' + GH.ago(c.updated_at) : 'not reported yet';
  }
  var capTimer = null;
  function publishCapacity(patch) {
    clearTimeout(capTimer);
    capTimer = setTimeout(function () {
      var body = patch || {
        resus_bays_available: state.capacity.resus_bays_available | 0, ventilators_available: state.capacity.ventilators_available | 0,
        ct_available: !!state.capacity.ct_available, ot_available: !!state.capacity.ot_available, blood_available: !!state.capacity.blood_available,
        cathlab_available: !!state.capacity.cathlab_available, diversion_active: !!state.capacity.diversion_active,
      };
      GH.api('/desk/capacity', { method: 'PUT', body: body })
        .then(function (b) { if (b.capacity) { state.capacity = Object.assign(state.capacity, b.capacity); paintCapacity(); } })
        .catch(function (e) { GH.toast('Capacity not saved — ' + e.message); });
    }, 250);
  }

  function onBoardClick(e) {
    if (!state) return;
    var t = e.target;
    var step = t.closest && t.closest('.stepper button');
    if (step) {
      var k = step.closest('.stepper').dataset.cap;
      state.capacity[k] = Math.max(0, (state.capacity[k] | 0) + Number(step.dataset.delta));
      paintCapacity(); publishCapacity(); return;
    }
    var tog = t.closest && t.closest('.toggle[data-flag]');
    if (tog) { var f = tog.dataset.flag; state.capacity[f] = !state.capacity[f]; paintCapacity(); publishCapacity(); return; }
    var shot = t.closest && t.closest('.shot');
    if (shot) { var img = $('img', shot); $('#lightboxImg').src = img.src; $('#lightboxImg').alt = img.alt; $('#lightbox').hidden = false; $('#lightboxClose').focus(); return; }
    var btn = t.closest && t.closest('[data-act]');
    if (!btn) return;
    var code = btn.dataset.cc, act = btn.dataset.act;
    if (act === 'accept') return accept(code, btn);
    if (act === 'decline') return decline(code, btn);
    if (act === 'arrived') return arrived(code);
    if (act === 'handover') return handover(code);
    if (act === 'timeline') return timeline(code);
  }

  /* ── actions ─────────────────────────────────────────────────────────── */
  function accept(code, btn) {
    btn.disabled = true; btn.textContent = 'Accepting…';
    GH.api('/desk/accept/' + encodeURIComponent(code), { method: 'POST', body: {} }).then(function (b) {
      delete state.pending[code];
      if (b.case) state.active[code] = b.case;
      paint(); GH.toast('Accepted — cleared from every other hospital');
    }).catch(function (e) {
      var by = e.body && e.body.accepted_by;
      GH.toast(by ? 'Already accepted by ' + by : 'Could not accept: ' + e.message);
      refreshQueue();
    });
  }
  function decline(code, btn) {
    btn.disabled = true;
    GH.api('/desk/decline/' + encodeURIComponent(code), { method: 'POST', body: {} })
      .then(function () { delete state.pending[code]; paint(); })
      .catch(function (e) { GH.toast('Could not decline: ' + e.message); btn.disabled = false; });
  }
  function arrived(code) {
    var card = state.active[code];
    if (!card || card.status === 'ARRIVED' || state.arrivals[code]) return;
    if (!window.confirm('Record that ' + code + ' has reached your hospital?\n\nThis closes the case and stops location sharing.')) return;
    state.arrivals[code] = true; paint();
    GH.api('/desk/arrived/' + encodeURIComponent(code), { method: 'POST', body: {} }).then(function (b) {
      paintArrived({ case_code: code, arrived_at: b.arrived_at });
      GH.toast('Arrival recorded');
    }).catch(function (e) { GH.toast('Arrival not recorded — ' + e.message); })
      .then(function () { delete state.arrivals[code]; paint(); });
  }
  function paintArrived(d) {
    state.arrivedSeen[d.case_code] = true;
    var c = state.active[d.case_code];
    if (!c || c.status === 'ARRIVED') return;
    c.status = 'ARRIVED'; c.arrived_at = d.arrived_at || new Date().toISOString();
    delete state.delays[d.case_code];
    paint();
    if (cfg.PRINT_ON_ARRIVE) handover(d.case_code);
    var timer = setTimeout(function () { if (state && state.active[d.case_code] && state.active[d.case_code].status === 'ARRIVED') { delete state.active[d.case_code]; paint(); } }, DWELL);
    state.timers.push(timer);
  }

  function handover(code) {
    GH.api('/desk/handover/' + encodeURIComponent(code)).then(function (d) {
      var p = d.patient || {};
      var vit = (d.vitals_initial_vs_latest || []).map(function (v) { return '<tr><td>' + esc(v.key.replace(/_/g, ' ')) + '</td><td>' + esc(v.initial == null ? '—' : v.initial) + '</td><td>' + esc(v.latest == null ? '—' : v.latest) + '</td></tr>'; }).join('');
      $('#handover').innerHTML =
        '<h1 style="font-size:18pt;margin:0 0 4pt">Pre-arrival handover · ' + esc(d.case_code) + '</h1>' +
        '<p>' + esc(d.hospital && d.hospital.name) + ' · priority ' + esc(d.priority) + ' · ' + esc(d.chief_complaint || '') + '</p>' +
        '<p>Patient: ' + esc(GH.ageBand(p.age)) + ', ' + esc(GH.SEX[p.gender || 'U']) + (p.blood_group ? ', blood ' + esc(p.blood_group) : '') + (p.consciousness ? ', ' + esc(p.consciousness) : '') + '</p>' +
        '<p>Broadcast ' + esc(GH.timeOf(d.created_at)) + ' · accepted ' + esc(GH.timeOf(d.accepted_at)) + ' · arrived ' + esc(GH.timeOf(d.arrived_at)) + '</p>' +
        '<table style="border-collapse:collapse;margin:8pt 0" border="1" cellpadding="4"><tr><th>Vital</th><th>At broadcast</th><th>Latest</th></tr>' + vit + '</table>' +
        (d.notes ? '<p><b>Crew note:</b> ' + esc(d.notes) + '</p>' : '') +
        '<p style="font-size:9pt;margin-top:16pt">GoldenHour · printed ' + esc(new Date().toLocaleString()) + '</p>';
      setTimeout(function () { window.print(); }, 150);
    }).catch(function (e) { GH.toast('Handover unavailable — ' + e.message); });
  }

  function timeline(code) {
    GH.api('/desk/timeline/' + encodeURIComponent(code)).then(function (d) {
      var words = { BROADCAST_CREATED: 'Broadcast sent', ACCEPTED: 'Accepted', PATIENT_UPDATED: 'Crew updated the patient', POSITION: 'GPS position', DELAY_REPORTED: 'Delay reported', ARRIVED: 'Arrived', DECLINED: 'Declined', EXPIRED: 'Expired', CANCELLED: 'Cancelled' };
      var rows = (d.events || []).filter(function (e) { return e.event_type !== 'POSITION'; }).map(function (e) {
        return '<div class="net-row"><span class="n">' + esc(words[e.event_type] || e.event_type) + '</span><span class="st st-off">' + esc(GH.timeOf(e.performed_at)) + '</span></div>';
      }).join('');
      GH.openSheet('Timeline · ' + code, rows || '<p class="map-readout">No events recorded.</p>');
    }).catch(function (e) { GH.toast('Timeline unavailable — ' + e.message); });
  }

  function history() {
    GH.api('/desk/history').then(function (d) {
      var rows = (d.cases || []).map(function (c) {
        var st = c.status === 'ARRIVED' ? 'Arrived ' + GH.timeOf(c.arrived_at) : c.status === 'ACCEPTED' ? 'En route' : c.status.charAt(0) + c.status.slice(1).toLowerCase();
        return '<div class="net-row"><span class="n">' + esc(c.chief_complaint || 'Emergency') + '<small><span class="mono">' + esc(c.case_code) + '</span> · ' + esc(GH.dateTime(c.created_at)) + '</small></span><span class="st st-off">' + esc(st) + '</span></div>';
      }).join('');
      GH.openSheet('Recent cases', rows || '<p class="map-readout">No cases yet.</p>');
    }).catch(function (e) { GH.toast('History unavailable — ' + e.message); });
  }

  /* ── sound ───────────────────────────────────────────────────────────── */
  function beep() {
    if (!state.sound) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
      state.audio = state.audio || new Ctx();
      if (state.audio.state === 'suspended') state.audio.resume();
      [0, 0.22].forEach(function (offset) {
        var o = state.audio.createOscillator(), g = state.audio.createGain(), t0 = state.audio.currentTime + offset;
        o.type = 'sine'; o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        o.connect(g).connect(state.audio.destination); o.start(t0); o.stop(t0 + 0.2);
      });
    } catch (_) {}
  }

  /* ── realtime ────────────────────────────────────────────────────────── */
  function setLive(up, text) {
    var pill = $('#livePill');
    pill.classList.toggle('is-down', !up);
    $('#liveText').textContent = text;
  }
  function connect() {
    if (!window.io) { setLive(false, 'Realtime unavailable — refreshing every 10 s'); return; }
    var s = state.socket = window.io({ transports: ['websocket', 'polling'], query: { role: 'hospital' }, auth: { token: (GH.session() || {}).token } });
    s.on('connect', function () { setLive(true, 'Live'); refreshQueue(); });
    s.on('disconnect', function () { setLive(false, 'Reconnecting…'); });
    s.on('connect_error', function () { setLive(false, 'Offline — retrying'); });
    s.on('hospital:rejected', function (d) {
      s.disconnect();
      if (d && (d.reason === 'REVOKED' || d.reason === 'DISABLED' || d.reason === 'EXPIRED' || d.reason === 'NO_ACCOUNT' || d.reason === 'BAD_TOKEN')) window.GHSignOut();
      else setLive(false, d && d.message ? d.message : 'Realtime refused');
    });
    s.on('broadcast:new', function (card) {
      var isNew = !state.pending[card.case_code];
      state.pending[card.case_code] = card; paint();
      if (isNew) beep();
    });
    s.on('broadcast:claimed', function (d) {
      var mine = state.hospital && Number(d.accepted_hospital_id) === Number(state.hospital.hospital_id);
      var el = state.els[d.case_code];
      if (!mine && el && state.pending[d.case_code]) {
        el.classList.add('is-leaving');
        setTimeout(function () { delete state.pending[d.case_code]; paint(); }, 280);
        GH.toast(d.accepted_by ? d.case_code + ' was taken by ' + d.accepted_by : d.case_code + ' was taken by another hospital');
      } else if (mine) { delete state.pending[d.case_code]; refreshQueue(); }
    });
    ['broadcast:expired', 'broadcast:cancelled', 'broadcast:declined'].forEach(function (ev) {
      s.on(ev, function (d) { delete state.pending[d.case_code]; paint(); });
    });
    s.on('patient:updated', function (d) {
      var c = state.active[d.case_code] || state.pending[d.case_code];
      if (!c) return;
      c.patient = d.patient; c.notes = d.notes; c.patient_history = d.patient_history || c.patient_history;
      paint(); GH.toast('Crew updated ' + d.case_code);
    });
    s.on('case:position', function (d) {
      var c = state.active[d.case_code];
      if (!c || c.status === 'ARRIVED' || d.lat == null) return;
      c.track = (c.track || []).concat([{ lat: d.lat, lng: d.lng, at: d.at, accuracy_m: d.accuracy_m, speed_kmh: d.speed_kmh }]).slice(-120);
      c.last_position = d; c.remaining_distance_km = d.distance_km; c.live_eta_minutes = d.live_eta_minutes; c.eta_source = d.eta_source;
      paint();
    });
    s.on('case:delay', function (d) {
      if (!state.active[d.case_code]) return;
      state.delays[d.case_code] = d; paint(); beep();
      GH.toast('Delay reported for ' + d.case_code + ': ' + (DELAY_LABEL[d.reason] || 'other reason'), 6000);
    });
    s.on('case:arrived', function (d) { paintArrived(d); });
    s.on('capacity:changed', function (p) {
      if (state.hospital && Number(p.hospital_id) === Number(state.hospital.hospital_id)) {
        state.capacity = Object.assign(state.capacity, p.capacity); paintCapacity();
      }
    });
  }

  /* ── lifecycle ───────────────────────────────────────────────────────── */
  var bound = false;
  function bindOnce() {
    if (bound) return; bound = true;
    document.addEventListener('click', function (e) { if (state && !$('#viewBoard').hidden && $('#viewBoard').contains(e.target)) onBoardClick(e); });
    $('#divertBtn').addEventListener('click', function () {
      if (!state) return;
      var on = !state.capacity.diversion_active;
      if (on && !window.confirm('Put your hospital on diversion? Crews will still see your cases, marked as diverting.')) return;
      state.capacity.diversion_active = on; paintCapacity(); publishCapacity();
    });
    $('#soundBtn').addEventListener('click', function () {
      if (!state) return;
      state.sound = !state.sound;
      this.setAttribute('aria-pressed', state.sound ? 'true' : 'false');
      this.setAttribute('aria-label', state.sound ? 'New-case sound on' : 'New-case sound off');
      $('#soundWaves').style.display = state.sound ? '' : 'none';
      if (state.sound) beep();
    });
    $('#signOutBtn').addEventListener('click', function () { window.GHSignOut(); });
    $('#historyBtn').addEventListener('click', history);
  }

  function start(account, hospital) {
    stop();
    state = freshState(account, hospital);
    bindOnce();
    $('#hospName').textContent = hospital ? hospital.name : 'ER desk';
    $('#hospMeta').textContent = hospital ? [hospital.district, hospital.state, 'ID ' + hospital.hospital_id].filter(Boolean).join(' · ') : '';
    $('#acctName').textContent = account.username;
    $('#acctInitials').textContent = GH.initials(hospital ? hospital.name : account.username);
    paint(); paintCapacity();
    refreshQueue(); loadCapacity(); loadNearby(); loadNumbers();
    connect();
    state.timers.push(setInterval(refreshQueue, 10000));
    state.timers.push(setInterval(loadNumbers, 60000));
    state.timers.push(setInterval(function () {
      $$('.countdown[data-expires]').forEach(function (el) {
        var text = countdown(el.dataset.expires); el.textContent = text;
        var ms = new Date(el.dataset.expires).getTime() - Date.now();
        el.classList.toggle('is-urgent', ms < 60000);
      });
      paintCapacityAge();
    }, 1000));
  }
  function paintCapacityAge() { if (state && state.capacity.updated_at) $('#capUpdated').textContent = 'updated ' + GH.ago(state.capacity.updated_at); }

  function stop() {
    if (!state) return;
    state.timers.forEach(function (t) { clearInterval(t); clearTimeout(t); });
    if (state.socket) { try { state.socket.disconnect(); } catch (_) {} }
    Object.keys(state.maps).forEach(destroyMap);
    Object.keys(state.els).forEach(function (k) { state.els[k].remove(); });
    state = null;
  }

  window.GHBoard = { start: start, stop: stop, _band: band };
})();
