/* ============================================================================
   GoldenHour · ER desk board

   The laptop never says who it is. The server does, from its IP address.
   Everything else follows from that:

     broadcast:new      a case arrives on BOTH laptops at the same moment
     Accept             → POST /desk/accept — first request to land wins
     broadcast:claimed  → the losing laptop drops the card, with a reason

   Socket.IO carries all of it. A 5-second poll runs underneath as a safety
   net, so a flaky demo-day network degrades to "a little slower" rather
   than "nothing happens".
   ========================================================================== */

(function () {
  'use strict';

  var API = '/api/v1/desk';
  var POLL_MS = 5000;

  var params = new URLSearchParams(window.location.search);
  var forcedHospital = params.get('hospital');

  /* Under DESK_AUTH=jwt the server wants a token on every call. There is no
     login screen — this board is a wall display, not an app — so the token is
     handed over once via ?token=... and kept in localStorage from then on.
     In the default LAN mode none of this does anything. */
  var TOKEN_KEY = 'gh_desk_token';
  var token = params.get('token');
  if (token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
    /* Keep the token out of the address bar and out of the browser history. */
    var clean = window.location.pathname +
      (forcedHospital ? '?hospital=' + encodeURIComponent(forcedHospital) : '');
    window.history.replaceState({}, '', clean);
  } else {
    try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { token = null; }
  }

  function authHeaders() {
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  var state = {
    hospital: null,
    matchedBy: null,
    clientIp: null,
    cases: {},          // case_code → incoming card (PENDING, this desk)
    active: {},         // case_code → active card (ACCEPTED, en route to us)
    resolved: [],       // most recent outcomes (accepted-everywhere + arrived + won + lost)
    sound: true,
    connected: false,
    freshUpdate: {}     // case_code → Date.now() of the last patient:updated we received
  };

  /* ── Tiny helpers ─────────────────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  var toastTimer = null;
  function toast(message) {
    var t = $('toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3400);
  }

  /* A short two-tone chime. Built with WebAudio so the page stays a single
     folder with no media files to lose. */
  var audioCtx = null;
  function chime(urgent) {
    if (!state.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      [0, 0.16].forEach(function (offset, i) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = urgent ? (i ? 1180 : 880) : (i ? 720 : 560);
        gain.gain.setValueAtTime(0.0001, audioCtx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.22, audioCtx.currentTime + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + offset + 0.28);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + offset);
        osc.stop(audioCtx.currentTime + offset + 0.3);
      });
    } catch (e) { /* a demo must never die over a beep */ }
  }

  /* ── Vital colour bands — the same thresholds the crew's app uses ─────── */
  var BANDS = {
    systolic_bp:  { criticalLow: 89, cautionLow: 99, cautionHigh: 140, criticalHigh: 180 },
    diastolic_bp: { criticalLow: 49, cautionLow: 59, cautionHigh: 90,  criticalHigh: 120 },
    heart_rate:   { criticalLow: 49, cautionLow: 59, cautionHigh: 101, criticalHigh: 121 },
    resp_rate:    { criticalLow: 8,  cautionLow: 11, cautionHigh: 21,  criticalHigh: 30 },
    spo2:         { criticalLow: 89, cautionLow: 94, cautionHigh: 101, criticalHigh: 101 },
    glucose:      { criticalLow: 59, cautionLow: 69, cautionHigh: 141, criticalHigh: 250 }
  };
  function band(key, value) {
    var b = BANDS[key];
    if (!b || value === null || value === undefined || isNaN(Number(value))) return 'none';
    var n = Number(value);
    if (n <= b.criticalLow || n >= b.criticalHigh) return 'critical';
    if (n <= b.cautionLow || n >= b.cautionHigh) return 'caution';
    return 'good';
  }

  var GENDER = { M: 'Male', F: 'Female', O: 'Other', U: 'Sex unknown' };

  /* ── Card rendering ───────────────────────────────────────────────────── */

  function vitalBox(label, value, unit, key) {
    var box = el('div', 'vitalbox v-' + band(key, value));
    box.appendChild(el('span', null, label));
    var b = el('b');
    if (value === null || value === undefined || value === '') {
      b.textContent = '—';
      box.className = 'vitalbox v-none';
    } else {
      b.textContent = String(value);
      if (unit) b.appendChild(el('small', null, unit));
    }
    box.appendChild(b);
    return box;
  }

  function factRow(c) {
    var row = el('div', 'facts');
    var p = c.patient || {};

    function fact(label, value, brand) {
      if (value === null || value === undefined || value === '') return;
      var f = el('div', brand ? 'fact fact-brand' : 'fact');
      f.appendChild(el('span', null, label));
      f.appendChild(el('b', null, String(value)));
      row.appendChild(f);
    }

    fact('Age', p.age === null || p.age === undefined ? null : p.age + ' yrs');
    fact('', GENDER[p.gender] || 'Sex unknown');
    fact('Blood', p.blood_group);
    fact('', p.consciousness);
    fact('ETA', c.eta_minutes ? c.eta_minutes + ' min' : null, true);
    fact('Distance', c.distance_km === null || c.distance_km === undefined ? null : c.distance_km + ' km');
    /* Say so when the distance was computed from a position a crew member
       typed rather than one the device measured. */
    var source = c.origin && c.origin.source;
    if (source && source !== 'gps') {
      var f = el('div', 'fact fact-warn');
      f.appendChild(el('b', null, source === 'manual' ? 'Position set by hand' : 'Last known position'));
      row.appendChild(f);
    }
    fact('Unit', c.ambulance_id);
    fact('Alerted', c.hospitals_notified + ' hospital' + (c.hospitals_notified === 1 ? '' : 's'));
    return row;
  }

  function flagRow(c) {
    var flags = c.critical_flags || {};
    var names = {
      shock: 'Shock', hypoxia: 'Hypoxia', low_gcs: 'Unresponsive',
      cardiac_arrest: 'Cardiac arrest', airway_compromise: 'Airway'
    };
    var on = Object.keys(names).filter(function (k) { return flags[k]; });
    if (!on.length) return null;
    var row = el('div', 'flags');
    on.forEach(function (k) { row.appendChild(el('div', 'flag', names[k])); });
    return row;
  }

  function fastRow(c) {
    var f = c.stroke_assessment;
    if (!f) return null;
    var row = el('div', 'fast');
    row.appendChild(el('span', 'fast-label', 'FAST'));
    [['Face', f.face], ['Arm', f.arm], ['Speech', f.speech]].forEach(function (pair) {
      var item = el('span', 'fast-item');
      item.appendChild(document.createTextNode(pair[0] + ' '));
      var v = el('b', null, pair[1] ? 'YES' : 'no');
      if (!pair[1]) v.style.color = 'var(--muted)';
      item.appendChild(v);
      row.appendChild(item);
    });
    if (f.onset_hours !== null && f.onset_hours !== undefined) {
      row.appendChild(el('span', 'fast-item', 'Onset ' + f.onset_hours + ' h ago'));
    }
    return row;
  }

  function shotsRow(c) {
    if (!c.images || !c.images.length) return null;
    var row = el('div', 'shots');
    c.images.forEach(function (src, i) {
      var img = new Image();
      img.src = src;
      img.alt = 'Scene photo ' + (i + 1);
      img.addEventListener('click', function () { lightbox(src); });
      row.appendChild(img);
    });
    return row;
  }

  function lightbox(src) {
    var box = el('div', 'lightbox');
    var img = new Image();
    img.src = src;
    img.alt = 'Scene photo';
    box.appendChild(img);
    box.addEventListener('click', function () { box.remove(); });
    document.body.appendChild(box);
  }

  function buildCard(c) {
    var card = el('article', 'case pri-' + (c.priority || 'AMBER'));
    card.dataset.caseCode = c.case_code;
    card.dataset.expiresAt = c.expires_at || '';

    /* head */
    var head = el('div', 'case-head');
    var title = el('div', 'case-title');
    title.appendChild(el('h3', null, c.chief_complaint || 'Emergency'));
    var code = el('div', 'case-code');
    code.appendChild(el('b', null, c.case_code));
    code.appendChild(document.createTextNode(' · broadcast ' + timeAgo(c.created_at)));
    title.appendChild(code);
    head.appendChild(title);
    head.appendChild(el('span', 'badge badge-' + (c.priority || 'AMBER'), c.priority || 'AMBER'));
    var cd = el('span', 'countdown', '—');
    cd.dataset.countdown = '1';
    head.appendChild(cd);
    card.appendChild(head);

    /* body */
    var body = el('div', 'case-body');
    body.appendChild(factRow(c));
    var flags = flagRow(c); if (flags) body.appendChild(flags);

    var v = (c.patient && c.patient.vitals) || {};
    var vitals = el('div', 'vitals');
    var bp = el('div', 'vitalbox v-' + (v.systolic_bp === null || v.systolic_bp === undefined ? 'none' : band('systolic_bp', v.systolic_bp)));
    bp.appendChild(el('span', null, 'BP'));
    var bpVal = el('b', null,
      (v.systolic_bp === null || v.systolic_bp === undefined ? '—' : v.systolic_bp) + '/' +
      (v.diastolic_bp === null || v.diastolic_bp === undefined ? '—' : v.diastolic_bp));
    bpVal.appendChild(el('small', null, 'mmHg'));
    bp.classList.add('v-bp');
    bp.appendChild(bpVal);
    vitals.appendChild(bp);
    vitals.appendChild(vitalBox('Pulse', v.heart_rate, 'bpm', 'heart_rate'));
    vitals.appendChild(vitalBox('SpO₂', v.spo2, '%', 'spo2'));
    vitals.appendChild(vitalBox('Resp', v.resp_rate, '/min', 'resp_rate'));
    vitals.appendChild(vitalBox('Glucose', v.glucose, 'mg/dL', 'glucose'));
    body.appendChild(vitals);

    var fast = fastRow(c); if (fast) body.appendChild(fast);
    if (c.notes) body.appendChild(el('div', 'note', c.notes));
    var shots = shotsRow(c); if (shots) body.appendChild(shots);
    card.appendChild(body);

    /* foot */
    var foot = el('div', 'case-foot');
    foot.appendChild(el('p', 'foot-note',
      'Accepting claims this patient and clears the request from every other hospital.'));
    var decline = el('button', 'btn-decline', 'Not us');
    decline.addEventListener('click', function () { decline.disabled = true; sendDecline(c.case_code); });
    var accept = el('button', 'btn-accept', 'Accept patient');
    accept.addEventListener('click', function () {
      accept.disabled = true;
      accept.textContent = 'Claiming…';
      sendAccept(c.case_code, accept);
    });
    foot.appendChild(decline);
    foot.appendChild(accept);
    card.appendChild(foot);

    return card;
  }

  function timeAgo(iso) {
    if (!iso) return 'just now';
    var secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (secs < 45) return 'just now';
    if (secs < 90) return 'a minute ago';
    return Math.round(secs / 60) + ' min ago';
  }

  /* ── Board state ──────────────────────────────────────────────────────── */

  function priorityRank(p) { return p === 'RED' ? 0 : p === 'AMBER' ? 1 : 2; }

  function priorityRank(p) { return p === 'RED' ? 0 : p === 'AMBER' ? 1 : 2; }

  /* Build the patient summary block on an active/accepted card. Same layout
     as the incoming queue card but the "Edit Patient Details" CTA is
     implicit — the server pushes the data, the desk cannot edit it. */
  function activeCardBody(c) {
    var body = el('div', 'case-body active-body');
    body.appendChild(factRow(c));
    var flags = flagRow(c); if (flags) body.appendChild(flags);

    var v = (c.patient && c.patient.vitals) || {};
    var vitals = el('div', 'vitals');
    var bp = el('div', 'vitalbox v-' + (v.systolic_bp === null || v.systolic_bp === undefined ? 'none' : band('systolic_bp', v.systolic_bp)));
    bp.appendChild(el('span', null, 'BP'));
    var bpVal = el('b', null,
      (v.systolic_bp === null || v.systolic_bp === undefined ? '—' : v.systolic_bp) + '/' +
      (v.diastolic_bp === null || v.diastolic_bp === undefined ? '—' : v.diastolic_bp));
    bpVal.appendChild(el('small', null, 'mmHg'));
    bp.classList.add('v-bp');
    bp.appendChild(bpVal);
    vitals.appendChild(bp);
    vitals.appendChild(vitalBox('Pulse', v.heart_rate, 'bpm', 'heart_rate'));
    vitals.appendChild(vitalBox('SpO₂', v.spo2, '%', 'spo2'));
    vitals.appendChild(vitalBox('Resp', v.resp_rate, '/min', 'resp_rate'));
    vitals.appendChild(vitalBox('Glucose', v.glucose, 'mg/dL', 'glucose'));
    body.appendChild(vitals);

    var fast = fastRow(c); if (fast) body.appendChild(fast);
    if (c.notes) body.appendChild(el('div', 'note', c.notes));
    var shots = shotsRow(c); if (shots) body.appendChild(shots);
    return body;
  }

  function buildActiveCard(c) {
    var card = el('article', 'case is-active pri-' + (c.priority || 'AMBER'));
    card.dataset.caseCode = c.case_code;

    var head = el('div', 'case-head');
    var title = el('div', 'case-title');
    title.appendChild(el('h3', null, c.chief_complaint || 'Emergency'));
    var code = el('div', 'case-code');
    code.appendChild(el('b', null, c.case_code));
    code.appendChild(document.createTextNode(' · started ' + timeAgo(c.accepted_at || c.created_at)));
    title.appendChild(code);
    head.appendChild(title);
    head.appendChild(el('span', 'badge badge-' + (c.priority || 'AMBER'), c.priority || 'AMBER'));
    head.appendChild(el('span', 'pill pill-en-route', '🚑 En Route'));
    card.appendChild(head);

    var banner = el('div', 'active-banner');
    banner.appendChild(el('span', 'active-dot'));
    banner.appendChild(el('span', null, 'Patient is on the way — incoming to this desk'));
    card.appendChild(banner);

    card.appendChild(activeCardBody(c));

    var foot = el('div', 'case-foot');
    foot.appendChild(el('p', 'foot-note',
      'The card moves to Recently handled once the ambulance reports arrival.'));

    var ticker = el('span', 'update-ticker');
    ticker.dataset.ticker = c.case_code;
    footerTicker(c, ticker);
    foot.appendChild(ticker);
    card.appendChild(foot);
    return card;
  }

  function footerTicker(c, ticker) {
    var ts = c.last_patient_updated_at || c.accepted_at;
    clearTickerTimer(c.case_code);
    if (!ts) { ticker.textContent = ''; return; }
    function repaint() {
      var fresh = state.freshUpdate[c.case_code];
      var label = fresh ? ('● Patient information updated · ' + relativeTime(fresh))
                        : ('Updated · ' + relativeTime(ts));
      ticker.textContent = label;
      ticker.className = fresh ? 'update-ticker is-fresh' : 'update-ticker';
    }
    repaint();
    var timer = setInterval(repaint, 5000);
    tickerTimers[c.case_code] = timer;
  }
  var tickerTimers = {};
  function clearTickerTimer(code) {
    if (tickerTimers[code]) { clearInterval(tickerTimers[code]); delete tickerTimers[code]; }
  }

  function relativeTime(iso) {
    if (!iso) return '';
    var secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (secs < 5) return 'just now';
    if (secs < 60) return secs + 's ago';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.floor(mins / 60);
    return hrs + ' h ago';
  }

  function mergePatientUpdate(caseCode, patch) {
    var c = state.active[caseCode];
    if (!c) return;
    if (patch && patch.patient && typeof patch.patient === 'object') {
      c.patient = Object.assign({}, c.patient || {}, patch.patient);
      if (patch.patient.vitals && typeof patch.patient.vitals === 'object') {
        c.patient.vitals = Object.assign({}, (c.patient.vitals || {}), patch.patient.vitals);
      }
    }
    if (patch && 'notes' in patch) c.notes = patch.notes;
    c.last_patient_updated_at = patch && patch.updated_at ? patch.updated_at : new Date().toISOString();
    state.freshUpdate[caseCode] = Date.now();
    setTimeout(function () { if (state.freshUpdate[caseCode]) delete state.freshUpdate[caseCode]; render(); }, 8000);
    render();
  }

  function render() {
    var queue = $('queue');
    var list = Object.keys(state.cases).map(function (k) { return state.cases[k]; });

    list.sort(function (a, b) {
      var byPriority = priorityRank(a.priority) - priorityRank(b.priority);
      if (byPriority !== 0) return byPriority;
      return new Date(b.created_at) - new Date(a.created_at);
    });

    queue.innerHTML = '';
    list.forEach(function (c) { queue.appendChild(buildCard(c)); });

    $('emptyState').hidden = list.length > 0;

    /* Active column — only cards accepted by (or in-flight to) this desk. */
    var active = $('active');
    if (active) {
      active.innerHTML = '';
      var activeList = Object.keys(state.active).map(function (k) { return state.active[k]; });
      activeList.sort(function (a, b) {
        var pa = priorityRank(a.priority), pb = priorityRank(b.priority);
        if (pa !== pb) return pa - pb;
        return new Date(b.accepted_at || b.created_at) - new Date(a.accepted_at || a.created_at);
      });
      activeList.forEach(function (c) { active.appendChild(buildActiveCard(c)); });
    }
    var emptyActive = $('emptyActive');
    if (emptyActive) emptyActive.hidden = Object.keys(state.active).length > 0;

    var activeCounter = $('activeCount');
    if (activeCounter) {
      var n = Object.keys(state.active).length;
      activeCounter.textContent = n + ' active';
      activeCounter.className = n ? 'counter is-hot' : 'counter';
    }

    var waitingCounter = $('waitingCount');
    if (waitingCounter) {
      waitingCounter.textContent = list.length + ' waiting';
      waitingCounter.className = list.length ? 'counter is-hot' : 'counter';
    }

    var history = $('history');
    history.innerHTML = '';
    state.resolved.slice(0, 12).forEach(function (entry) {
      var card = el('article', 'case is-resolved pri-' + (entry.priority || 'AMBER'));
      var head = el('div', 'case-head');
      var title = el('div', 'case-title');
      title.appendChild(el('h3', null, entry.chief_complaint || 'Emergency'));
      var code = el('div', 'case-code');
      code.appendChild(el('b', null, entry.case_code));
      title.appendChild(code);
      head.appendChild(title);
      head.appendChild(el('span', 'badge badge-' + (entry.priority || 'AMBER'), entry.priority || 'AMBER'));
      if (entry.outcomeClass === 'outcome-arrived') {
        head.appendChild(el('span', 'pill pill-arrived', '✓ Arrived'));
      }
      card.appendChild(head);

      var outcome = el('div', 'outcome ' + entry.outcomeClass);
      outcome.appendChild(el('span', 'outcome-dot'));
      outcome.appendChild(el('span', null, entry.outcomeText));
      card.appendChild(outcome);
      if (entry.outcomeClass === 'outcome-arrived') card.classList.add('is-arrived');
      if (entry.outcomeClass === 'outcome-won') card.classList.add('is-won');
      history.appendChild(card);
    });

    tickCountdowns();
  }

  function tickCountdowns() {
    var nodes = document.querySelectorAll('[data-countdown]');
    for (var i = 0; i < nodes.length; i++) {
      var card = nodes[i].closest('.case');
      var expires = card && card.dataset.expiresAt;
      if (!expires) { nodes[i].textContent = 'open'; continue; }
      var left = Math.round((new Date(expires).getTime() - Date.now()) / 1000);
      if (left <= 0) { nodes[i].textContent = 'expired'; nodes[i].className = 'countdown is-urgent'; continue; }
      var mm = Math.floor(left / 60), ss = left % 60;
      nodes[i].textContent = mm + ':' + (ss < 10 ? '0' : '') + ss + ' left';
      nodes[i].className = left <= 60 ? 'countdown is-urgent' : 'countdown';
    }
  }
  setInterval(tickCountdowns, 1000);

  function addCase(c, announce) {
    if (!c || !c.case_code) return;
    /* PENDING-only goes into the Incoming column. ACCEPTED but not yet
       arrived lives in Active. ARRIVED goes to Recently Handled. */
    if (c.status === 'PENDING') {
      var isNew = !state.cases[c.case_code];
      if (state.active[c.case_code]) delete state.active[c.case_code];
      state.cases[c.case_code] = c;
      render();
      if (isNew && announce) {
        chime(c.priority === 'RED');
        toast('New ' + (c.priority || '') + ' request · ' + (c.chief_complaint || 'Emergency'));
        flashTitle();
      }
      return;
    }
    if (c.status === 'ACCEPTED') {
      addActive(c, announce);
      return;
    }
    /* ARRIVED / resolved: just sync into Recently Handled if a counterpart exists. */
    if (c.status === 'ARRIVED') {
      if (state.active[c.case_code]) {
        archive(c, 'Patient arrived — case closed', 'outcome-arrived');
      }
    }
  }

  function addActive(c, announce) {
    if (!c || !c.case_code) return;
    /* The server filters the queue, but retain this guard for late socket
       messages or a stale proxy response. An active case belongs only to its
       accepting hospital. */
    if (c.accepted_hospital_id && (!state.hospital ||
        Number(c.accepted_hospital_id) !== Number(state.hospital.hospital_id))) {
      delete state.cases[c.case_code];
      delete state.active[c.case_code];
      render();
      return;
    }
    var incomingCopy = state.cases[c.case_code];
    if (incomingCopy) delete state.cases[c.case_code];
    var isNew = !state.active[c.case_code];
    state.active[c.case_code] = c;
    render();
    if (isNew && announce) {
      chime(false);
      toast('Case ' + c.case_code + ' is yours · patient is on the way');
      flashTitle();
    }
  }

  function removeCase(caseCode, outcomeText, outcomeClass) {
    var c = state.cases[caseCode] || state.active[caseCode];
    if (!c) return;
    delete state.cases[caseCode];
    delete state.active[caseCode];
    state.resolved.unshift({
      case_code: c.case_code,
      chief_complaint: c.chief_complaint,
      priority: c.priority,
      outcomeText: outcomeText,
      outcomeClass: outcomeClass
    });

    /* Animate the card away before the re-render pulls it out. */
    var node = document.querySelector('.case[data-case-code="' + CSS.escape(caseCode) + '"]');
    if (node) {
      node.classList.add('is-leaving');
      setTimeout(render, 340);
    } else {
      render();
    }
  }

  /* Archive a case into Recently Handled without an inbound state — used
     when an `case:arrived` arrives for a card that was already ours. */
  function archive(c, outcomeText, outcomeClass) {
    if (!c || !c.case_code) return;
    if (state.cases[c.case_code]) delete state.cases[c.case_code];
    if (state.active[c.case_code]) delete state.active[c.case_code];
    state.resolved.unshift({
      case_code: c.case_code,
      chief_complaint: c.chief_complaint,
      priority: c.priority,
      outcomeText: outcomeText,
      outcomeClass: outcomeClass
    });
    var node = document.querySelector('.case[data-case-code="' + CSS.escape(c.case_code) + '"]');
    if (node) {
      node.classList.add('is-leaving');
      setTimeout(render, 340);
    } else {
      render();
    }
  }

  var titleTimer = null;
  function flashTitle() {
    var base = 'GoldenHour · ER Desk';
    var flip = false;
    clearInterval(titleTimer);
    var stop = Date.now() + 6000;
    titleTimer = setInterval(function () {
      document.title = (flip = !flip) ? '🚑 INCOMING' : base;
      if (Date.now() > stop) { clearInterval(titleTimer); document.title = base; }
    }, 700);
  }

  /* ── Server calls ─────────────────────────────────────────────────────── */

  function withHospital(url) {
    if (!forcedHospital) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'hospital=' + encodeURIComponent(forcedHospital);
  }

  function sendAccept(caseCode, button) {
    fetch(withHospital(API + '/accept/' + encodeURIComponent(caseCode)),
          { method: 'POST', headers: authHeaders() })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (res.ok && res.body.success) {
          removeCase(caseCode, 'Accepted here — patient is ours', 'outcome-won');
          toast('Accepted · ' + caseCode + ' is now yours');
          return;
        }
        /* Lost the race, or the request is no longer open. */
        var reason = res.body.reason;
        if (reason === 'ALREADY_ACCEPTED') {
          removeCase(caseCode, 'Taken by ' + (res.body.accepted_by || 'another hospital'), 'outcome-lost');
        } else {
          removeCase(caseCode, res.body.message || 'No longer open', 'outcome-gone');
        }
        toast(res.body.message || 'That request is no longer open');
      })
      .catch(function () {
        if (button) { button.disabled = false; button.textContent = 'Accept patient'; }
        toast('Could not reach the server — try again');
      });
  }

  function sendDecline(caseCode) {
    fetch(withHospital(API + '/decline/' + encodeURIComponent(caseCode)),
          { method: 'POST', headers: authHeaders() })
      .then(function () { removeCase(caseCode, 'Declined by this desk', 'outcome-lost'); })
      .catch(function () { toast('Could not reach the server'); });
  }

  function refreshQueue(announce) {
    return fetch(withHospital(API + '/queue'), { headers: authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.hospital) setIdentity(data.hospital, data.matched_by);
        var seen = {};
        /* New server contract (spec §21): server returns pending[] and
           active[] separately, plus legacy `cases` combined list. Treat the
           split as the source of truth when present. */
        var pending = data.pending || (data.cases || []).filter(function (c) { return c.status === 'PENDING' || c.lifecycle === 'pending'; });
        var active  = data.active  || (data.cases || []).filter(function (c) { return c.status === 'ACCEPTED' || c.lifecycle === 'active'; });

        /* Sync the split view: Anything that was in our local active state
           but no longer in the server's active list has either arrived or
           been cancelled server-side. Push to history with the appropriate
           outcome. */
        active.forEach(function (c) {
          seen[c.case_code] = 'active';
          if (!state.active[c.case_code]) {
            addActive(c, announce);
          } else {
            /* merge any update that arrived while socket was offline */
            state.active[c.case_code] = Object.assign({}, state.active[c.case_code], c);
          }
        });
        pending.forEach(function (c) {
          seen[c.case_code] = 'pending';
          addCase(c, announce && !state.cases[c.case_code]);
        });
        Object.keys(state.active).forEach(function (code) {
          if (!seen[code]) {
            var c = state.active[code];
            archive(c, 'Closed while you were away', 'outcome-gone');
          }
        });
        Object.keys(state.cases).forEach(function (code) {
          if (seen[code] === 'active') {
            /* was claimed in-flight by us — move it */
            var c = state.cases[code];
            delete state.cases[code];
            state.active[code] = Object.assign({}, c, state.active[code]);
          }
        });
        render();
      })
      .catch(function () { /* the poll is a safety net; silence is fine */ });
  }

  /* ── Identity ─────────────────────────────────────────────────────────── */

  function setIdentity(hospital, matchedBy) {
    state.hospital = hospital;
    state.matchedBy = matchedBy || state.matchedBy;
    $('hospitalName').textContent = hospital.name;

    var meta = $('hospitalMeta');
    meta.innerHTML = '';
    meta.appendChild(document.createTextNode('Hospital #' + hospital.hospital_id + ' · this laptop '));
    var ip = el('code', null, hospital.ip);
    meta.appendChild(ip);
    meta.appendChild(document.createTextNode(
      state.matchedBy === 'ip' ? ' · matched by IP'
        : state.matchedBy === 'override' ? ' · set by hand'
        : ' · assumed'));

    if (hospital.accent) {
      document.documentElement.style.setProperty('--brand', hospital.accent);
    }

    var warn = $('identityWarning');
    if (state.matchedBy === 'fallback') {
      $('identityWarningText').textContent =
        'This laptop\'s IP (' + (state.clientIp || 'unknown') + ') is not in config/hospitals.config.js, ' +
        'so it is being treated as ' + hospital.name + '. Pick the right one, or fix the IP in that file.';
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
  }

  function loadIdentity() {
    return fetch(withHospital(API + '/me'), { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          return r.json().then(function (b) { showAuthProblem(b.message); return null; });
        }
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.hospital) return;
        state.clientIp = data.client_ip;
        state.authMode = data.auth_mode;
        setIdentity(data.hospital, data.matched_by);
      })
      .catch(function () {
        $('hospitalName').textContent = 'Server unreachable';
        $('hospitalMeta').textContent = 'Is the GoldenHour backend running on this network?';
      });
  }

  /* Told apart from a network failure so the operator knows to ask for a
     token rather than go hunting for a dead server. */
  function showAuthProblem(message) {
    setLink('down', 'Not signed in');
    $('hospitalName').textContent = 'Not signed in';
    $('hospitalMeta').textContent = message ||
      'This server requires a token. Open /hospital?token=… with one issued by /api/v1/auth/login.';
    var warn = $('identityWarning');
    $('identityWarningText').textContent =
      'The ER desk API refused this board. Ask an administrator for a desk token.';
    warn.hidden = false;
  }

  /* ── Realtime ─────────────────────────────────────────────────────────── */

  function setLink(status, text) {
    var pill = $('linkPill');
    pill.className = 'pill pill-' + status;
    pill.textContent = text;
  }

  function connect() {
    if (typeof io !== 'function') { setLink('down', 'Polling only'); return; }

    var socket = io({
      query: { role: 'hospital', hospital: forcedHospital || '' },
      auth: token ? { token: token } : {},
      transports: ['websocket', 'polling']
    });

    socket.on('hospital:rejected', function (data) {
      setLink('down', 'Refused');
      showAuthProblem(data && data.message);
    });

    socket.on('connect', function () {
      state.connected = true;
      setLink('live', 'Live');
    });

    socket.on('disconnect', function () {
      state.connected = false;
      setLink('wait', 'Reconnecting…');
    });

    socket.on('connect_error', function () {
      state.connected = false;
      setLink('down', 'Offline');
    });

    socket.on('hospital:identity', function (data) {
      state.clientIp = data.client_ip;
      setIdentity(data.hospital, data.matched_by);
    });

    socket.on('broadcast:snapshot', function (cases) {
      (cases || []).forEach(function (c) { addCase(c, false); });
    });

    socket.on('broadcast:new', function (c) { addCase(c, true); });

    /* The event that makes the two-laptop demo work. */
    socket.on('broadcast:claimed', function (data) {
      if (!data || !data.case_code) return;
      if (data.won) return;                         // our own accept already moved it to Active
      /* We lost: send the case to Recently Handled, not have it linger. */
      removeCase(data.case_code, 'Taken by ' + (data.accepted_by || 'another hospital'), 'outcome-lost');
      toast(data.case_code + ' was accepted by ' + (data.accepted_by || 'another hospital'));
    });

    socket.on('broadcast:cancelled', function (data) {
      removeCase(data.case_code, 'Ambulance stood down', 'outcome-gone');
    });
    socket.on('broadcast:expired', function (data) {
      removeCase(data.case_code, 'Expired — nobody accepted', 'outcome-gone');
    });

    /* spec §5 / §15: server pushes the new patient block on edit. The server
       only sends this to the desk that owns the case, so we don't have to
       re-verify ownership client-side. */
    socket.on('patient:updated', function (data) {
      if (!data || !data.case_code) return;
      mergePatientUpdate(data.case_code, data);
      toast('Patient information updated · ' + data.case_code);
    });

    /* spec §12: ambulance reports arrival. Move the active card to
       Recently Handled. The persistent state is now ARRIVED on the
       server, so a refresh will not pull the case back into Active. */
    socket.on('case:arrived', function (data) {
      if (!data || !data.case_code) return;
      var c = state.active[data.case_code];
      if (!c) {
        /* We weren't actively watching — ask the server to confirm and refresh. */
        refreshQueue(false);
        return;
      }
      c.status = 'ARRIVED';
      c.arrived_at = data.arrived_at || new Date().toISOString();
      c.lifecycle = 'resolved';
      archive(c, 'Patient arrived — case closed', 'outcome-arrived');
      toast('Patient arrived · ' + data.case_code + ' is now in Recently handled');
    });

    /* The ambulance may broadcast cancellation of arrival (rare). */
    socket.on('case:active', function (data) {
      if (!data || !data.case_code) return;
      addActive(data, true);
    });
  }

  /* ── Boot ─────────────────────────────────────────────────────────────── */

  /* Browsers refuse to start an AudioContext before the page has been
     interacted with, so the very first incoming case would arrive in silence.
     One cheap listener on the first click or key press fixes it. */
  function primeAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('pointerdown', primeAudio, { once: true });
  window.addEventListener('keydown', primeAudio, { once: true });

  $('soundBtn').addEventListener('click', function () {
    state.sound = !state.sound;
    this.setAttribute('aria-pressed', String(state.sound));
    $('soundIcon').textContent = state.sound ? '🔔' : '🔕';
    this.title = state.sound ? 'Alert sound on' : 'Alert sound muted';
    if (state.sound) chime(false);
  });

  loadIdentity().then(function () {
    if (!state.hospital) return;      /* refused — the message is already on screen */
    connect();
    refreshQueue(false);
    setInterval(function () { refreshQueue(true); }, POLL_MS);
  });
})();
