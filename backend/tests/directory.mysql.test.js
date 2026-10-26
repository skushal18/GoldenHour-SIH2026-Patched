#!/usr/bin/env node
/* ============================================================================
   The hospital directory and the activation path against a real MySQL.

     - the boot migration upgrades a v6 database in place (nullable username
       and password, PENDING status) and creates the hospitals table
     - the seed loads exactly the 100 network hospitals, and a second run
       changes nothing — not even a hospital the admin has switched off
     - the server reads the network from the hospitals table, and /health
       says store mysql and names the database host
     - imports and on/off switches are written to the table
     - two activations of one code race to a single winner; usernames are unique

   Needs TEST_MYSQL_URL=mysql://user:pass@host:port/<db with "test" in its
   name> — every table in that database is dropped first. Without it the suite
   is skipped (CI runs it against a MySQL 8.4 service container).
   ========================================================================== */
'use strict';
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const URL_ = process.env.TEST_MYSQL_URL;
if (!URL_) { console.log('\nhospital directory on MySQL\n  skipped — set TEST_MYSQL_URL to run'); process.exit(0); }
process.env.DATABASE_URL = URL_;

let pass = 0, fail = 0;
async function ok(n, f) { try { await f(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + ': ' + (e && e.message)); } }

async function main() {
  const pool = require('../src/config/db');
  if (!/test/i.test(pool.settings.database)) throw new Error('refusing to wipe a database whose name does not contain "test"');
  const [tables] = await pool.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  for (const { t } of tables) await pool.query('DROP TABLE `' + t + '`');

  console.log('\nhospital directory on MySQL (' + pool.settings.host + '/' + pool.settings.database + ')');

  /* A v6 accounts table, holding a login from the old seed file. */
  await pool.query(`CREATE TABLE accounts (
    account_id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(64) NOT NULL, password_hash VARCHAR(100) NOT NULL,
    role ENUM('SUPER_ADMIN','HOSPITAL_STAFF') NOT NULL, hospital_id INT NULL,
    status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE', must_change_password TINYINT(1) NOT NULL DEFAULT 1,
    failed_attempts INT NOT NULL DEFAULT 0, locked_until DATETIME NULL, token_version INT NOT NULL DEFAULT 0,
    last_login_at DATETIME NULL, created_by VARCHAR(64) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_account_username (username), INDEX idx_account_hospital (hospital_id))`);
  const bcrypt = require('bcryptjs');
  await pool.query("INSERT INTO accounts (username, password_hash, role, hospital_id, must_change_password, created_by) VALUES ('er.old', ?, 'HOSPITAL_STAFF', 12179, 0, 'seed-file')",
    [bcrypt.hashSync('old published password', 4)]);

  const { ensureSchema } = require('../src/store/migrate');
  await ensureSchema(pool, { log() {} });
  await ok('the migration upgrades a v6 accounts table in place', async () => {
    const [cols] = await pool.query("SELECT COLUMN_NAME c, IS_NULLABLE n, COLUMN_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts'");
    const by = Object.fromEntries(cols.map(x => [x.c, x]));
    assert.strictEqual(by.username.n, 'YES'); assert.strictEqual(by.password_hash.n, 'YES');
    assert.ok(/PENDING/.test(by.status.t)); assert.ok(by.activation_code_hash && by.activation_expires_at && by.activated_at);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) n FROM accounts WHERE username='er.old'");
    assert.strictEqual(Number(n), 1, 'existing rows survive');
  });
  await ok('running the migration twice is harmless', async () => { await ensureSchema(pool, { log() {} }); });

  const directory = require('../src/services/directoryService');
  const first = await directory.seedNetwork(pool);
  await ok('the seed loads exactly the 100 network hospitals', async () => {
    assert.deepStrictEqual(first, { inserted: 100, already: 0, missing: [] });
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM hospitals');
    assert.strictEqual(Number(n), 100);
  });
  const [[before]] = await pool.query('CHECKSUM TABLE hospitals');
  await pool.query('UPDATE hospitals SET active = 0 WHERE id = 12815');
  const [[switched]] = await pool.query('CHECKSUM TABLE hospitals');
  const second = await directory.seedNetwork(pool);
  const [[after]] = await pool.query('CHECKSUM TABLE hospitals');
  await ok('a second run inserts nothing and changes nothing (an admin switch-off survives)', async () => {
    assert.deepStrictEqual(second, { inserted: 0, already: 100, missing: [] });
    assert.strictEqual(String(after.Checksum), String(switched.Checksum));
    assert.notStrictEqual(String(before.Checksum), String(switched.Checksum));
  });

  await ok('rows hold the directory id, location grade and phone from the CSV', async () => {
    const [[sj]] = await pool.query('SELECT * FROM hospitals WHERE id = 12179');
    assert.ok(/St John/.test(sj.name)); assert.strictEqual(sj.coord_source, 'listed'); assert.ok(sj.phone);
    assert.strictEqual(sj.district, 'Bengaluru Urban'); assert.ok(Number(sj.lat) > 12 && Number(sj.lng) > 77);
  });

  const n = await directory.attach(pool);
  await ok('the network is read from the hospitals table', async () => {
    assert.strictEqual(n, 100);
    assert.strictEqual(directory.summary().source, 'mysql');
    assert.strictEqual(directory.get(12815).active, false);
    assert.ok(!directory.nearby(12.983, 77.604, 2).some(h => h.hospital_id === 12815), 'switched off hospitals are never offered');
    assert.ok(directory.nearby(12.935, 77.62, 3).some(h => h.hospital_id === 12179));
  });
  await ok('switching a hospital on is written to the table', async () => {
    await directory.setActive(12815, true);
    const [[r]] = await pool.query('SELECT active FROM hospitals WHERE id = 12815');
    assert.strictEqual(Number(r.active), 1);
  });
  await ok('importing from the catalogue inserts the row; importing again does not', async () => {
    const r1 = await directory.importFromCatalogue([1]);
    const r2 = await directory.importFromCatalogue([1]);
    assert.deepStrictEqual(r1.added, [1]); assert.deepStrictEqual(r2.added, []);
    const [[{ c }]] = await pool.query('SELECT COUNT(*) c FROM hospitals');
    assert.strictEqual(Number(c), 101);
    await pool.query('DELETE FROM hospitals WHERE id = 1'); await directory.reload();
  });

  const { createMysqlAccounts } = require('../src/store/accountStore');
  const accounts = createMysqlAccounts(pool);
  const hash = 'a'.repeat(64);
  const p = await accounts.create({ username: null, password_hash: null, role: 'HOSPITAL_STAFF', hospital_id: 11880, status: 'PENDING',
    must_change_password: false, activation_code_hash: hash, activation_expires_at: new Date(Date.now() + 86400000).toISOString(), created_by: 'test' });
  await ok('a pending login has no username or password and is found by its code hash', async () => {
    assert.strictEqual(p.status, 'PENDING'); assert.strictEqual(p.username, null);
    assert.strictEqual((await accounts.findByActivationHash(hash)).account_id, p.account_id);
  });
  await ok('two activations of one code: exactly one wins', async () => {
    const patch = u => ({ username: u, password_hash: 'x', status: 'ACTIVE', activation_code_hash: null, activation_expires_at: null });
    const results = await Promise.all([accounts.activate(p.account_id, hash, patch('er.vic.a')), accounts.activate(p.account_id, hash, patch('er.vic.b'))]);
    assert.strictEqual(results.filter(Boolean).length, 1);
    assert.strictEqual((await accounts.findById(p.account_id)).status, 'ACTIVE');
  });
  await ok('a username already taken is refused by the database', async () => {
    const q = await accounts.create({ username: null, role: 'HOSPITAL_STAFF', hospital_id: 100093, status: 'PENDING', activation_code_hash: 'b'.repeat(64) });
    await assert.rejects(accounts.activate(q.account_id, 'b'.repeat(64), { username: 'ER.OLD', password_hash: 'x', status: 'ACTIVE' }), e => e.code === 'DUPLICATE');
  });
  await pool.end();

  /* The real server against this database. */
  const port = 5141;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'start.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DB_DRIVER: 'mysql', DESK_AUTH: 'jwt', DEMO_SEED: 'false', BCRYPT_ROUNDS: '4',
      SUPER_ADMIN_USERNAME: 'root.admin', SUPER_ADMIN_PASSWORD: 'correct horse battery staple' }),
    stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60 && !/listening/.test(log); i++) await new Promise(r => setTimeout(r, 250));
  const call = async (method, p2, body, token) => {
    const r = await fetch('http://127.0.0.1:' + port + p2, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    const health = await call('GET', '/health');
    await ok('/health: store mysql, the database host, 100 hospitals from the table', async () => {
      assert.strictEqual(health.status, 200, log);
      assert.strictEqual(health.body.store, 'mysql');
      assert.strictEqual(health.body.database.host, require('../src/config/db').connectionSettings().host);
      assert.strictEqual(health.body.directory_hospitals, 100);
      assert.strictEqual(health.body.directory_source, 'mysql');
    });
    await ok('the old seed-file login was retired at boot', async () => {
      assert.notStrictEqual((await call('POST', '/api/v1/auth/login', { username: 'er.old', password: 'old published password' })).status, 200);
    });
    const a = await call('POST', '/api/v1/auth/login', { username: 'root.admin', password: 'correct horse battery staple' });
    const admin = (await call('POST', '/api/v1/auth/change-password', { current_password: 'correct horse battery staple', new_password: 'admin pass for tests 2026' }, a.body.token)).body.token;
    const bulk = await call('POST', '/api/v1/admin/accounts/activation-codes', {}, admin);
    await ok('bulk login creation works on MySQL (hospitals that already have a login are skipped)', async () => {
      assert.strictEqual(bulk.status, 201, JSON.stringify(bulk.body));
      assert.strictEqual(bulk.body.created.length + bulk.body.skipped, 100);
    });
    const sj = bulk.body.created.find(c => c.hospital_id === 12815);
    const act = await call('POST', '/api/v1/auth/activate', { code: sj.activation_code, username: 'er.bowring', password: 'bowring emergency 2026' });
    const signIn = await call('POST', '/api/v1/auth/login', { username: 'er.bowring', password: 'bowring emergency 2026' });
    await ok('a hospital activates and signs in with its own username and password', async () => {
      assert.strictEqual(act.status, 201, JSON.stringify(act.body));
      assert.strictEqual(signIn.status, 200); assert.strictEqual(signIn.body.hospital.hospital_id, 12815);
    });
  } finally { child.kill('SIGTERM'); }

  console.log(`\n${pass} ok / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.log('HARNESS ERROR', e && e.stack || e); process.exit(1); });
