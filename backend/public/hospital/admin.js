/* ============================================================================
   GoldenHour desk — super-admin console (window.GHAdmin).
   Create a login per hospital from the national directory, reset passwords,
   disable/enable logins, browse the directory, watch live cases, read the
   audit log.
   ========================================================================== */
(function () {
  'use strict';
  var GH = window.GH, $ = GH.$, $$ = GH.$$, esc = GH.esc;
  var me = null, picked = null, timers = [], bound = false, states = [];

  function statusOf(a) {
    if (a.locked_until && new Date(a.locked_until).getTime() > Date.now()) return ['Locked', 'status-locked'];
    if (a.status === 'DISABLED') return ['Disabled', 'status-disabled'];
    if (a.must_change_password) return ['Must change password', 'status-change'];
    return ['Active', 'status-active'];
  }

  /* ── accounts ────────────────────────────────────────────────────────── */
  function loadAccounts() {
    var q = $('#accSearch').value.trim(), st = $('#accState').value;
    GH.api('/admin/accounts?q=' + encodeURIComponent(q) + '&state=' + encodeURIComponent(st)).then(function (b) {
      var rows = (b.accounts || []).map(function (a) {
        var s = statusOf(a), h = a.hospital;
        var who = a.role === 'SUPER_ADMIN' ? '<div style="font-weight:500">GoldenHour administrator</div><div class="sub">Console access only</div>'
          : '<div style="font-weight:500">' + esc(h ? h.name : 'Hospital #' + a.hospital_id) + '</div><div class="sub">' + esc(h ? [h.district, h.state, h.ownership].filter(Boolean).join(' · ') : '') + '</div>';
        var self = me && a.account_id === me.account_id;
        var acts = self ? '<span class="sub">you</span>' :
          '<button type="button" class="c-btn-link" data-acc="' + a.account_id + '" data-do="reset">Reset password</button>' +
          (a.status === 'DISABLED'
            ? '<button type="button" class="c-btn-link" data-acc="' + a.account_id + '" data-do="enable">Enable</button>'
            : '<button type="button" class="c-btn-link danger" data-acc="' + a.account_id + '" data-do="disable">Disable</button>');
        return '<tr><td>' + who + '</td><td class="mono">' + esc(a.username) + '</td><td><span class="status ' + s[1] + '">' + s[0] + '</span></td><td>' + esc(GH.dateTime(a.last_login_at)) + '</td><td class="actions">' + acts + '</td></tr>';
      }).join('');
      $('#accRows').innerHTML = rows || '<tr><td colspan="5" class="table-empty">No logins match. Create one with the form on the right.</td></tr>';
    }).catch(function (e) { $('#accRows').innerHTML = '<tr><td colspan="5" class="table-empty">' + esc(e.message) + '</td></tr>'; });
  }

  function accountAction(id, what, btn) {
    var row = btn.closest('tr'), name = $('td.mono', row).textContent;
    var ask = { reset: 'Reset the password for ' + name + '? Their current sessions end and they get a new temporary password.',
      disable: 'Disable ' + name + '? Their ER desk is signed out at once.', enable: 'Enable ' + name + ' again?' }[what];
    if (!window.confirm(ask)) return;
    btn.disabled = true;
    GH.api('/admin/accounts/' + id + '/' + (what === 'reset' ? 'reset-password' : what), { method: 'POST', body: {} }).then(function (b) {
      if (what === 'reset') {
        GH.openSheet('New temporary password',
          '<p>Give this to <b>' + esc(b.account.username) + '</b> privately. It is shown only now; they must change it at first sign-in.</p>' +
          '<div class="secret"><code>' + esc(b.temporary_password) + '</code></div>');
      } else GH.toast(what === 'disable' ? name + ' disabled' : name + ' enabled');
      loadAccounts(); loadCoverage();
    }).catch(function (e) { GH.toast(e.message); btn.disabled = false; });
  }

  /* ── create ──────────────────────────────────────────────────────────── */
  var pickTimer = null;
  function searchPicker() {
    var q = $('#createHospital').value.trim(), list = $('#createPicker');
    picked = null;
    if (q.length < 2) { list.hidden = true; return; }
    clearTimeout(pickTimer);
    pickTimer = setTimeout(function () {
      GH.api('/admin/directory?limit=12&q=' + encodeURIComponent(q)).then(function (b) {
        var hs = b.hospitals || [];
        list.innerHTML = hs.length ? hs.map(function (h) {
          return '<button type="button" role="option" data-hid="' + h.hospital_id + '">' +
            (h.has_login ? '<span class="tag">has a login</span>' : '') + esc(h.name) +
            '<span class="sub">' + esc([h.district, h.state, h.pincode].filter(Boolean).join(' · ')) + ' · ' + (h.coord_source === 'listed' ? 'location listed' : h.coord_source === 'pincode' ? 'location approx. (pincode)' : 'no location') + '</span></button>';
        }).join('') : '<button type="button" disabled>No hospital matches “' + esc(q) + '”</button>';
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
    $('#createUser').focus();
  }
  function create(e) {
    e.preventDefault();
    var err = $('#createError'), btn = $('#createBtn');
    err.hidden = true; $('#createResult').hidden = true;
    if (!picked) { err.textContent = 'Pick a hospital from the directory list first.'; err.hidden = false; $('#createHospital').focus(); return; }
    btn.disabled = true; btn.textContent = 'Creating…';
    GH.api('/admin/accounts', { method: 'POST', body: { hospital_id: picked.hospital_id, username: $('#createUser').value.trim() } }).then(function (b) {
      $('#createResultText').textContent = 'Login created for ' + b.hospital.name + ': ' + b.account.username;
      $('#createSecret').textContent = b.temporary_password;
      $('#createResult').hidden = false;
      $('#createHospital').value = ''; $('#createUser').value = ''; picked = null;
      $('#createHospitalHint').textContent = 'Pick a hospital from the list.';
      loadAccounts(); loadCoverage();
    }).catch(function (e2) { err.textContent = e2.message; err.hidden = false; })
      .then(function () { btn.disabled = false; btn.textContent = 'Create login'; });
  }

  /* ── directory ───────────────────────────────────────────────────────── */
  var dirTimer = null;
  function loadDirectory() {
    clearTimeout(dirTimer);
    dirTimer = setTimeout(function () {
      var q = $('#dirSearch').value.trim(), st = $('#dirState').value;
      if (!q && !st) { $('#dirRows').innerHTML = '<tr><td colspan="5" class="table-empty">Search by name, district or pincode, or pick a state.</td></tr>'; return; }
      GH.api('/admin/directory?limit=100&q=' + encodeURIComponent(q) + '&state=' + encodeURIComponent(st)).then(function (b) {
        var rows = (b.hospitals || []).map(function (h) {
          var loc = h.coord_source === 'listed' ? 'Listed' : h.coord_source === 'pincode' ? '≈ Pincode ' + esc(h.pincode || '') : 'Unknown';
          return '<tr><td><div style="font-weight:500">' + esc(h.name) + '</div><div class="sub">' + esc([h.district, h.state].filter(Boolean).join(' · ')) + '</div></td>' +
            '<td>' + esc([h.ownership, h.care_type].filter(Boolean).join(' · ') || '—') + (h.emergency_likely ? '' : '<div class="sub">probably not an emergency unit</div>') + '</td>' +
            '<td>' + loc + '</td><td>' + esc(h.contact || '—') + '</td>' +
            '<td class="actions">' + (h.has_login ? '<span class="status status-active">Has a login</span>' : '<button type="button" class="c-btn-link" data-mk="' + h.hospital_id + '">Create login</button>') + '</td></tr>';
        }).join('');
        $('#dirRows').innerHTML = rows || '<tr><td colspan="5" class="table-empty">No hospitals match.</td></tr>';
        $('#dirRows')._data = b.hospitals || [];
      }).catch(function (e) { $('#dirRows').innerHTML = '<tr><td colspan="5" class="table-empty">' + esc(e.message) + '</td></tr>'; });
    }, 250);
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
    var words = { SIGNED_IN: 'Signed in', SIGN_IN_FAILED: 'Sign-in failed', PASSWORD_CHANGED: 'Password changed', ACCOUNT_CREATED: 'Login created', PASSWORD_RESET: 'Password reset', ACCOUNT_DISABLED: 'Login disabled', ACCOUNT_ENABLED: 'Login enabled' };
    GH.api('/admin/audit?limit=200').then(function (b) {
      $('#auditRows').innerHTML = (b.events || []).map(function (e) {
        var d = e.event_data || {};
        var detail = [d.username, d.reason ? '(' + d.reason.toLowerCase() + ')' : '', d.by ? 'by ' + d.by : ''].filter(Boolean).join(' ');
        return '<tr><td>' + esc(GH.dateTime(e.performed_at)) + '</td><td>' + esc(words[e.event_type] || e.event_type) + '</td><td>' + esc(detail) + '</td></tr>';
      }).join('') || '<tr><td colspan="3" class="table-empty">Nothing yet.</td></tr>';
    }).catch(function (e) { $('#auditRows').innerHTML = '<tr><td colspan="3" class="table-empty">' + esc(e.message) + '</td></tr>'; });
  }

  function loadCoverage() {
    GH.api('/admin/directory/summary').then(function (b) {
      var s = b.summary || {}, n = function (x) { return Number(x || 0).toLocaleString('en-IN'); };
      $('#coverage').innerHTML =
        '<div class="kv"><span>Hospitals in directory</span><b>' + n(s.records) + '</b></div>' +
        '<div class="kv"><span>Location as listed</span><b>' + n(s.location_listed) + '</b></div>' +
        '<div class="kv"><span>Location from pincode (approx.)</span><b>' + n(s.location_pincode) + '</b></div>' +
        '<div class="kv"><span>Likely emergency-capable</span><b>' + n(s.emergency_likely) + '</b></div>' +
        '<div class="kv"><span>States and UTs</span><b>' + n(s.states) + '</b></div>' +
        '<div class="kv"><span>With an active GoldenHour login</span><b>' + n(s.hospitals_with_login) + '</b></div>';
    }).catch(function () {});
  }

  function loadStates() {
    if (states.length) return;
    GH.api('/admin/directory/states').then(function (b) {
      states = b.states || [];
      var opts = '<option value="">All states</option>' + states.map(function (s) { return '<option value="' + esc(s.name) + '">' + esc(s.name) + '</option>'; }).join('');
      $('#accState').innerHTML = opts; $('#dirState').innerHTML = opts;
    }).catch(function () {});
  }

  function showTab(tab) {
    $$('.adminnav button').forEach(function (b) { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $$('[data-pane]').forEach(function (p) { p.hidden = p.dataset.pane !== tab; });
    if (tab === 'accounts') loadAccounts();
    if (tab === 'directory') loadDirectory();
    if (tab === 'live') loadLive();
    if (tab === 'audit') loadAudit();
  }

  function bindOnce() {
    if (bound) return; bound = true;
    $$('.adminnav button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
    var accTimer = null;
    $('#accSearch').addEventListener('input', function () { clearTimeout(accTimer); accTimer = setTimeout(loadAccounts, 250); });
    $('#accState').addEventListener('change', loadAccounts);
    $('#accRows').addEventListener('click', function (e) { var b = e.target.closest('[data-do]'); if (b) accountAction(b.dataset.acc, b.dataset.do, b); });
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
      var b = e.target.closest('[data-mk]'); if (!b) return;
      var h = ($('#dirRows')._data || []).filter(function (x) { return x.hospital_id === Number(b.dataset.mk); })[0];
      if (!h) return;
      $('#createPicker')._data = [h]; pick(h.hospital_id);
    });
    $('#liveRefresh').addEventListener('click', loadLive);
    $('#auditRefresh').addEventListener('click', loadAudit);
    $('#adminSignOut').addEventListener('click', function () { window.GHSignOut(); });
    document.addEventListener('click', function (e) { if (!e.target.closest('.picker')) $('#createPicker').hidden = true; });
  }

  function start(account) {
    stop();
    me = account;
    bindOnce();
    $('#adminName').textContent = account.username;
    loadStates(); loadCoverage(); showTab('accounts');
    timers.push(setInterval(function () { if (!$('[data-pane="live"]').hidden) loadLive(); }, 15000));
  }
  function stop() { timers.forEach(clearInterval); timers = []; me = null; }

  window.GHAdmin = { start: start, stop: stop };
})();
