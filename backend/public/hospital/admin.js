/* ============================================================================
   GoldenHour desk — super-admin console (window.GHAdmin).
   Create hospital logins (one at a time, or for every hospital at once with
   one-time activation codes), re-issue codes, reset passwords, disable and
   enable logins, manage the GoldenHour directory and import hospitals from
   the national list, watch live cases, read the audit log.
   ========================================================================== */
(function () {
  'use strict';
  var GH = window.GH, $ = GH.$, $$ = GH.$$, esc = GH.esc;
  var me = null, picked = null, timers = [], bound = false, statesLoaded = false;

  var STATE = {
    PENDING: ['Pending activation', 'status-pending'],
    EXPIRED: ['Activation code expired', 'status-change'],
    LOCKED: ['Locked', 'status-locked'],
    DISABLED: ['Disabled', 'status-disabled'],
    ACTIVE: ['Active', 'status-active'],
  };
  function statusOf(a) {
    if (a.state === 'ACTIVE' && a.must_change_password) return ['Must change password', 'status-change'];
    return STATE[a.state] || STATE.ACTIVE;
  }
  function locationLabel(h) {
    return h.coord_source === 'listed' ? 'Listed' : h.coord_source === 'pincode' ? '≈ Pincode ' + esc(h.pincode || '') : h.coord_source === 'district' ? '≈ District centre' : 'Unknown';
  }

  /* ── one-time secrets ────────────────────────────────────────────────── */
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    /* A spreadsheet must not run a cell as a formula. */
    if (/^[=@]/.test(s) || /^[+\-](?!\d)/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function downloadCsv(rows) {
    var activateAt = location.origin + '/hospital/#activate';
    var lines = [['hospital_id', 'hospital', 'district', 'state', 'phone', 'activation_code', 'expires_at', 'activate_at'].join(',')];
    rows.forEach(function (r) {
      lines.push([r.hospital_id, r.hospital, r.district, r.state, r.phone, r.activation_code, r.expires_at, activateAt].map(csvCell).join(','));
    });
    var blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'goldenhour-activation-codes-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function showCode(title, b) {
    var h = b.hospital || {};
    GH.openSheet(title,
      '<p>Give this code to <b>' + esc(h.name || 'the hospital') + '</b> privately. It is shown only now, works once and expires ' + esc(GH.dateTime(b.expires_at)) + '.</p>' +
      '<div class="secret"><code>' + esc(b.activation_code) + '</code></div>' +
      '<p class="sub">They open <b>' + esc(location.origin) + '/hospital/#activate</b>, enter the code and choose their own username and password.</p>');
  }

  /* ── accounts ────────────────────────────────────────────────────────── */
  function loadAccounts() {
    var q = $('#accSearch').value.trim(), st = $('#accState').value, status = $('#accStatus').value;
    GH.api('/admin/accounts?q=' + encodeURIComponent(q) + '&state=' + encodeURIComponent(st) + '&status=' + encodeURIComponent(status)).then(function (b) {
      var rows = (b.accounts || []).map(function (a) {
        var s = statusOf(a), h = a.hospital;
        var who = a.role === 'SUPER_ADMIN' ? '<div style="font-weight:500">GoldenHour administrator</div><div class="sub">Console access only</div>'
          : '<div style="font-weight:500">' + esc(h ? h.name : 'Hospital #' + a.hospital_id) + '</div><div class="sub">' + esc(h ? [h.district, h.state, h.ownership].filter(Boolean).join(' · ') : '') + '</div>';
        var self = me && a.account_id === me.account_id;
        var pending = a.state === 'PENDING' || a.state === 'EXPIRED';
        var btn = function (what, label, cls) { return '<button type="button" class="c-btn-link' + (cls ? ' ' + cls : '') + '" data-acc="' + a.account_id + '" data-do="' + what + '">' + label + '</button>'; };
        var acts = self ? '<span class="sub">you</span>'
          : pending ? btn('code', a.state === 'EXPIRED' ? 'Issue a new code' : 'Re-issue code')
          : (a.role === 'HOSPITAL_STAFF' ? btn('code', 'New activation code') : '') + btn('reset', 'Reset password') +
            (a.status === 'DISABLED' ? btn('enable', 'Enable') : btn('disable', 'Disable', 'danger'));
        var user = a.username ? esc(a.username) : '<span class="sub">chosen at activation</span>';
        var when = pending ? (a.activation_expires_at ? 'Code expires ' + esc(GH.dateTime(a.activation_expires_at)) : '—') : esc(GH.dateTime(a.last_login_at));
        return '<tr data-name="' + esc(a.username || (h ? h.name : '')) + '"><td>' + who + '</td><td class="mono">' + user + '</td><td><span class="status ' + s[1] + '">' + s[0] + '</span></td><td>' + when + '</td><td class="actions">' + acts + '</td></tr>';
      }).join('');
      $('#accRows').innerHTML = rows || '<tr><td colspan="5" class="table-empty">No logins match. Create them with “Create logins for all hospitals”, or one at a time with the form on the right.</td></tr>';
    }).catch(function (e) { $('#accRows').innerHTML = '<tr><td colspan="5" class="table-empty">' + esc(e.message) + '</td></tr>'; });
  }

  function accountAction(id, what, btn) {
    var name = btn.closest('tr').dataset.name;
    var ask = { reset: 'Reset the password for ' + name + '? Their current sessions end and they get a new temporary password.',
      code: 'Issue a new activation code for ' + name + '? Any earlier code stops working; if the login is in use, its password stops working and the hospital chooses a new username and password with the code.',
      disable: 'Disable ' + name + '? Their ER desk is signed out at once.', enable: 'Enable ' + name + ' again?' }[what];
    if (!window.confirm(ask)) return;
    btn.disabled = true;
    var path = { reset: 'reset-password', code: 'activation', disable: 'disable', enable: 'enable' }[what];
    GH.api('/admin/accounts/' + id + '/' + path, { method: 'POST', body: {} }).then(function (b) {
      if (what === 'reset') {
        GH.openSheet('New temporary password',
          '<p>Give this to <b>' + esc(b.account.username) + '</b> privately. It is shown only now; they must change it at first sign-in.</p>' +
          '<div class="secret"><code>' + esc(b.temporary_password) + '</code></div>');
      } else if (what === 'code') showCode('New activation code', b);
      else GH.toast(what === 'disable' ? name + ' disabled' : name + ' enabled');
      loadAccounts(); loadCoverage();
    }).catch(function (e) { GH.toast(e.message); btn.disabled = false; });
  }

  function bulkCreate() {
    if (!window.confirm('Create a login, waiting for activation, for every hospital in the GoldenHour directory that does not have one?\n\nThe activation codes are downloaded once, as a CSV. Keep that file safe and delete it once the hospitals have activated.')) return;
    var btn = $('#bulkBtn');
    btn.disabled = true; btn.textContent = 'Creating…';
    GH.api('/admin/accounts/activation-codes', { method: 'POST', body: {}, timeoutMs: 120000 }).then(function (b) {
      var rows = b.created || [];
      if (rows.length) downloadCsv(rows);
      GH.openSheet(rows.length ? 'Logins created' : 'Nothing to create',
        rows.length
          ? '<p><b>' + rows.length + '</b> hospital login' + (rows.length === 1 ? '' : 's') + ' created, waiting for activation. The codes were downloaded as a CSV' +
            (b.skipped ? '; ' + b.skipped + ' hospital' + (b.skipped === 1 ? ' already has' : 's already have') + ' a login and kept it' : '') + '.</p>' +
            '<p>The codes are not stored anywhere else and cannot be shown again. If the download did not start, download it now — after you close this, a lost code can only be replaced by re-issuing it.</p>' +
            '<button type="button" class="c-btn c-btn-primary" id="bulkAgain">Download the CSV</button>'
          : '<p>Every hospital in the GoldenHour directory already has a login (' + b.skipped + '). Re-issue a code from the list for any that need one.</p>');
      var again = $('#bulkAgain');
      if (again) again.addEventListener('click', function () { downloadCsv(rows); });
      loadAccounts(); loadCoverage();
    }).catch(function (e) { GH.toast(e.message); })
      .then(function () { btn.disabled = false; btn.textContent = 'Create logins for all hospitals'; });
  }

  /* ── create one ──────────────────────────────────────────────────────── */
  function mode() { var r = $('input[name="createMode"]:checked'); return r ? r.value : 'activation'; }
  function syncMode() { $('#createUserField').hidden = mode() !== 'password'; }

  var pickTimer = null;
  function searchPicker() {
    var q = $('#createHospital').value.trim(), list = $('#createPicker');
    picked = null;
    if (q.length < 2) { list.hidden = true; return; }
    clearTimeout(pickTimer);
    pickTimer = setTimeout(function () {
      GH.api('/admin/directory?limit=12&q=' + encodeURIComponent(q)).then(function (b) {
        var hs = (b.hospitals || []).filter(function (h) { return h.active !== false; });
        list.innerHTML = hs.length ? hs.map(function (h) {
          return '<button type="button" role="option" data-hid="' + h.hospital_id + '">' +
            (h.has_login ? '<span class="tag">has a login</span>' : '') + esc(h.name) +
            '<span class="sub">' + esc([h.district, h.state, h.pincode].filter(Boolean).join(' · ')) + ' · ' + (h.coord_source === 'listed' ? 'location listed' : h.coord_source === 'pincode' ? 'location approx. (pincode)' : h.coord_source === 'district' ? 'location approx. (district centre)' : 'no location') + '</span></button>';
        }).join('') : '<button type="button" disabled>No hospital in the GoldenHour directory matches “' + esc(q) + '”. Add it from the national list on the Directory tab.</button>';
        list.hidden = false;
        list._data = hs;
      }).catch(function () { list.hidden = true; });
    }, 200);
  }
  function pick(hid) {
    var list = $('#createPicker'), h = (list._data || []).filter(function (x) { return x.hospital_id === Number(hid); })[0];
    if (!h) return;
    picked = h; list.hidden = true;
    $('#createHospital').value = h.name;
    $('#createHospitalHint').textContent = [h.district, h.state].filter(Boolean).join(', ') + ' · directory ID ' + h.hospital_id +
      (h.coord_source === 'listed' ? ' · location listed' : ' · location approximate — distances to this hospital are estimates') + (h.has_login ? ' · already has a login' : '');
    var words = h.name.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter(function (w) { return w && ['the', 'and', 'of', 'hospital', 'hospitals', 'pvt', 'ltd', 'private', 'limited', 'centre', 'center', 'st', 'dr', 'shri', 'sri'].indexOf(w) === -1; });
    $('#createUser').value = 'er.' + (words.slice(0, 2).join('-') || 'hospital') + '.' + h.hospital_id;
    (mode() === 'password' ? $('#createUser') : $('#createBtn')).focus();
  }
  function create(e) {
    e.preventDefault();
    var err = $('#createError'), btn = $('#createBtn'), m = mode();
    err.hidden = true; $('#createResult').hidden = true;
    if (!picked) { err.textContent = 'Pick a hospital from the list first.'; err.hidden = false; $('#createHospital').focus(); return; }
    btn.disabled = true; btn.textContent = 'Creating…';
    var body = m === 'activation' ? { hospital_id: picked.hospital_id, mode: 'activation' } : { hospital_id: picked.hospital_id, username: $('#createUser').value.trim() };
    GH.api('/admin/accounts', { method: 'POST', body: body }).then(function (b) {
      $('#createResultText').textContent = m === 'activation'
        ? 'Login created for ' + b.hospital.name + ', waiting for activation.'
        : 'Login created for ' + b.hospital.name + ': ' + b.account.username;
      $('#createSecretLabel').textContent = m === 'activation' ? 'Activation code' : 'Temporary password';
      $('#createSecretHint').textContent = m === 'activation'
        ? 'Shown once; works once; expires ' + GH.dateTime(b.expires_at) + '. The hospital opens ' + location.origin + '/hospital/#activate and chooses its own username and password.'
        : 'Shown once. Give it to the hospital privately; they must change it at first sign-in.';
      $('#createSecret').textContent = m === 'activation' ? b.activation_code : b.temporary_password;
      $('#createResult').hidden = false;
      $('#createHospital').value = ''; $('#createUser').value = ''; picked = null;
      $('#createHospitalHint').textContent = 'Pick a hospital from the list.';
      loadAccounts(); loadCoverage(); loadDirectory();
    }).catch(function (e2) { err.textContent = e2.message; err.hidden = false; })
      .then(function () { btn.disabled = false; btn.textContent = 'Create login'; });
  }

  /* ── GoldenHour directory (the hospitals table) ──────────────────────── */
  var dirTimer = null;
  function loadDirectory() {
    clearTimeout(dirTimer);
    dirTimer = setTimeout(function () {
      var q = $('#dirSearch').value.trim(), st = $('#dirState').value;
      GH.api('/admin/directory?limit=500&q=' + encodeURIComponent(q) + '&state=' + encodeURIComponent(st)).then(function (b) {
        var rows = (b.hospitals || []).map(function (h) {
          var login = h.login_state ? '<span class="status ' + (STATE[h.login_state] || STATE.ACTIVE)[1] + '">' + (STATE[h.login_state] || STATE.ACTIVE)[0] + '</span>' : '<span class="sub">none</span>';
          var acts = (h.has_login || h.active === false ? '' : '<button type="button" class="c-btn-link" data-mk="' + h.hospital_id + '">Create login</button>') +
            (h.active === false ? '<button type="button" class="c-btn-link" data-on="' + h.hospital_id + '">Switch on</button>' : '<button type="button" class="c-btn-link danger" data-off="' + h.hospital_id + '">Switch off</button>');
          return '<tr' + (h.active === false ? ' class="is-off"' : '') + '><td><div style="font-weight:500">' + esc(h.name) + (h.active === false ? ' <span class="status status-disabled">Off</span>' : '') + '</div><div class="sub">' + esc([h.district, h.state].filter(Boolean).join(' · ')) + ' · ID ' + h.hospital_id + '</div></td>' +
            '<td>' + esc([h.ownership, h.care_type].filter(Boolean).join(' · ') || '—') + '</td>' +
            '<td>' + locationLabel(h) + '</td><td>' + esc(h.contact || '—') + '</td><td>' + login + '</td>' +
            '<td class="actions">' + acts + '</td></tr>';
        }).join('');
        $('#dirRows').innerHTML = rows || '<tr><td colspan="6" class="table-empty">No hospitals match.</td></tr>';
        $('#dirRows')._data = b.hospitals || [];
      }).catch(function (e) { $('#dirRows').innerHTML = '<tr><td colspan="6" class="table-empty">' + esc(e.message) + '</td></tr>'; });
    }, 250);
  }
  function switchHospital(id, on, btn) {
    var h = ($('#dirRows')._data || []).filter(function (x) { return x.hospital_id === Number(id); })[0];
    var name = h ? h.name : 'this hospital';
    if (!on && !window.confirm('Switch off ' + name + '? No new case will be offered to it. Its login stays as it is.')) return;
    btn.disabled = true;
    GH.api('/admin/directory/' + id + '/' + (on ? 'enable' : 'disable'), { method: 'POST', body: {} })
      .then(function () { GH.toast(name + (on ? ' switched on' : ' switched off')); loadDirectory(); loadCoverage(); })
      .catch(function (e) { GH.toast(e.message); btn.disabled = false; });
  }

  /* ── national list (CSV catalogue) ───────────────────────────────────── */
  var catTimer = null;
  function loadCatalogue() {
    clearTimeout(catTimer);
    catTimer = setTimeout(function () {
      var q = $('#catSearch').value.trim(), st = $('#catState').value;
      if (!q && !st) { $('#catRows').innerHTML = '<tr><td colspan="5" class="table-empty">Search by name, district or pincode, or pick a state.</td></tr>'; return; }
      GH.api('/admin/catalogue?limit=100&q=' + encodeURIComponent(q) + '&state=' + encodeURIComponent(st)).then(function (b) {
        var rows = (b.hospitals || []).map(function (h) {
          return '<tr><td><div style="font-weight:500">' + esc(h.name) + '</div><div class="sub">' + esc([h.district, h.state].filter(Boolean).join(' · ')) + ' · ID ' + h.hospital_id + '</div></td>' +
            '<td>' + esc([h.ownership, h.care_type].filter(Boolean).join(' · ') || '—') + (h.emergency_likely ? '' : '<div class="sub">probably not an emergency unit</div>') + '</td>' +
            '<td>' + locationLabel(h) + '</td><td>' + esc(h.contact || '—') + '</td>' +
            '<td class="actions">' + (h.in_network ? '<span class="status status-active">On GoldenHour</span>' : '<button type="button" class="c-btn-link" data-add="' + h.hospital_id + '">Add to GoldenHour</button>') + '</td></tr>';
        }).join('');
        $('#catRows').innerHTML = rows || '<tr><td colspan="5" class="table-empty">No hospitals match.</td></tr>';
      }).catch(function (e) { $('#catRows').innerHTML = '<tr><td colspan="5" class="table-empty">' + esc(e.message) + '</td></tr>'; });
    }, 250);
  }
  function addHospital(id, btn) {
    btn.disabled = true;
    GH.api('/admin/directory/import', { method: 'POST', body: { ids: [Number(id)] } }).then(function (b) {
      GH.toast(b.added.length ? 'Added to the GoldenHour directory' : 'Already on GoldenHour');
      loadCatalogue(); loadDirectory(); loadCoverage(); statesLoaded = false; loadStates();
    }).catch(function (e) { GH.toast(e.message); btn.disabled = false; });
  }

  /* ── live + audit ────────────────────────────────────────────────────── */
  function loadLive() {
    GH.api('/admin/live').then(function (b) {
      $('#liveRows').innerHTML = (b.cases || []).map(function (c) {
        return '<tr><td><span class="mono">' + esc(c.case_code) + '</span><div class="sub">' + esc(c.chief_complaint || '') + '</div></td><td>' + esc(c.status) + '</td><td>' + esc(c.priority) + '</td><td>' + c.hospitals_notified + '</td><td>' + esc(c.accepted_by || '—') + '</td><td>' + esc(GH.dateTime(c.created_at)) + '</td></tr>';
      }).join('') || '<tr><td colspan="6" class="table-empty">No cases yet.</td></tr>';
    }).catch(function (e) { $('#liveRows').innerHTML = '<tr><td colspan="6" class="table-empty">' + esc(e.message) + '</td></tr>'; });
  }
  function loadAudit() {
    var words = { SIGNED_IN: 'Signed in', SIGN_IN_FAILED: 'Sign-in failed', PASSWORD_CHANGED: 'Password changed', ACCOUNT_CREATED: 'Login created',
      PASSWORD_RESET: 'Password reset', ACCOUNT_DISABLED: 'Login disabled', ACCOUNT_ENABLED: 'Login enabled',
      ACTIVATION_CODES_ISSUED: 'Activation codes issued', ACTIVATION_REISSUED: 'Activation code re-issued', ACCOUNT_ACTIVATED: 'Login activated',
      ACTIVATION_FAILED: 'Activation failed', HOSPITALS_IMPORTED: 'Hospital added', HOSPITAL_ENABLED: 'Hospital switched on', HOSPITAL_DISABLED: 'Hospital switched off' };
    GH.api('/admin/audit?limit=200').then(function (b) {
      $('#auditRows').innerHTML = (b.events || []).map(function (e) {
        var d = e.event_data || {};
        var detail = [d.username, d.hospital_id ? '#' + d.hospital_id : '', d.ids ? '#' + d.ids.join(', #') : '', d.count != null ? d.count + ' created' : '',
          d.method ? '(' + d.method + ')' : '', d.reason ? '(' + d.reason.toLowerCase() + ')' : '', d.by ? 'by ' + d.by : ''].filter(Boolean).join(' ');
        return '<tr><td>' + esc(GH.dateTime(e.performed_at)) + '</td><td>' + esc(words[e.event_type] || e.event_type) + '</td><td>' + esc(detail) + '</td></tr>';
      }).join('') || '<tr><td colspan="3" class="table-empty">Nothing yet.</td></tr>';
    }).catch(function (e) { $('#auditRows').innerHTML = '<tr><td colspan="3" class="table-empty">' + esc(e.message) + '</td></tr>'; });
  }

  function loadCoverage() {
    GH.api('/admin/directory/summary').then(function (b) {
      var s = b.summary || {}, n = function (x) { return Number(x || 0).toLocaleString('en-IN'); };
      $('#coverage').innerHTML =
        '<div class="kv"><span>Hospitals on GoldenHour</span><b>' + n(s.records) + '</b></div>' +
        '<div class="kv"><span>…switched on</span><b>' + n(s.active) + '</b></div>' +
        '<div class="kv"><span>With an active login</span><b>' + n(s.hospitals_with_login) + '</b></div>' +
        '<div class="kv"><span>Waiting for activation</span><b>' + n(s.logins_pending) + '</b></div>' +
        '<div class="kv"><span>Location as listed</span><b>' + n(s.location_listed) + '</b></div>' +
        '<div class="kv"><span>Location approximate (pincode / district)</span><b>' + n((s.location_pincode || 0) + (s.location_district || 0)) + '</b></div>' +
        '<div class="kv"><span>States and UTs</span><b>' + n(s.states) + '</b></div>' +
        '<div class="kv"><span>National list to add from</span><b>' + n(s.catalogue_records) + '</b></div>';
    }).catch(function () {});
  }

  function options(list) {
    return '<option value="">All states</option>' + list.map(function (s) { return '<option value="' + esc(s.name) + '">' + esc(s.name) + '</option>'; }).join('');
  }
  function loadStates() {
    if (statesLoaded) return;
    statesLoaded = true;
    GH.api('/admin/directory/states').then(function (b) {
      var keepA = $('#accState').value, keepD = $('#dirState').value;
      $('#accState').innerHTML = options(b.states || []); $('#dirState').innerHTML = options(b.states || []);
      $('#accState').value = keepA; $('#dirState').value = keepD;
    }).catch(function () { statesLoaded = false; });
    GH.api('/admin/catalogue/states').then(function (b) { if ($('#catState').options.length < 2) $('#catState').innerHTML = options(b.states || []); }).catch(function () {});
  }

  function showTab(tab) {
    $$('.adminnav button').forEach(function (b) { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $$('[data-pane]').forEach(function (p) { p.hidden = p.dataset.pane !== tab; });
    if (tab === 'accounts') loadAccounts();
    if (tab === 'directory') { loadDirectory(); loadCatalogue(); }
    if (tab === 'live') loadLive();
    if (tab === 'audit') loadAudit();
  }

  function bindOnce() {
    if (bound) return; bound = true;
    $$('.adminnav button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
    var accTimer = null;
    $('#accSearch').addEventListener('input', function () { clearTimeout(accTimer); accTimer = setTimeout(loadAccounts, 250); });
    $('#accState').addEventListener('change', loadAccounts);
    $('#accStatus').addEventListener('change', loadAccounts);
    $('#accRows').addEventListener('click', function (e) { var b = e.target.closest('[data-do]'); if (b) accountAction(b.dataset.acc, b.dataset.do, b); });
    $('#bulkBtn').addEventListener('click', bulkCreate);
    $$('input[name="createMode"]').forEach(function (r) { r.addEventListener('change', syncMode); });
    $('#createHospital').addEventListener('input', searchPicker);
    $('#createHospital').addEventListener('keydown', function (e) { if (e.key === 'ArrowDown') { var f = $('#createPicker button'); if (f) { e.preventDefault(); f.focus(); } } });
    $('#createPicker').addEventListener('click', function (e) { var b = e.target.closest('[data-hid]'); if (b) pick(b.dataset.hid); });
    $('#createPicker').addEventListener('keydown', function (e) {
      var items = $$('#createPicker button[data-hid]'), i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' && i < items.length - 1) { e.preventDefault(); items[i + 1].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (i > 0 ? items[i - 1] : $('#createHospital')).focus(); }
      if (e.key === 'Escape') { $('#createPicker').hidden = true; $('#createHospital').focus(); }
    });
    $('#createForm').addEventListener('submit', create);
    $('#copySecret').addEventListener('click', function () {
      var t = $('#createSecret').textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { GH.toast('Copied'); }, function () { GH.toast('Copy failed — select it by hand'); });
    });
    $('#dirSearch').addEventListener('input', loadDirectory);
    $('#dirState').addEventListener('change', loadDirectory);
    $('#dirRows').addEventListener('click', function (e) {
      var on = e.target.closest('[data-on]'), off = e.target.closest('[data-off]');
      if (on) return switchHospital(on.dataset.on, true, on);
      if (off) return switchHospital(off.dataset.off, false, off);
      var b = e.target.closest('[data-mk]'); if (!b) return;
      var h = ($('#dirRows')._data || []).filter(function (x) { return x.hospital_id === Number(b.dataset.mk); })[0];
      if (!h) return;
      $('#createPicker')._data = [h]; pick(h.hospital_id);
    });
    $('#catSearch').addEventListener('input', loadCatalogue);
    $('#catState').addEventListener('change', loadCatalogue);
    $('#catRows').addEventListener('click', function (e) { var b = e.target.closest('[data-add]'); if (b) addHospital(b.dataset.add, b); });
    $('#liveRefresh').addEventListener('click', loadLive);
    $('#auditRefresh').addEventListener('click', loadAudit);
    $('#adminSignOut').addEventListener('click', function () { window.GHSignOut(); });
    document.addEventListener('click', function (e) { if (!e.target.closest('.picker')) $('#createPicker').hidden = true; });
  }

  function start(account) {
    stop();
    me = account;
    bindOnce();
    syncMode();
    $('#adminName').textContent = account.username;
    loadStates(); loadCoverage(); showTab('accounts');
    timers.push(setInterval(function () { if (!$('[data-pane="live"]').hidden) loadLive(); }, 15000));
  }
  function stop() { timers.forEach(clearInterval); timers = []; me = null; }

  window.GHAdmin = { start: start, stop: stop };
})();
