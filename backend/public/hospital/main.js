/* ============================================================================
   GoldenHour desk — sign-in, password change and routing.

   Nothing but the sign-in form shows until the server has confirmed who this
   is. The screen that opens is decided by the account the server returns:
   a hospital login opens that hospital's ER board, an administrator login
   opens the console. The URL cannot choose a hospital.

   A hospital whose login waits for activation opens #activate: it enters its
   one-time code, sees which hospital the code is for, then chooses its own
   username and password and lands on its own desk.
   ========================================================================== */
(function () {
  'use strict';
  var GH = window.GH, $ = GH.$;
  var VIEWS = ['viewLogin', 'viewActivate', 'viewPassword', 'viewBoard', 'viewAdmin'];

  function show(id) {
    VIEWS.forEach(function (v) { $('#' + v).hidden = v !== id; });
    document.body.className = (id === 'viewBoard') ? 'look-glass' : 'look-clinical';
  }

  function route(me) {
    var account = me.account, hospital = me.hospital;
    if (account.must_change_password) return showPassword(account, hospital);
    if (account.role === 'SUPER_ADMIN') {
      document.title = 'GoldenHour · Administration';
      if (location.pathname.indexOf('/admin') !== 0 && history.replaceState) history.replaceState(null, '', '/admin/');
      show('viewAdmin');
      window.GHAdmin.start(account);
      return;
    }
    document.title = 'GoldenHour · ' + (hospital ? hospital.name : 'ER desk');
    if (location.pathname.indexOf('/hospital') !== 0 && history.replaceState) history.replaceState(null, '', '/hospital/');
    show('viewBoard');
    window.GHBoard.start(account, hospital);
  }

  function showLogin(message) {
    if (window.GHBoard) window.GHBoard.stop();
    if (window.GHAdmin) window.GHAdmin.stop();
    document.title = 'GoldenHour · Sign in';
    show('viewLogin');
    var err = $('#loginError');
    if (message) { err.textContent = message; err.hidden = false; } else err.hidden = true;
    $('#loginPass').value = '';
    setTimeout(function () { ($('#loginUser').value ? $('#loginPass') : $('#loginUser')).focus(); }, 30);
  }

  function showPassword(account, hospital) {
    show('viewPassword');
    $('#pwWho').textContent = 'Signed in as ' + account.username + (hospital ? ' · ' + hospital.name : '');
    $('#pwHospital').textContent = hospital ? hospital.name + ', ' + (hospital.district || '') + ', ' + (hospital.state || '') : 'GoldenHour administration';
    ['pwCurrent', 'pwNew', 'pwAgain'].forEach(function (id) { $('#' + id).value = ''; });
    $('#pwError').hidden = true;
    setTimeout(function () { $('#pwCurrent').focus(); }, 30);
  }

  /* ── sign in ─────────────────────────────────────────────────────────── */
  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var user = $('#loginUser').value.trim(), pass = $('#loginPass').value;
    var err = $('#loginError'), btn = $('#loginBtn');
    if (!user || !pass) { err.textContent = 'Enter your username and password.'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Signing in…'; err.hidden = true;
    GH.api('/auth/login', { method: 'POST', body: { username: user, password: pass }, anonymous: true })
      .then(function (body) {
        GH.saveSession({ token: body.token, username: body.account.username });
        route(body);
      })
      .catch(function (e2) { err.textContent = e2.message; err.hidden = false; $('#loginPass').select(); })
      .then(function () { btn.disabled = false; btn.textContent = 'Sign in'; });
  });

  /* ── activate (first time, with a one-time code) ─────────────────────── */
  var actCode = null;
  function showActivate() {
    if (window.GHBoard) window.GHBoard.stop();
    if (window.GHAdmin) window.GHAdmin.stop();
    document.title = 'GoldenHour · Activate your login';
    show('viewActivate');
    actCode = null;
    $('#actCodeForm').hidden = false; $('#actForm').hidden = true;
    $('#actCodeError').hidden = true; $('#actCode').value = '';
    $('#actHospitalSide').textContent = 'The code works once and expires after 7 days.';
    setTimeout(function () { $('#actCode').focus(); }, 30);
  }
  $('#toActivate').addEventListener('click', function (e) { e.preventDefault(); if (history.replaceState) history.replaceState(null, '', '#activate'); showActivate(); });
  GH.$$('[data-to-login]').forEach(function (b) {
    b.addEventListener('click', function () { if (history.replaceState) history.replaceState(null, '', location.pathname); showLogin(); });
  });
  $('#actCodeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('#actCode').value.trim(), err = $('#actCodeError'), btn = $('#actCodeBtn');
    if (code.replace(/[^0-9a-z]/gi, '').length !== 16) { err.textContent = 'The code is 16 letters and digits.'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Checking…'; err.hidden = true;
    GH.api('/auth/activate/lookup', { method: 'POST', body: { code: code }, anonymous: true }).then(function (b) {
      actCode = code;
      var h = b.hospital || {};
      $('#actFor').textContent = 'For ' + (h.name || 'your hospital') + (h.district ? ', ' + h.district : '') + (h.state ? ', ' + h.state : '') +
        '. The code expires ' + GH.dateTime(b.expires_at) + '.';
      $('#actHospitalSide').textContent = h.name || '';
      $('#actCodeForm').hidden = true; $('#actForm').hidden = false;
      ['actUser', 'actPass', 'actAgain'].forEach(function (id) { $('#' + id).value = ''; });
      $('#actError').hidden = true;
      setTimeout(function () { $('#actUser').focus(); }, 30);
    }).catch(function (e2) { err.textContent = e2.message; err.hidden = false; })
      .then(function () { btn.disabled = false; btn.textContent = 'Continue'; });
  });
  $('#actBack').addEventListener('click', showActivate);
  $('#actForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var user = $('#actUser').value.trim(), pass = $('#actPass').value, again = $('#actAgain').value;
    var err = $('#actError'), btn = $('#actBtn');
    var say = function (m) { err.textContent = m; err.hidden = false; };
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(user)) return say('Usernames are 3–64 characters: letters, digits, dot, dash or underscore.');
    if (pass.length < 10) return say('Use at least 10 characters for the password.');
    if (pass !== again) return say('The two passwords do not match.');
    btn.disabled = true; btn.textContent = 'Activating…'; err.hidden = true;
    GH.api('/auth/activate', { method: 'POST', body: { code: actCode, username: user, password: pass }, anonymous: true }).then(function (body) {
      if (history.replaceState) history.replaceState(null, '', '/hospital/');
      GH.saveSession({ token: body.token, username: body.account.username });
      GH.toast('Activated. Sign in as ' + body.account.username + ' from now on.', 6000);
      route(body);
    }).catch(function (e2) {
      say(e2.message);
      if (e2.reason === 'INVALID_CODE' || e2.reason === 'CODE_EXPIRED') { $('#actForm').hidden = true; $('#actCodeForm').hidden = false; $('#actCodeError').textContent = e2.message; $('#actCodeError').hidden = false; }
    }).then(function () { btn.disabled = false; btn.textContent = 'Activate and open the ER desk'; });
  });

  /* ── change password ─────────────────────────────────────────────────── */
  $('#pwForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var cur = $('#pwCurrent').value, next = $('#pwNew').value, again = $('#pwAgain').value;
    var err = $('#pwError'), btn = $('#pwBtn');
    if (next !== again) { err.textContent = 'The two new passwords do not match.'; err.hidden = false; return; }
    if (next.length < 10) { err.textContent = 'Use at least 10 characters.'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Saving…'; err.hidden = true;
    GH.api('/auth/change-password', { method: 'POST', body: { current_password: cur, new_password: next } })
      .then(function (body) {
        GH.saveSession({ token: body.token, username: body.account.username });
        GH.toast('Password changed');
        route(body);
      })
      .catch(function (e2) { err.textContent = e2.message; err.hidden = false; })
      .then(function () { btn.disabled = false; btn.textContent = 'Save and continue'; });
  });

  function signOut() {
    var had = GH.session();
    var done = function () { GH.saveSession(null); showLogin(); };
    if (!had) return done();
    GH.api('/auth/logout', { method: 'POST', body: {} }).then(done, done);
  }
  $('#pwSignOut').addEventListener('click', signOut);
  window.GHSignOut = signOut;

  GH.onSignedOut(function (message) { showLogin(message || 'Your session has ended. Sign in again.'); });

  /* ── start ───────────────────────────────────────────────────────────── */
  /* An ER wall screen that reloads while the server is restarting should come
     back by itself, not sit on the sign-in form: keep the session and retry. */
  function resume(attempt) {
    GH.api('/auth/me').then(route).catch(function (e) {
      if (!e.network) { GH.saveSession(null); return showLogin(); }
      showLogin(e.status ? e.message : 'Cannot reach the GoldenHour server — retrying…');
      setTimeout(function () { if (GH.session() && !$('#viewLogin').hidden) resume(attempt + 1); }, Math.min(30000, 3000 * (attempt + 1)));
    });
  }
  if (/^#activate/.test(location.hash) || /[?&]activate\b/.test(location.search)) return showActivate();
  if (!GH.session()) return showLogin();
  resume(0);
})();
