/* ============================================================================
   The v6 ER desk in jsdom: sign-in routing, the signed-in board, arrival,
   delay alerts and escaping. No server — fetch and socket.io are faked.
   ========================================================================== */
const assert = require('assert'), fs = require('fs'), path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.join(__dirname, '../../backend/public/hospital');
const delay = (ms) => new Promise(r => setTimeout(r, ms || 15));
const SCRIPTS = ['config.js', 'common.js', 'board.js', 'admin.js', 'main.js'];
let passed = 0;
function ok(name) { passed++; console.log('  ok   ' + name); }

function boot(opts) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://desk.test/hospital/?hospital=99', runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const w = dom.window;
  const calls = [];
  const intervals = [];
  w.confirm = () => true;
  w.print = () => {};
  w.setInterval = fn => { intervals.push(fn); return intervals.length; };
  w.clearInterval = () => {};
  if (opts.session) w.localStorage.setItem('goldenhour.session', JSON.stringify(opts.session));
  w.io = () => {
    const h = {};
    const sock = { connected: true, on: (ev, fn) => { h[ev] = fn; }, emit() {}, disconnect() { sock.connected = false; }, _h: h };
    w.__sock = sock;
    return sock;
  };
  w.fetch = async (url, init) => {
    const u = String(url).replace('https://desk.test/api/v1', '');
    calls.push({ url: u, method: (init && init.method) || 'GET', auth: init && init.headers && init.headers.Authorization, body: init && init.body });
    const r = opts.route(u, init || {}, calls);
    const status = r.status || 200;
    return { ok: status < 400, status, json: async () => r.body || {} };
  };
  SCRIPTS.forEach(f => w.eval(fs.readFileSync(path.join(root, f), 'utf8')));
  return { dom, w, calls, intervals, $: s => w.document.querySelector(s) };
}

const HOSP = { hospital_id: 12179, name: 'Test ER', district: 'Bengaluru Urban', state: 'Karnataka', lat: 12.93, lng: 77.62 };
const STAFF = { account: { account_id: 2, username: 'er.test', role: 'HOSPITAL_STAFF', must_change_password: false }, hospital: HOSP };
const card = () => ({ case_code: 'GH-TEST', status: 'ACCEPTED', priority: 'RED', chief_complaint: 'Chest pain',
  patient: { age: 52, gender: 'M', vitals: { systolic_bp: 82, diastolic_bp: 50, heart_rate: 130, spo2: 88 } },
  notes: '<img src=x onerror="window.__pwned=1">', eta_minutes: 8, accepted_hospital_id: 12179,
  accepted_at: new Date().toISOString(), distance_km: 2, track: [], patient_history: [] });

(async () => {
  /* ── 1. No session → sign-in form, nothing else ─────────────────────── */
  {
    const t = boot({ route: () => ({ status: 404 }) });
    await delay();
    assert.strictEqual(t.$('#viewLogin').hidden, false);
    assert.strictEqual(t.$('#viewBoard').hidden, true);
    assert.strictEqual(t.$('#viewAdmin').hidden, true);
    assert.strictEqual(t.calls.length, 0, 'nothing is fetched before sign-in');
    ok('without a session only the sign-in form shows, and nothing is fetched');
    t.dom.window.close();
  }

  /* ── 2. Sign in → the board of the login's own hospital ────────────── */
  {
    const t = boot({ route: (u, init) => {
      if (u === '/auth/login') {
        const b = JSON.parse(init.body);
        return b.password === 'right password here' ? { body: Object.assign({ token: 'T1' }, STAFF) } : { status: 401, body: { message: 'Username or password is incorrect. 4 tries left.' } };
      }
      if (u.startsWith('/desk/queue')) return { body: { pending: [], active: [] } };
      return { body: {} };
    } });
    await delay();
    t.$('#loginUser').value = 'er.test'; t.$('#loginPass').value = 'wrong';
    t.$('#loginForm').dispatchEvent(new t.w.Event('submit', { cancelable: true }));
    await delay();
    assert.ok(t.$('#loginError').textContent.includes('incorrect'));
    assert.strictEqual(t.$('#viewBoard').hidden, true);
    ok('a wrong password shows the server message and opens nothing');
    t.$('#loginPass').value = 'right password here';
    t.$('#loginForm').dispatchEvent(new t.w.Event('submit', { cancelable: true }));
    await delay(40);
    assert.strictEqual(t.$('#viewBoard').hidden, false);
    assert.strictEqual(t.w.document.body.className, 'look-glass');
    assert.strictEqual(t.$('#hospName').textContent, 'Test ER');
    const desk = t.calls.filter(c => c.url.startsWith('/desk/'));
    assert.ok(desk.length && desk.every(c => c.auth === 'Bearer T1'), 'every desk call carries the token');
    assert.ok(desk.every(c => !c.url.includes('hospital=')), '?hospital= from the address bar is never sent');
    ok('signing in opens the glass board for the hospital the server named, with the token on every call');
    t.dom.window.close();
  }

  /* ── 3. Board: arrival, delay alert, escaping ──────────────────────── */
  {
    let mode = '404', arrivals = 0;
    const t = boot({ session: { token: 'T2', username: 'er.test' }, route: (u) => {
      if (u === '/auth/me') return { body: STAFF };
      if (u.startsWith('/desk/queue')) return { body: { pending: [], active: [card()] } };
      if (u.startsWith('/desk/arrived/')) {
        arrivals++;
        if (mode === 'success') return { body: { success: true, status: 'ARRIVED', arrived_at: new Date().toISOString() } };
        return { status: 404, body: { success: false, message: 'No such case' } };
      }
      return { body: {} };
    } });
    await delay(40);
    const btn = () => t.$('[data-act="arrived"]');
    assert.ok(btn(), 'the en-route card has a Mark arrived button');
    assert.strictEqual(t.$('#cntActive').textContent, '1');
    assert.strictEqual(t.w.__pwned, undefined);
    assert.strictEqual(t.$('.note-block img'), null, 'crew notes are text, never markup');
    ok('an en-route case renders with its crew note escaped');
    assert.ok(t.$('.vital.is-critical'), 'a systolic of 82 is shown as critical');
    ok('critical vitals are marked');

    t.w.__sock._h['case:delay']({ case_code: 'GH-TEST', reason: 'road_blocked', extra_minutes: 10, at: new Date().toISOString() });
    await delay();
    assert.ok(t.$('.alert-delay') && t.$('.alert-delay').textContent.includes('road blocked'));
    ok('a crew delay report appears on the card');

    btn().click(); btn() && btn().click();
    await delay();
    assert.strictEqual(arrivals, 1, 'a double click sends one request');
    assert.ok(btn(), 'a refused arrival leaves the case open');
    mode = 'success';
    btn().click();
    await delay();
    assert.ok(t.$('.arrived-ribbon'), 'arrival shows the confirmation');
    assert.strictEqual(t.$('#cntActive').textContent, '0');
    for (const fn of t.intervals) await fn();
    await delay();
    assert.ok(t.$('.arrived-ribbon'), 'a late queue response must not resurrect an arrived case');
    ok('arrival: one request per click, refusal keeps the case, success closes it, late polls do not undo it');
    t.dom.window.close();
  }

  /* ── 4. Expired session → back to sign-in ──────────────────────────── */
  {
    const t = boot({ session: { token: 'OLD', username: 'er.test' }, route: () => ({ status: 401, body: { message: 'Your session has ended. Sign in again.' } }) });
    await delay(30);
    assert.strictEqual(t.$('#viewLogin').hidden, false);
    assert.strictEqual(t.w.localStorage.getItem('goldenhour.session'), null);
    ok('an expired or revoked session returns to sign-in and is forgotten');
    t.dom.window.close();
  }

  /* ── 5. Admin login → console; first-login → password screen ───────── */
  {
    const t = boot({ session: { token: 'A', username: 'admin' }, route: (u) => {
      if (u === '/auth/me') return { body: { account: { account_id: 1, username: 'admin', role: 'SUPER_ADMIN', must_change_password: false }, hospital: null } };
      if (u.startsWith('/admin/accounts')) return { body: { accounts: [] } };
      return { body: {} };
    } });
    await delay(30);
    assert.strictEqual(t.$('#viewAdmin').hidden, false);
    assert.strictEqual(t.$('#viewBoard').hidden, true);
    ok('an administrator login opens the console, not a board');
    t.dom.window.close();
  }
  {
    const t = boot({ session: { token: 'F', username: 'er.new' }, route: (u) => {
      if (u === '/auth/me') return { body: { account: { account_id: 3, username: 'er.new', role: 'HOSPITAL_STAFF', must_change_password: true }, hospital: HOSP } };
      return { body: {} };
    } });
    await delay(30);
    assert.strictEqual(t.$('#viewPassword').hidden, false);
    assert.strictEqual(t.$('#viewBoard').hidden, true);
    ok('a temporary password leads to the change-password screen first');
    t.dom.window.close();
  }

  console.log('\nPASS — ' + passed + ' passed, 0 failed');
})().catch(e => { console.error(e); process.exitCode = 1; });
