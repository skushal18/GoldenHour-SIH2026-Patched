/* ============================================================================
   GoldenHour desk — sign-in, password change and routing.

   Nothing but the sign-in form shows until the server has confirmed who this
   is. The screen that opens is decided by the account the server returns:
   a hospital login opens that hospital's ER board, an administrator login
   opens the console. The URL cannot choose a hospital.
   ========================================================================== */
(function () {
  'use strict';
  var GH = window.GH, $ = GH.$;
  var VIEWS = ['viewLogin', 'viewPassword', 'viewBoard', 'viewAdmin'];

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
      showLogin('Cannot reach the GoldenHour server — retrying…');
      setTimeout(function () { if (GH.session() && !$('#viewLogin').hidden) resume(attempt + 1); }, Math.min(30000, 3000 * (attempt + 1)));
    });
  }
  if (!GH.session()) return showLogin();
  resume(0);
})();
