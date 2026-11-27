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
  if (opts.before) opts.before(w);
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


  /* ── 6. Live map: desk location, tiles, the live statement ─────────── */
  {
    const tiles = [];
    const chain = o => Object.assign(o, { addTo() { return o; }, bindTooltip() { return o; }, setLatLng() { return o; }, setIcon() { return o; }, setLatLngs() { return o; }, setRadius() { return o; } });
    const fakeL = {
      map: () => chain({ on() {}, setView() {}, invalidateSize() {}, fitBounds() {}, removeLayer() {}, remove() {},
        getBounds: () => ({ pad: () => ({ contains: () => true }) }) }),
      tileLayer: (url, o) => { tiles.push({ url, o }); return chain({}); },
      polyline: () => chain({}), marker: () => chain({}), circle: () => chain({}), divIcon: o => o,
      latLngBounds: () => ({ pad: () => ({}) }), layerGroup: () => chain({ clearLayers() {} }),
    };
    const puts = [];
    const fresh = () => new Date(Date.now() - 4000).toISOString();
    const enRoute = Object.assign(card(), { notes: '', origin: { lat: 12.9166, lng: 77.605, source: 'gps', accuracy_m: 15 },
      last_position: { lat: 12.9172, lng: 77.607, at: fresh(), accuracy_m: 10, approximate: false },
      track: [{ lat: 12.9172, lng: 77.607, at: fresh() }], remaining_distance_km: 2.1, est_eta_minutes: 7, moving_kmh: 34, eta_source: 'crew',
      tracking_hospital: { lat: 12.93035, lng: 77.61905, source: 'desk', accuracy_m: 35 } });
    const t = boot({ session: { token: 'T6', username: 'er.test' },
      before: w => {
        w.L = fakeL;
        Object.defineProperty(w.navigator, 'geolocation', { configurable: true, value: {
          watchPosition: (ok) => { setTimeout(() => ok({ coords: { latitude: 12.93035, longitude: 77.61905, accuracy: 35 } }), 5); return 7; },
          clearWatch() {} } });
      },
      route: (u, init) => {
        if (u === '/auth/me') return { body: STAFF };
        if (u.startsWith('/desk/queue')) return { body: { pending: [], active: [enRoute] } };
        if (u === '/desk/location') { puts.push(JSON.parse(init.body)); return { body: { success: true, location: { lat: 12.93035, lng: 77.61905, source: 'desk', accuracy_m: 35 } } }; }
        return { body: {} };
      } });
    await delay(60);
    assert.strictEqual(puts.length, 1, 'the desk reports its own location once on start');
    assert.deepStrictEqual(puts[0], { lat: 12.93035, lng: 77.61905, accuracy_m: 35 });
    assert.ok(t.$('#hereNote').textContent.includes('this screen'), t.$('#hereNote').textContent);
    ok('the desk reports the location of its own screen and says the map uses it');

    assert.ok(tiles.length >= 1);
    assert.ok(tiles.every(x => x.o.referrerPolicy === 'strict-origin-when-cross-origin'), 'every tile layer sends a referrer');
    ok('map tiles are requested with a referrer, so OpenStreetMap does not block them');

    const line = () => t.$('.case-active .live-line').textContent;
    assert.ok(/2\.1 km away · about 7 min \(estimate at city speed\) · 34 km\/h · updated/.test(line()), line());
    ok('the live statement gives distance, ETA (and which kind), speed and freshness');

    t.w.__sock._h['case:position']({ case_code: 'GH-TEST', lat: 12.9262, lng: 77.6183, at: new Date().toISOString(), accuracy_m: 9,
      distance_km: 0.6, live_eta_minutes: 2, eta_source: 'live', est_eta_minutes: 2, moving_kmh: 30 });
    await delay();
    assert.ok(/^Arriving in about 2 min — 600 m away\. Get ready/.test(line()), line());
    assert.ok(t.$('.case.is-arriving'), 'the card is highlighted');
    assert.ok(t.$('#toast').textContent.includes('Arriving'), 'and announced');
    ok('an ambulance 2 minutes out is announced: banner, highlight, toast');

    t.w.__sock._h['case:position']({ case_code: 'GH-TEST', lat: 12.9264, lng: 77.6183, at: new Date(Date.now() - 95000).toISOString(), accuracy_m: 700, approximate: true,
      distance_km: 0.58, live_eta_minutes: null, eta_source: 'crew', est_eta_minutes: 2 });
    await delay();
    for (const fn of t.intervals) await fn();
    assert.ok(/^No location update for 2 min\. Last seen 580 m away\. Position approximate \(±700 m\)/.test(line()), line());
    ok('a silent ambulance is called out as stale, and a rough fix as approximate');
    t.dom.window.close();
  }
  {
    const t = boot({ session: { token: 'T7', username: 'er.test' }, route: (u) => {
      if (u === '/auth/me') return { body: STAFF };
      if (u.startsWith('/desk/queue')) return { body: { pending: [], active: [Object.assign(card(), { notes: '', origin: { lat: 12.9166, lng: 77.605 }, accepted_at: new Date(Date.now() - 120000).toISOString() })] } };
      return { body: {} };
    } });
    await delay(40);
    const text = t.$('.case-active .live-line').textContent;
    assert.ok(/^Waiting for the ambulance’s GPS\. The case was sent from 2\.2 km away — about 8 min \(crew’s estimate\)/.test(text), text);
    assert.ok(text.includes('location off, or the app closed'), text);
    assert.ok(t.$('#hereNote').textContent.includes('hospital address'), 'no geolocation here: the address is used, and said so');
    ok('no GPS yet: the desk says how far the case was sent from, and after a minute why it may be missing');
    t.dom.window.close();
  }

  console.log('\nPASS — ' + passed + ' passed, 0 failed');
})().catch(e => { console.error(e); process.exitCode = 1; });
