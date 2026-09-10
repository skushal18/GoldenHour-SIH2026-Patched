/* ============================================================================
   GoldenHour v5 — desk board runtime.
   - Wires socket for broadcast:new / broadcast:claimed / patient:updated / case:position
   - Renders columns Incoming / Active / Network status
   - Capacity strip + printable handover + analytics short link
   ========================================================================== */
'use strict';

import './style.css';

(function(){
  const cfg = window.GH_DESK_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const override = cfg.FORCE_HOSPITAL || params.get('hospital') || undefined;
  const sound = cfg.ENABLE_SOUND;

  /* How long an arrived case stays on the board before it clears itself. */
  const ARRIVED_DWELL_MS = Number(cfg.ARRIVED_DWELL_MS) || 25000;

  function apiBase(){ return location.origin.replace(/\/$/, '') + '/api/v1'; }

  /* These were used on the first line of the theme setup and defined nowhere,
     so the module threw before it rendered anything: the board showed its
     static "ER Desk / connecting…" markup for ever, on every desk. */
  const $  = sel => document.querySelector(sel);
  const $$ = sel => Array.prototype.slice.call(document.querySelectorAll(sel));

  function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function bandBp(sys, dia){
    if (sys==null) return null;
    if (sys < 90 || dia < 60) return 'critical';
    if (sys < 110 || dia < 70) return 'caution';
    return 'good';
  }
  function bandHr(hr){ if (hr==null) return null; if (hr>130||hr<40) return 'critical'; if (hr>120||hr<50) return 'caution'; return 'good'; }
  function bandRr(rr){ if (rr==null) return null; if (rr>30||rr<8) return 'critical'; if (rr>24||rr<10) return 'caution'; return 'good'; }
  function bandSpo2(v){ if (v==null) return null; if (v<90) return 'critical'; if (v<95) return 'caution'; return 'good'; }

  /* === theme === */
  function setTheme(v){
    if (v === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', v);
    try { localStorage.setItem('goldenhour.theme', JSON.stringify(v)); } catch(_){}
    $('#themeToggle').textContent = v === 'dark' ? '☾' : v === 'auto' ? '◐' : '☀';
  }
  setTheme(JSON.parse(localStorage.getItem('goldenhour.theme')||'null') || 'auto');
  $('#themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'auto';
    setTheme(cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto');
  });
  $('#soundToggle').addEventListener('click', () => {
    cfg.ENABLE_SOUND = !cfg.ENABLE_SOUND;
    $('#soundToggle').textContent = cfg.ENABLE_SOUND ? '🔊' : '🔇';
    try { localStorage.setItem('goldenhour.deskSound', JSON.stringify(cfg.ENABLE_SOUND)); } catch(_){}
  });

  /* === state === */
  const state = {
    identity: null,
    pending: [],
    active: [],
    capacity: { resus_bays_available: 3, ventilators_available: 2, ct_available: true, ot_available: true, blood_available: true, cathlab_available: true, diversion_active: false },
    network: [],
    socket: null,
    capacityPublished: false,
  };
  /* A short synthesised tone. The previous data: URL was a truncated WAV
     header that no browser could decode, so the "new case" alert on a busy ER
     desk was silent. WebAudio needs no asset and no network. */
  function beep(){
    if (!cfg.ENABLE_SOUND) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      state.audio = state.audio || new Ctx();
      if (state.audio.state === 'suspended') state.audio.resume();
      const osc = state.audio.createOscillator();
      const gain = state.audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, state.audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, state.audio.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, state.audio.currentTime + 0.35);
      osc.connect(gain).connect(state.audio.destination);
      osc.start();
      osc.stop(state.audio.currentTime + 0.36);
    } catch(_){}
  }

  /* === init: who am I === */
  async function init(){
    try{
      const r = await fetch(apiBase() + '/desk/me' + (override ? '?hospital=' + override : ''));
      const body = await r.json();
      state.identity = body;
      $('#hospitalName').textContent = body.hospital.name;
      $('#hospitalMeta').textContent = (body.matched_by || 'ip') + ' · ip ' + (body.client_ip || '—');
      if (body.capacity){ state.capacity = Object.assign({}, state.capacity, body.capacity); paintCapacity(); }
    }catch(err){
      $('#hospitalName').textContent = 'ER Desk (offline)';
      $('#hospitalMeta').textContent = 'no backend';
    }
    await refreshQueue();
    startRealtime();
  }

  /* === REST === */
  async function refreshQueue(){
    try{
      const r = await fetch(apiBase() + '/desk/queue' + (override ? '?hospital=' + override : ''));
      const body = await r.json();
      state.pending = body.pending || [];
      state.active  = body.active || [];
      paintBoard();
      await paintNetworkSidebar();
    }catch(e){ console.warn('refreshQueue', e); }
  }

  async function paintNetworkSidebar(){
    try {
      const r = await fetch(apiBase() + '/desk/capacity/all');
      const body = await r.json();
      state.network = body.capacity || [];
      paintNetwork(body);
    } catch(_){}
  }

  async function fetchTrack(caseCode){
    try{
      const r = await fetch(apiBase() + '/desk/track/' + caseCode + (override ? '?hospital=' + override : ''));
      if (!r.ok) return null;
      return await r.json();
    }catch(_){ return null; }
  }

  async function fetchHandover(caseCode){
    try{
      const r = await fetch(apiBase() + '/desk/handover/' + caseCode + (override ? '?hospital=' + override : ''));
      if (!r.ok) return null;
      return await r.json();
    }catch(_){ return null; }
  }

  /* === realtime === */
  function startRealtime(){
    if (!window.io) return;
    const sock = state.socket = window.io({ transports:['websocket','polling'],
      query: Object.assign({ role: 'hospital' }, override ? { hospital: String(override) } : {}) });
    sock.on('connect', () => console.log('socket connected'));
    sock.on('hospital:identity', d => {
      state.identity = d;
      $('#hospitalName').textContent = d.hospital.name;
      $('#hospitalMeta').textContent = d.matched_by + ' · ip ' + (d.client_ip || '—');
      /* Declare what this desk has free the moment it is identified. Until a
         desk publishes, the server has no capacity record for it: the board
         cannot say whether a need is met, the network sidebar is empty, and
         match_score falls back to the "unknown" penalty for every case. */
      if (!state.capacityPublished){ state.capacityPublished = true; socketSendCapacity(); }
    });
    sock.on('broadcast:new', card => addOrUpdatePending(card));
    sock.on('broadcast:claimed', data => removeClaimed(data.case_code, data));
    sock.on('broadcast:expired', data => removeCase(data.case_code));
    sock.on('broadcast:cancelled', data => removeCase(data.case_code));
    sock.on('broadcast:declined', data => removeCase(data.case_code));
    sock.on('patient:updated', data => updatePatient(data));
    sock.on('case:arrived', data => { paintArrived(data); toast('Arrived'); });
    sock.on('case:position', data => updatePosition(data));
    sock.on('capacity:changed', payload => {
      paintNetworkFromCapacity(payload);
      const isMine = state.identity && payload.hospital_id === state.identity.hospital.hospital_id;
      if (isMine){ state.capacity = Object.assign({}, state.capacity, payload.capacity); paintCapacity(); }
    });
    sock.on('hospital:rejected', d => { alert(d.message || 'Identity rejected'); });
  }

  /* === board paint === */
  function paintBoard(){
    $('#cntPending').textContent = state.pending.length;
    /* The count is "how many ambulances are still coming". An arrived case
       stays on the board briefly as confirmation, but counting it would tell
       the charge nurse to expect a patient who is already in the department. */
    $('#cntActive').textContent = state.active.filter(c => c.status !== 'ARRIVED').length;
    $('#pendingList').innerHTML = state.pending.map(renderPending).join('') || '<div class="net-empty">No incoming cases.</div>';
    $('#activeList').innerHTML  = state.active.map(renderActive).join('')  || '<div class="net-empty">No active cases.</div>';
    bindCardActions();
  }

  function myHospitalId(){ return state.identity ? state.identity.hospital.hospital_id : null; }

  function addOrUpdatePending(card){
    card.lifecycle = card.lifecycle || 'pending';
    card._accept_state = computeAcceptState(card);
    if (card.accepted_hospital_id && card.accepted_hospital_id === myHospitalId()){
      const idx = state.active.findIndex(c => c.case_code === card.case_code);
      card._accept_state = 'won';
      if (idx < 0) state.active.push(card); else state.active[idx] = card;
      paintBoard(); return;
    }
    const idx = state.pending.findIndex(c => c.case_code === card.case_code);
    if (idx < 0){ state.pending.unshift(card); beep(); }
    else state.pending[idx] = card;
    paintBoard();
  }

  function removeClaimed(code, data){
    state.pending = state.pending.filter(c => c.case_code !== code);
    if (state.active.find(c => c.case_code === code)){
      paintBoard(); return;
    }
    if (data && data.accepted_hospital_id === myHospitalId()){
      /* pulled by us; we need to fetch */
      fetch(apiBase() + '/desk/queue' + (override ? '?hospital=' + override : ''))
        .then(r => r.json()).then(b => { state.active = b.active || []; paintBoard(); });
    }
    paintBoard();
  }
  function removeCase(code){
    state.pending = state.pending.filter(c => c.case_code !== code);
    state.active = state.active.filter(c => c.case_code !== code);
    paintBoard();
  }
  function updatePatient(payload){
    ['pending','active'].forEach(list => state[list] = state[list].map(c => c.case_code === payload.case_code ? Object.assign({}, c, { patient: payload.patient, notes: payload.notes, patient_history: payload.patient_history || c.patient_history, last_patient_updated_at: payload.updated_at }) : c));
    paintBoard();
    toast('Patient updated');
  }
  function updatePosition(payload){
    const c = state.active.find(c => c.case_code === payload.case_code);
    if (c){ c.last_position = payload; c.live_eta_minutes = payload.live_eta_minutes; c.eta_source = payload.eta_source; paintBoard(); }
  }
  function paintArrived(data){
    const c = state.active.find(c => c.case_code === data.case_code);
    if (!c) return;
    c.status = 'ARRIVED';
    c.arrived_at = data.arrived_at;
    paintBoard();
    if (cfg.PRINT_ON_ARRIVE) printHandover(data.case_code);
    /* Show the arrival, then clear the board. Leaving the card in the Active
       column for ever would mean an ER that ran twenty cases could not see
       the one ambulance still on its way. The dwell is what makes it obvious
       to the desk that the arrival registered. */
    setTimeout(() => {
      state.active = state.active.filter(x => x.case_code !== data.case_code);
      paintBoard();
    }, ARRIVED_DWELL_MS);
  }

  function computeAcceptState(card){
    if (!card) return 'plain';
    if (!myHospitalId()) return 'plain';
    if (card.accepted_hospital_id && card.accepted_hospital_id !== myHospitalId()) return 'lost';
    const unmet = unmetNeeds(card);
    const diverting = card.capacity && card.capacity.diversion_active;
    if (unmet.length === 0 && !diverting) return 'plain';
    return (unmet.length === 0 ? 'under_warning_divert' : 'under_warning_unmet');
  }

  /* An unmet need is one this hospital has told the system it cannot meet.
     A hospital that has reported nothing has not said "no" — it has said
     nothing, and painting that as ✗ would tell a charge nurse she has no
     ventilator when she may have four. Unknown is scored down by
     matchService and shown as "?" on the card, never as a refusal. */
  function unmetNeeds(card){
    if (!card.needs || !card.capacity) return [];
    const n = card.needs;
    const c = card.capacity;
    const out = [];
    if (n.needs_ventilator && (c.ventilators_available|0) === 0) out.push('ventilator');
    if (n.needs_blood && !c.blood_available) out.push('blood');
    if (n.needs_imaging && !c.ct_available) out.push('CT');
    if (n.needs_ot && !c.ot_available) out.push('OT');
    if (n.needs_cathlab && !c.cathlab_available) out.push('cath-lab');
    return out;
  }

  function needHint(card){
    const unmet = unmetNeeds(card);
    if (!unmet.length) return null;
    /* find closest hospital that can meet */
    return unmet.map(u => u).join(', ');
  }

  /* Both card renderers go through this, because they drifted once already:
     the active card emitted bare pills with no row wrapper, so each one
     became a full-width row of the card's flex column. */
  function wrapRow(cls, html){ return html ? `<div class="${cls}">${html}</div>` : ''; }

  /* === render pending === */
  function renderPending(card){
    const pat = card.patient || {}; const v = pat.vitals || {};
    const unmet = unmetNeeds(card); const diverting = card.capacity && card.capacity.diversion_active;
    const css = `case priority-${card.priority || 'GREEN'} ${card._accept_state?.startsWith('under_warning') ? 'case-warning' : ''}`;
    const badge = renderBadge(card.priority);
    const countdown = renderCountdown(card.expires_at);
    const facts = renderFacts(card);
    const flags = renderFlags(card.critical_flags);
    const vitals = renderVitals(v);
    const needs = renderNeeds(card.needs, card.capacity);
    const acceptLabel = (unmet.length || diverting) ? 'Accept anyway' : 'Accept';
    const warning = unmet.length ? `<span class="btn-accept-underwarning-text">⚠ You are missing ${unmet.join(', ')}</span>` : (diverting ? '<span class="btn-accept-underwarning-text">⚠ You are on diversion</span>' : '');
    return `<article class="${css}" data-case="${card.case_code}">
      <div class="case-head">
        <div class="case-title">
          <span class="eyebrow">${escapeHtml((card.case_category || '').toUpperCase())} · ${escapeHtml((card.critical_flags && (card.critical_flags.cardiac_arrest||card.critical_flags.low_gcs||card.critical_flags.shock||card.critical_flags.hypoxia||card.critical_flags.airway_compromise) ? 'CRITICAL' : ''))}</span>
          <h3>${escapeHtml(card.chief_complaint || 'Case')}</h3>
          <span class="sub">${escapeHtml(card.case_code)} · ${card.distance_km != null ? card.distance_km.toFixed(1)+' km' : ''}</span>
        </div>
        <div class="case-id-actions">
          ${badge}
          ${countdown}
        </div>
      </div>
      ${wrapRow('facts-row', facts)}
      ${wrapRow('flag-row', flags)}
      ${wrapRow('vitalbox-grid', vitals)}
      ${wrapRow('needs-row', needs)}
      ${card.notes ? `<div class="note-block"><span class="eyebrow">Crew note</span><p>${escapeHtml(card.notes)}</p></div>` : ''}
      <div class="case-actions">
        <button class="btn-accept" data-action="accept" data-cc="${card.case_code}">${acceptLabel}</button>
        ${warning}
        <button class="btn-decline" data-action="decline" data-cc="${card.case_code}">Decline</button>
      </div>
    </article>`;
  }

  /* === render active === */
  function renderActive(card){
    const pat = card.patient || {}; const v = pat.vitals || {};
    return `<article class="case priority-${card.priority || 'GREEN'} ${card.status==='ARRIVED' ? 'outcome-arrived':''}" data-case="${card.case_code}">
      <div class="case-head">
        <div class="case-title">
          <span class="eyebrow">${escapeHtml((card.case_category || '').toUpperCase())} · en route</span>
          <h3>${escapeHtml(card.chief_complaint || 'Case')}</h3>
          <span class="sub">${escapeHtml(card.case_code)}${card.distance_km != null ? ' · '+card.distance_km.toFixed(1)+' km' : ''} · ETA ${renderEta(card)}</span>
        </div>
        ${renderBadge(card.priority)}
      </div>
      ${wrapRow('facts-row', renderFacts(card))}
      ${wrapRow('flag-row', renderFlags(card.critical_flags))}
      ${wrapRow('vitalbox-grid', renderVitals(v))}
      ${wrapRow('needs-row', renderNeeds(card.needs, card.capacity))}
      ${drawTrackPanel(card)}
      ${card.notes ? `<div class="note-block"><span class="eyebrow">Crew note</span><p>${escapeHtml(card.notes)}</p></div>` : ''}
      <div class="case-actions">
        <button class="btn-accept" data-action="print" data-cc="${card.case_code}" style="background: var(--brand-wash); color: var(--brand-ink); border: 1px solid var(--brand-line);">Print handover</button>
        ${card.status !== 'ARRIVED' ? '<span class="outcome-ribbon outcome-won">✓ You accepted · ' + acceptTime(card) + '</span>' : '<span class="outcome-ribbon outcome-arrived">✓ Arrived '+escapeHtml(card.arrived_at || '')+'</span>'}
      </div>
    </article>`;
  }

  function renderBadge(p){ return `<span class="badge badge-${p || 'GREEN'}">${p || 'GREEN'} · ${({RED:'CRITICAL',AMBER:'URGENT',GREEN:'STABLE'})[p || 'GREEN']}</span>`; }
  function renderEta(card){ return card.live_eta_minutes ? card.live_eta_minutes + ' min' : (card.eta_minutes ? card.eta_minutes+' min' : '—'); }
  function acceptTime(card){ if (!card.accepted_at) return ''; const ms = new Date() - new Date(card.accepted_at); return Math.round(ms/1000)+'s ago'; }
  function renderCounts(target, msLeft){ /* kept simple */ }
  function renderCountdown(expires_at){
    if (!expires_at) return '';
    function tick(){
      const ms = new Date(expires_at) - new Date();
      if (ms <= 0) return 'expired';
      const s = Math.round(ms/1000);
      const urgent = ms < 60_000;
      return `<span class="countdown ${urgent?'is-urgent':''}">${s}s</span>`;
    }
    return tick();
  }
  function renderFacts(card){
    const p = card.patient || {};
    const v = p.vitals || {};
    const f = [];
    if (p.age != null) f.push({ k:'PATIENT', l:`${card.patient.age} ${({M:'m',F:'f',O:'·',U:'?'})[card.patient.gender || 'U']}` });
    if (p.consciousness) f.push({ k:'CONSCIOUSNESS', l: p.consciousness });
    if (p.blood_group) f.push({ k:'BLOOD', l: p.blood_group });
    if (card.stroke_assessment){
      const sa = card.stroke_assessment;
      const positives = [sa.face && 'face', sa.arm && 'arm', sa.speech && 'speech'].filter(Boolean);
      const onset = sa.onset_hours != null ? sa.onset_hours + 'h since onset' : 'onset unknown';
      f.push({ k:'FAST', l: (positives.length ? positives.join(' + ') : 'no deficit') + ' · ' + onset, c:'fact-brand' });
    }
    if (v.systolic_bp != null && v.diastolic_bp != null) f.push({ k:'BP', l: `${v.systolic_bp}/${v.diastolic_bp}` });
    if (v.heart_rate != null) f.push({ k:'HR', l: v.heart_rate + ' bpm' });
    if (v.spo2 != null) f.push({ k:'SpO₂', l: v.spo2+'%' });
    if (card.distance_km != null) f.push({ k:'DISTANCE', l: card.distance_km.toFixed(1) + ' km' });
    if (card.match_score != null) f.push({ k:'MATCH', l: String(card.match_score) });
    /* An origin the crew typed is not a measured position, and a distance
       computed from it deserves to be read with more caution. */
    if (card.origin && card.origin.source && card.origin.source !== 'gps'){
      f.push({ k:'POSITION', l: card.origin.source === 'manual' ? 'typed by crew' : String(card.origin.source), c:'fact-warn' });
    }
    return f.map(x => `<span class="fact ${x.c || ''}"><span class="fact-k">${escapeHtml(x.k)}</span>${escapeHtml(x.l)}</span>`).join('');
  }
  function renderFlags(flags){
    if (!flags) return '';
    const out = [];
    if (flags.shock) out.push('shock');
    if (flags.hypoxia) out.push('hypoxia');
    if (flags.low_gcs) out.push('low GCS');
    if (flags.cardiac_arrest) out.push('cardiac arrest');
    if (flags.airway_compromise) out.push('airway compromise');
    return out.map(s => `<span class="flag">${escapeHtml(s)}</span>`).join('');
  }
  function renderVitals(v){
    const items = [
      ['BP', (v.systolic_bp != null && v.diastolic_bp != null) ? `${v.systolic_bp}/${v.diastolic_bp}` : '—', bandBp(v.systolic_bp, v.diastolic_bp)],
      ['HR', v.heart_rate != null ? `${v.heart_rate} <span class="vunit">bpm</span>` : '—', bandHr(v.heart_rate)],
      ['SpO₂', v.spo2 != null ? `${v.spo2}<span class="vunit">%</span>` : '—', bandSpo2(v.spo2)],
      ['RR',  v.resp_rate != null ? `${v.resp_rate} <span class="vunit">/m</span>` : '—', bandRr(v.resp_rate)],
    ];
    return items.map(([k, val, band]) => `<div class="vitalbox state-${band || 'good'}"><b>${val}</b><span>${k}</span></div>`).join('');
  }
  function renderNeeds(needs, capacity){
    if (!needs) return '';
    const items = [
      ['Vent', needs.needs_ventilator, !!capacity && (capacity.ventilators_available | 0) > 0],
      ['Blood', needs.needs_blood, !!capacity && !!capacity.blood_available],
      ['CT', needs.needs_imaging, !!capacity && !!capacity.ct_available],
      ['OT', needs.needs_ot, !!capacity && !!capacity.ot_available],
      ['Cath', needs.needs_cathlab, !!capacity && !!capacity.cathlab_available],
    ];
    const unknown = !capacity;
    return items.filter(([k, need]) => need).map(([k, _need, met]) => {
      const cls = unknown ? 'unknown' : (met ? 'met' : 'unmet');
      const glyph = unknown ? '?' : (met ? '✓' : '✗');
      const title = unknown ? 'This hospital has not reported its capacity' : (met ? 'Available' : 'Not available here');
      return `<span class="need-chip ${cls}" title="${title}">${glyph} ${k}</span>`;
    }).join('');
  }

  function drawTrackPanel(card){
    const live = typeof card.live_eta_minutes === 'number' && card.live_eta_minutes !== null;
    /* The source label beside this already says LIVE / CREW ESTIMATE, so the
       number does not have to repeat it. */
    const etaText = card.live_eta_minutes ? `${card.live_eta_minutes} min`
      : (card.eta_minutes ? `${card.eta_minutes} min` : '—');
    const source = card.eta_source || 'crew';
    return `<div class="map-panel">
      <div class="map-head">
        <span class="map-eta">${etaText}</span>
        <span class="map-source source-${source}">${({live:'LIVE',crew:'CREW ESTIMATE',stalled:'NOT MOVING'})[source] || source}</span>
      </div>
      <div class="map-readout">${card.last_position ? `${Number(card.last_position.speed_kmh||0).toFixed(0)} km/h · ${(card.distance_km||0).toFixed(1)} km away · updated ${formatTime(card.last_position.at)}` : 'Waiting for first GPS fix…'}</div>
      <div class="map-placeholder" aria-hidden="true">${(card.last_position && card.last_position.lat != null) ? `${card.last_position.lat.toFixed(4)}, ${card.last_position.lng.toFixed(4)}` : 'No position received yet'}</div>
      <div class="map-readout">Location is shared with this accepting hospital only — from acceptance until arrival.</div>
    </div>`;
  }
  function formatTime(iso){ if (!iso) return '—'; const d = new Date(iso); return d.toLocaleTimeString(); }

  /* === network sidebar === */
  function paintNetwork(body){
    const list = state.network.filter(n => state.identity && n.hospital_id !== state.identity.hospital.hospital_id);
    $('#cntHosp').textContent = state.network.length;
    $('#netList').innerHTML = state.network.map(h => {
      const cap = h;
      const divert = cap.diversion_active ? 'is-warn' : '';
      return `<div class="net-item ${divert}">
        <span class="hospital-name">${escapeHtml(cityName(h.hospital_id))} <span class="eyebrow">${cap.diversion_active?'· DIVERTING':''}</span></span>
        <span class="net-meta">${cap.resus_bays_available} resus · ${cap.ventilators_available} vent · ${cap.ct_available?'CT ok':'no CT'} · ${cap.blood_available?'blood ok':'NO blood'} · ${cap.cathlab_available?'cath-lab ok':'no cath-lab'}</span>
        <span class="score">${capAge(cap.updated_at)}</span>
      </div>`;
    }).join('') || '<div class="net-empty">No other hospitals reported.</div>';
  }
  function paintNetworkFromCapacity(p){
    const idx = state.network.findIndex(x => x.hospital_id === p.hospital_id);
    if (idx >= 0) state.network[idx] = Object.assign({}, state.network[idx], p.capacity);
    else state.network.push(Object.assign({hospital_id: p.hospital_id}, p.capacity));
    paintNetwork({capacity: state.network});
    const mine = state.identity && p.hospital_id === state.identity.hospital.hospital_id;
    if (mine){
      state.capacity = Object.assign({}, state.capacity, p.capacity);
      const divertBtn = $('#divertBtn');
      if (divertBtn) divertBtn.classList.toggle('is-warn', !!p.capacity.diversion_active);
      $('#diversionBanner').hidden = !p.capacity.diversion_active;
      paintCapacity();
    }
  }
  /* Capacity nobody has touched in an hour is a guess, and the sidebar says
     so rather than presenting it with the same confidence as a fresh figure. */
  function capAge(updatedAt){
    if (!updatedAt) return 'not reported';
    const mins = (Date.now() - new Date(updatedAt).getTime()) / 60000;
    if (!Number.isFinite(mins)) return 'not reported';
    if (mins > 60) return 'stale · ' + ageOf(updatedAt);
    return ageOf(updatedAt);
  }
  function cityName(id){ return ({1:'City Emergency Hospital', 2:'Apollo Hospital', 3:'Manipal Hospital', 4:'Victoria Hospital'})[id] || ('Hospital #' + id); }

  /* === capacity strip === */
  function paintCapacity(){
    $('#capResus').textContent = state.capacity.resus_bays_available;
    $('#capVent').textContent  = state.capacity.ventilators_available;
    setToggle('ct',    state.capacity.ct_available);
    setToggle('ot',    state.capacity.ot_available);
    setToggle('blood', state.capacity.blood_available);
    setToggle('cath',  state.capacity.cathlab_available);
    setToggle('diversion', !!state.capacity.diversion_active);
    const u = state.capacity.updated_at; if (u) $('#capUpdated').textContent = 'updated ' + ageOf(u);
  }
  function setToggle(key, on){
    const b = document.querySelector('[data-toggle="'+key+'"]'); if (!b) return;
    b.classList.toggle('is-on', !!on); b.classList.toggle('is-warn', key==='diversion' && !!on);
  }
  function ageOf(iso){
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return 'just now';
    if (ms < 3600_000) return Math.floor(ms/60_000) + ' min ago';
    return Math.floor(ms/3600_000) + ' h ago';
  }

  /* === capacity actions === */
  document.querySelectorAll('.capacity .step').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.step;
    const delta = Number(b.dataset.delta);
    const maps = { resus:'resus_bays_available', vent:'ventilators_available' };
    state.capacity[maps[key]] = Math.max(0, (state.capacity[maps[key]] || 0) + delta);
    paintCapacity();
    socketSendCapacity();
  }));
  document.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.toggle;
    const maps = { ct:'ct_available', ot:'ot_available', blood:'blood_available', cath:'cathlab_available', diversion:'diversion_active' };
    state.capacity[maps[t]] = !state.capacity[maps[t]];
    if (t === 'diversion' && state.capacity.diversion_active && !confirm('Switch this desk to diversion?')){ state.capacity.diversion_active = false; }
    paintCapacity();
    socketSendCapacity();
  }));
  let capDebounce = null;
  function socketSendCapacity(){
    clearTimeout(capDebounce);
    capDebounce = setTimeout(() => {
      if (!state.socket || !state.socket.connected){
        /* No realtime channel — fall back to the REST route so a desk on a
           flaky connection can still declare it has no ventilator free. */
        fetch(apiBase() + '/desk/capacity' + (override ? '?hospital=' + override : ''), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state.capacity),
        }).then(r => r.json())
          .then(b => { if (b && b.capacity) { state.capacity = Object.assign({}, state.capacity, b.capacity); paintCapacity(); } })
          .catch(() => toast('Capacity not saved — no connection'));
        return;
      }
      state.socket.emit('capacity:updated', state.capacity, ack => {
        /* The ack is an envelope: { success, ...capacity }. Assigning it whole
           would put `success: true` into the capacity record and send it back
           on the next update. */
        if (!ack || !ack.success) return;
        const { success, reason, message, ...capacity } = ack;
        state.capacity = Object.assign({}, state.capacity, capacity);
        paintCapacity();
      });
    }, 200);
  }

  /* === actions === */
  function bindCardActions(){
    document.querySelectorAll('[data-action="accept"]').forEach(btn => btn.addEventListener('click', () => {
      const code = btn.dataset.cc;
      btn.disabled = true; btn.textContent = 'Accepting…';
      fetch(apiBase() + '/desk/accept/' + code + (override ? '?hospital=' + override : ''), { method:'POST' })
        .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j)))
        .then(() => refreshQueue())
        .catch(j => { toast('Accept refused: ' + (j && j.message || 'server')); refreshQueue(); });
    }));
    document.querySelectorAll('[data-action="decline"]').forEach(btn => btn.addEventListener('click', () => {
      const code = btn.dataset.cc;
      fetch(apiBase() + '/desk/decline/' + code + (override ? '?hospital=' + override : ''), { method:'POST' })
        .then(() => refreshQueue());
    }));
    document.querySelectorAll('[data-action="print"]').forEach(btn => btn.addEventListener('click', () => printHandover(btn.dataset.cc)));
  }

  /* === print handover === */
  async function printHandover(caseCode){
    const d = await fetchHandover(caseCode); if (!d){ toast('No handover data'); return; }
    const el = $('#handover'); el.hidden = false;
    el.querySelector('.h-meta').innerHTML = `
      <p><b>${escapeHtml(d.case_code)}</b> · ${escapeHtml(d.priority || '')} · ${escapeHtml(d.hospital?.name || '')}</p>
      <p>Created ${formatTime(d.created_at)} · Accepted ${formatTime(d.accepted_at)} · Arrived ${formatTime(d.arrived_at || '')}</p>
      <p>${d.intervals.broadcast_to_accept != null ? `<b>Broadcast → Accept:</b> ${d.intervals.broadcast_to_accept}s · `:''}${d.intervals.accept_to_arrival != null ? `<b>Accept → Arrival:</b> ${d.intervals.accept_to_arrival}s`:''}</p>`;
    el.querySelector('.h-vitals').innerHTML = (d.vitals_initial_vs_latest || []).map(v => `<div>${escapeHtml(v.key)}: ${v.initial ?? '—'} → ${v.latest ?? '—'}</div>`).join('');
    el.querySelector('.h-note').innerHTML = `
      ${d.patient_history && d.patient_history.length ? `<p><b>Patient edit history</b></p><ul>${d.patient_history.map(h => `<li>${formatTime(h.at)} · ${Object.keys(h.changed).join(', ')}</li>`).join('')}</ul>` : '<p>No mid-transport edits.</p>'}
      ${d.critical_flags ? `<p><b>Critical flags:</b> ${Object.entries(d.critical_flags).filter(([_,v])=>v).map(([k]) => k).join(', ') || 'none'}</p>` : ''}
      ${d.notes ? `<p><b>Crew note:</b> ${escapeHtml(d.notes)}</p>` : ''}`;
    el.querySelector('.h-footer').innerHTML = `<hr><p>Generated by GoldenHour v5 · ${escapeHtml(d.hospital?.name || '')} · ${new Date().toISOString()} · case ${escapeHtml(d.case_code)}</p>`;
    setTimeout(() => window.print(), 200);
  }

  /* === misc === */
  function toast(t){ const el = $('#toast'); el.textContent = t; el.hidden = false; setTimeout(() => el.hidden = true, 2500); }

  /* === lightbox === */
  document.body.addEventListener('click', e => {
    if (e.target.matches && e.target.matches('.shots-row img')){
      const lb = $('#lightbox'); $('#lightboxImg').src = e.target.src; lb.hidden = false;
    }
  });
  $('#lightboxClose').addEventListener('click', () => $('#lightbox').hidden = true);

  /* === analytics === */
  async function openAnalytics(){
    const panel = $('#analyticsPanel');
    const body = $('#analyticsBody');
    body.innerHTML = '<p class="sheet-note">Loading…</p>';
    panel.hidden = false;
    try {
      const r = await fetch(apiBase() + '/desk/analytics?scope=hospital' + (override ? '&hospital=' + override : ''));
      const d = await r.json();
      const secs = v => v == null ? '—' : (v < 90 ? v + 's' : Math.round(v / 60) + ' min');
      const tiles = [
        ['Time to accept · median', secs(d.time_to_accept && d.time_to_accept.median)],
        ['Time to accept · p90', secs(d.time_to_accept && d.time_to_accept.p90)],
        ['Pre-arrival lead time', secs(d.lead_time && d.lead_time.median)],
        ['Accept rate', (d.accept_rate != null ? d.accept_rate + '%' : '—')],
        ['Cases broadcast', d.counts ? d.counts.created : '—'],
        ['Expired unanswered', d.counts ? d.counts.expired : '—'],
      ];
      body.innerHTML = tiles.map(([label, value]) =>
        `<div class="stat-tile"><span class="eyebrow">${escapeHtml(label)}</span><b>${escapeHtml(String(value))}</b></div>`).join('');
      /* Analytics over a store that forgets on restart is a number nobody
         should quote in a report. Say so on the page, not in a footnote. */
      $('#analyticsStore').textContent = d.store === 'memory'
        ? 'In-memory store — these figures reset every time the server restarts.'
        : 'Persisted in ' + (d.store || 'the database') + '.';
    } catch(_){
      body.innerHTML = '<p class="sheet-note">Analytics are unavailable right now.</p>';
    }
  }
  const analyticsBtn = $('#analyticsBtn');
  if (analyticsBtn) analyticsBtn.addEventListener('click', openAnalytics);
  const analyticsClose = $('#analyticsClose');
  if (analyticsClose) analyticsClose.addEventListener('click', () => { $('#analyticsPanel').hidden = true; });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    ['#analyticsPanel', '#lightbox'].forEach(sel => { const el = $(sel); if (el) el.hidden = true; });
  });

  init();
})();
