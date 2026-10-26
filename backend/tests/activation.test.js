/* ============================================================================
   One login per hospital, and each hospital chooses its own — end to end,
   against the real server (memory store).

     - "Create logins for all hospitals" makes a PENDING login with a one-time
       activation code for every network hospital, returned once
     - codes are stored only as hashes, expire, and work exactly once
     - the hospital chooses its own username (unique, 3–64 chars, letters,
       digits, dot, dash, underscore) and password (the usual strength rules)
     - after activation it signs in with exactly those and opens its own desk,
       which shows its own cases and nobody else's
     - the administrator sees pending / active / disabled / locked and can
       re-issue a code; the old built-in logins are retired

   Run:  node tests/activation.test.js
   ========================================================================== */
'use strict';

const assert = require('assert');

process.env.PORT = process.env.TEST_PORT_ACTIVATION || '5131';
process.env.DB_DRIVER = 'memory';
process.env.DESK_AUTH = 'jwt';
process.env.DEMO_SEED = 'false';
process.env.SUPER_ADMIN_USERNAME = 'root.admin';
process.env.SUPER_ADMIN_PASSWORD = 'correct horse battery staple';
process.env.BCRYPT_ROUNDS = '4';
process.env.HACKATHON_MODE = 'false';
if (process.argv.indexOf('--memory') === -1) process.argv.push('--memory');

const { server } = require('../src/server');
const { getAccounts } = require('../src/store');
const auth = require('../src/services/authService');
const directory = require('../src/services/directoryService');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function group(t) { console.log('\n' + t); }

async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = {}; try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}
const login = (u, p) => call('POST', '/api/v1/auth/login', { username: u, password: p });
const activate = (code, username, password) => call('POST', '/api/v1/auth/activate', { code, username, password });

const ST_JOHNS = 12179, BOWRING = 12815, VICTORIA = 11880, MANIPAL = 100093;

async function main() {
  await new Promise(r => server.listening ? r() : server.once('listening', r));

  const first = await login('root.admin', 'correct horse battery staple');
  const admin = (await call('POST', '/api/v1/auth/change-password',
    { current_password: 'correct horse battery staple', new_password: 'admin pass for tests 2026' }, first.body.token)).body.token;

  group('The administrator creates logins for every hospital at once');
  const bulk = await call('POST', '/api/v1/admin/accounts/activation-codes', {}, admin);
  const codes = new Map((bulk.body.created || []).map(c => [c.hospital_id, c]));
  await check('one PENDING login per network hospital — all 100', () => {
    assert.strictEqual(bulk.status, 201);
    assert.strictEqual(bulk.body.created.length, 100);
    assert.strictEqual(directory.count(), 100);
    [ST_JOHNS, BOWRING, VICTORIA, MANIPAL].forEach(id => assert.ok(codes.has(id), 'no code for ' + id));
  });
  await check('each comes with its own random code and a 7-day expiry, for the CSV', () => {
    const all = bulk.body.created.map(c => c.activation_code);
    assert.strictEqual(new Set(all).size, 100, 'codes must be unique');
    all.forEach(c => assert.ok(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(c), c));
    const days = (new Date(codes.get(ST_JOHNS).expires_at) - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days <= 7.01, 'expires in ' + days + ' days');
    assert.ok(codes.get(ST_JOHNS).hospital && codes.get(ST_JOHNS).district);
  });
  const stored = await getAccounts().findById(codes.get(ST_JOHNS).account_id);
  await check('the server keeps only a hash of each code', () => {
    assert.strictEqual(stored.activation_code_hash.length, 64);
    assert.ok(!JSON.stringify(stored).includes(codes.get(ST_JOHNS).activation_code));
    assert.strictEqual(stored.username, null);
    assert.strictEqual(stored.password_hash, null);
  });
  const listed = await call('GET', '/api/v1/admin/accounts?status=pending', undefined, admin);
  await check('the console lists them as pending activation, and never shows a code again', () => {
    assert.strictEqual(listed.body.accounts.length, 100);
    assert.ok(listed.body.accounts.every(a => a.state === 'PENDING' && a.username === null));
    assert.ok(!JSON.stringify(listed.body).includes(codes.get(ST_JOHNS).activation_code));
    assert.ok(!JSON.stringify(listed.body).includes('activation_code_hash'));
  });
  const again = await call('POST', '/api/v1/admin/accounts/activation-codes', {}, admin);
  await check('running it again creates nothing new', () => {
    assert.strictEqual(again.body.created.length, 0); assert.strictEqual(again.body.skipped, 100);
  });

  group('Activation: the hospital chooses its own username and password');
  const sjCode = codes.get(ST_JOHNS).activation_code;
  const look = await call('POST', '/api/v1/auth/activate/lookup', { code: sjCode.toLowerCase().replace(/-/g, ' ') });
  await check('the code says which hospital it is for (case and spaces ignored)', () => {
    assert.strictEqual(look.status, 200); assert.strictEqual(look.body.hospital.hospital_id, ST_JOHNS);
  });
  const wrong = await activate('ABCD-EFGH-JKMN-PQRS', 'er.someone', 'a long enough password');
  await check('a wrong code is refused', () => { assert.strictEqual(wrong.status, 400); assert.strictEqual(wrong.body.reason, 'INVALID_CODE'); });
  for (const [bad, why] of [['ab', 'too short'], ['x'.repeat(65), 'too long'], ['er stjohns', 'a space'], ['er@stjohns', 'an @']]) {
    const r = await activate(sjCode, bad, 'st johns emergency 2026');
    await check('username refused: ' + why, () => { assert.strictEqual(r.status, 400); assert.strictEqual(r.body.reason, 'BAD_USERNAME'); });
  }
  for (const [bad, why] of [['short pw', 'under 10 characters'], ['aaaaaaaaaaaa', 'one repeated character'], ['password123', 'a common password'], ['my er.stjohns pw', 'contains the username']]) {
    const r = await activate(sjCode, 'er.stjohns', bad);
    await check('password refused: ' + why, () => { assert.strictEqual(r.status, 400); assert.strictEqual(r.body.reason, 'WEAK'); });
  }
  await check('…and none of those refusals used up the code', async () => {
    assert.strictEqual((await call('POST', '/api/v1/auth/activate/lookup', { code: sjCode })).status, 200);
  });
  const done = await activate(sjCode, 'ER.StJohns_Casualty-1', 'st johns emergency 2026');
  await check('a valid choice activates the login and signs straight in', () => {
    assert.strictEqual(done.status, 201);
    assert.ok(done.body.token);
    assert.strictEqual(done.body.account.username, 'er.stjohns_casualty-1');
    assert.strictEqual(done.body.account.must_change_password, false);
    assert.strictEqual(done.body.hospital.hospital_id, ST_JOHNS);
  });
  const reuse = await activate(sjCode, 'er.other', 'another long password');
  await check('the code works only once', () => { assert.strictEqual(reuse.status, 400); assert.strictEqual(reuse.body.reason, 'INVALID_CODE'); });
  const signIn = await login('er.stjohns_casualty-1', 'st johns emergency 2026');
  await check('the hospital signs in with exactly the username and password it chose', () => {
    assert.strictEqual(signIn.status, 200);
    assert.strictEqual(signIn.body.hospital.hospital_id, ST_JOHNS);
  });
  await check('the username is not case-sensitive, the password is', async () => {
    assert.strictEqual((await login('ER.STJOHNS_CASUALTY-1', 'st johns emergency 2026')).status, 200);
    assert.strictEqual((await login('er.stjohns_casualty-1', 'ST JOHNS EMERGENCY 2026')).status, 401);
  });
  const taken = await activate(codes.get(BOWRING).activation_code, 'er.stjohns_casualty-1', 'bowring emergency 2026');
  await check('another hospital cannot take a username already in use', () => {
    assert.strictEqual(taken.status, 409); assert.strictEqual(taken.body.reason, 'TAKEN');
  });
  const bw = await activate(codes.get(BOWRING).activation_code, 'er.bowring', 'bowring emergency 2026');
  await check('…and activates with a different one', () => assert.strictEqual(bw.status, 201));

  /* Expiry: wind the clock on Victoria's code. */
  await getAccounts().update(codes.get(VICTORIA).account_id, { activation_expires_at: new Date(Date.now() - 1000).toISOString() });
  const expired = await activate(codes.get(VICTORIA).activation_code, 'er.victoria', 'victoria emergency 2026');
  await check('an expired code is refused', () => { assert.strictEqual(expired.status, 410); assert.strictEqual(expired.body.reason, 'CODE_EXPIRED'); });
  const vicRow = (await call('GET', '/api/v1/admin/accounts?q=victoria', undefined, admin)).body.accounts.find(a => a.hospital_id === VICTORIA);
  await check('the console shows it as expired', () => assert.strictEqual(vicRow.state, 'EXPIRED'));
  const reissued = await call('POST', '/api/v1/admin/accounts/' + vicRow.account_id + '/activation', {}, admin);
  await check('the administrator re-issues a code; the old one stays dead, the new one works', async () => {
    assert.strictEqual(reissued.status, 200);
    assert.notStrictEqual(reissued.body.activation_code, codes.get(VICTORIA).activation_code);
    assert.strictEqual((await activate(codes.get(VICTORIA).activation_code, 'er.victoria', 'victoria emergency 2026')).status, 400);
    assert.strictEqual((await activate(reissued.body.activation_code, 'er.victoria', 'victoria emergency 2026')).status, 201);
  });

  group('Each hospital sees only its own cases');
  const sj = signIn.body.token, bowring = bw.body.token;
  /* Koramangala, 3 km radius: St John's is inside, Bowring (~6 km) is not. */
  const mine = await call('POST', '/api/v1/requests', { case_type_id: 8, age: 52, gender: 'M',
    origin: { lat: 12.9350, lng: 77.6200, source: 'gps' }, broadcast_radius_km: 3 });
  /* Near Bowring (Shivajinagar), 1 km: St John's is not inside. */
  const theirs = await call('POST', '/api/v1/requests', { case_type_id: 1, age: 30, gender: 'F',
    origin: { lat: 12.9830, lng: 77.6040, source: 'gps' }, broadcast_radius_km: 1 });
  const qSJ = await call('GET', '/api/v1/desk/queue', undefined, sj);
  const qBW = await call('GET', '/api/v1/desk/queue', undefined, bowring);
  await check("St John's queue has its case and not Bowring's", () => {
    const codesSJ = qSJ.body.cases.map(c => c.case_code);
    assert.ok(codesSJ.includes(mine.body.id)); assert.ok(!codesSJ.includes(theirs.body.id));
    assert.strictEqual(qSJ.body.hospital.hospital_id, ST_JOHNS);
  });
  await check("Bowring's queue has its case and not St John's", () => {
    const codesBW = qBW.body.cases.map(c => c.case_code);
    assert.ok(codesBW.includes(theirs.body.id)); assert.ok(!codesBW.includes(mine.body.id));
  });
  await check('a desk cannot accept or read a case offered to another hospital', async () => {
    assert.strictEqual((await call('POST', '/api/v1/desk/accept/' + theirs.body.id, {}, sj)).status, 409);
    assert.strictEqual((await call('GET', '/api/v1/desk/timeline/' + theirs.body.id, undefined, sj)).status === 200, false);
  });
  const hist = await call('GET', '/api/v1/desk/history', undefined, bowring);
  await check("history never contains another hospital's case", () => assert.ok(!hist.body.cases.some(c => c.case_code === mine.body.id)));

  group('Status, lockout and revocation still apply');
  for (let i = 0; i < 5; i++) await login('er.bowring', 'wrong guess number ' + i);
  const states = new Map((await call('GET', '/api/v1/admin/accounts', undefined, admin)).body.accounts
    .filter(a => a.hospital_id).map(a => [a.hospital_id, a.state]));
  await check('the console shows active, locked and pending hospitals', () => {
    assert.strictEqual(states.get(ST_JOHNS), 'ACTIVE');
    assert.strictEqual(states.get(BOWRING), 'LOCKED');
    assert.strictEqual(states.get(MANIPAL), 'PENDING');
  });
  const sjRow = (await call('GET', '/api/v1/admin/accounts?q=casualty', undefined, admin)).body.accounts[0];
  await call('POST', '/api/v1/admin/accounts/' + sjRow.account_id + '/disable', {}, admin);
  await check('disabling ends the session at once and shows as disabled', async () => {
    assert.ok([401, 403].includes((await call('GET', '/api/v1/desk/queue', undefined, sj)).status));
    const row = (await call('GET', '/api/v1/admin/accounts?q=casualty', undefined, admin)).body.accounts[0];
    assert.strictEqual(row.state, 'DISABLED');
  });
  const re = await call('POST', '/api/v1/admin/accounts/' + sjRow.account_id + '/activation', {}, admin);
  await check('re-issuing a code to an existing login voids its password', async () => {
    assert.strictEqual(re.status, 200);
    assert.strictEqual((await login('er.stjohns_casualty-1', 'st johns emergency 2026')).status, 401);
  });
  const single = await call('POST', '/api/v1/admin/accounts', { hospital_id: 17701, mode: 'activation' }, admin);
  await check('a single login can also be created with an activation code', () => {
    assert.strictEqual(single.status, 201); assert.ok(single.body.activation_code); assert.strictEqual(single.body.account.status, 'PENDING');
  });
  const audit = await call('GET', '/api/v1/admin/audit?limit=500', undefined, admin);
  await check('activations and code issues are in the audit log, without any code', () => {
    const types = audit.body.events.map(e => e.event_type);
    ['ACTIVATION_CODES_ISSUED', 'ACCOUNT_ACTIVATED', 'ACTIVATION_FAILED', 'ACTIVATION_REISSUED'].forEach(t => assert.ok(types.includes(t), 'missing ' + t));
    assert.ok(!JSON.stringify(audit.body).includes(sjCode));
    assert.ok(!JSON.stringify(audit.body).includes('st johns emergency 2026'));
  });

  group('The old built-in logins are gone');
  await getAccounts().create({ username: 'er.oldseed', password_hash: await auth.hashPassword('old published password'),
    role: 'HOSPITAL_STAFF', hospital_id: MANIPAL, must_change_password: false, created_by: 'seed-file' });
  await check('a login from the old seed file works until the server retires it…', async () => {
    assert.strictEqual((await login('er.oldseed', 'old published password')).status, 200);
  });
  await auth.retireSeedAccounts({ log() {} });
  await check('…and never after', async () => {
    assert.notStrictEqual((await login('er.oldseed', 'old published password')).status, 200);
  });
  await check('backend/seed/accounts.json no longer exists', () => {
    assert.ok(!require('fs').existsSync(require('path').join(__dirname, '..', 'seed', 'accounts.json')));
  });

  server.close();
  console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') + ` — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.log('\nHARNESS ERROR: ' + (err && err.stack || err)); process.exit(1); });
