#!/usr/bin/env node
/* ============================================================================
   security.test.js — the boot-time configuration gate.

   This gate is only worth having if it is exercised, so these checks are
   deliberately about the *decisions* rather than the wording: which
   configurations are fatal in production, which are merely noted in
   development, and that a correct production environment is accepted.
   ========================================================================== */
'use strict';

const assert = require('assert');
const path = require('path');

/* Load the module without letting a stray .env on the developer's machine
   leak into these assertions. */
const SECURITY = path.join(__dirname, '..', 'src', 'config', 'security.js');
const security = require(SECURITY);

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function group(t) { console.log('\n' + t); }

const KEYS = ['NODE_ENV', 'DESK_AUTH', 'JWT_SECRET', 'CORS_ORIGIN', 'DB_DRIVER',
              'HACKATHON_MODE', 'ALLOW_MANUAL_HOSPITAL_OVERRIDE'];

/** Run an audit under exactly this environment and nothing else. */
function audit(env) {
  const saved = {};
  KEYS.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.keys(env).forEach(k => { process.env[k] = env[k]; });
  try { return security.audit(); }
  finally {
    KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  }
}

const STRONG = 'k3Jq8vX2mZ7pL9wR4tY6bN1cD5fG0hS8aQ2eU7iO3yT1';   // 44 chars
const PRODUCTION_OK = {
  NODE_ENV: 'production', DESK_AUTH: 'jwt', JWT_SECRET: STRONG,
  CORS_ORIGIN: 'https://goldenhour.example', DB_DRIVER: 'mysql',
  HACKATHON_MODE: 'false', ALLOW_MANUAL_HOSPITAL_OVERRIDE: 'false',
};

function fatalText(result) { return result.fatal.join(' | '); }

/* ── Development ───────────────────────────────────────────────────────── */

group('Development keeps its conveniences');

check('a bare demo configuration starts, with warnings', () => {
  const r = audit({});
  assert.strictEqual(r.fatal.length, 0, 'should never be fatal outside production: ' + fatalText(r));
  assert.ok(r.warnings.length >= 2, 'expected warnings about DESK_AUTH and CORS');
});

check('desk auth defaults to ip in development and jwt in production', () => {
  assert.strictEqual(audit({}).deskAuth, 'ip');
  assert.strictEqual(audit({ NODE_ENV: 'production' }).deskAuth, 'jwt');
});

check('a weak secret under DESK_AUTH=jwt is a warning, not a refusal', () => {
  const r = audit({ DESK_AUTH: 'jwt', JWT_SECRET: 'test_secret_for_desk_auth' });
  assert.strictEqual(r.fatal.length, 0, fatalText(r));
  assert.ok(r.warnings.some(w => /JWT_SECRET/.test(w)));
});

/* ── Production ────────────────────────────────────────────────────────── */

group('Production refuses what would be unsafe');

check('a bare demo configuration is refused', () => {
  const r = audit({ NODE_ENV: 'production' });
  assert.ok(r.fatal.length >= 4, 'expected several fatal findings, got: ' + fatalText(r));
});

check('IP-based desk identity is refused', () => {
  const r = audit(Object.assign({}, PRODUCTION_OK, { DESK_AUTH: 'ip' }));
  assert.ok(/DESK_AUTH/.test(fatalText(r)), fatalText(r));
});

check('a missing JWT_SECRET is refused', () => {
  const r = audit(Object.assign({}, PRODUCTION_OK, { JWT_SECRET: '' }));
  assert.ok(/JWT_SECRET/.test(fatalText(r)), fatalText(r));
});

check('the secret published in .env.example is refused', () => {
  const r = audit(Object.assign({}, PRODUCTION_OK, { JWT_SECRET: 'goldenhour_2026' }));
  assert.ok(/published in this repository/.test(fatalText(r)), fatalText(r));
});

check('a short secret is refused even if nobody has published it', () => {
  const r = audit(Object.assign({}, PRODUCTION_OK, { JWT_SECRET: 'a-secret-nobody-knows' }));
  assert.ok(/characters/.test(fatalText(r)), fatalText(r));
});

check('an unset CORS_ORIGIN is refused', () => {
  const r = audit(Object.assign({}, PRODUCTION_OK, { CORS_ORIGIN: '' }));
  assert.ok(/CORS_ORIGIN/.test(fatalText(r)), fatalText(r));
});

check('a wildcard CORS_ORIGIN is refused', () => {
  const r = audit(Object.assign({}, PRODUCTION_OK, { CORS_ORIGIN: '*' }));
  assert.ok(/every origin/.test(fatalText(r)), fatalText(r));
});

check('DB_DRIVER=auto is refused — it loses cases silently on a DB outage', () => {
  const r = audit(Object.assign({}, PRODUCTION_OK, { DB_DRIVER: 'auto' }));
  assert.ok(/DB_DRIVER/.test(fatalText(r)), fatalText(r));
});

check('DB_DRIVER=memory is refused', () => {
  const r = audit(Object.assign({}, PRODUCTION_OK, { DB_DRIVER: 'memory' }));
  assert.ok(/DB_DRIVER/.test(fatalText(r)), fatalText(r));
});

check('HACKATHON_MODE left on is refused', () => {
  const r = audit(Object.assign({}, PRODUCTION_OK, { HACKATHON_MODE: 'true' }));
  assert.ok(/HACKATHON_MODE/.test(fatalText(r)), fatalText(r));
});

check('a correct production configuration is accepted', () => {
  const r = audit(PRODUCTION_OK);
  assert.strictEqual(r.fatal.length, 0, fatalText(r));
  assert.strictEqual(r.deskAuth, 'jwt');
  assert.strictEqual(r.driver, 'mysql');
  assert.deepStrictEqual(r.cors, ['https://goldenhour.example']);
});

check('enforce() throws on a fatal finding and returns on a clean one', () => {
  const quiet = { warn(){}, error(){}, log(){} };
  const saved = {};
  KEYS.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  try {
    process.env.NODE_ENV = 'production';
    assert.throws(() => security.enforce(quiet), /Unsafe production configuration/);
    Object.keys(PRODUCTION_OK).forEach(k => { process.env[k] = PRODUCTION_OK[k]; });
    const ok = security.enforce(quiet);
    assert.strictEqual(ok.fatal.length, 0);
  } finally {
    KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  }
});

/* ── Multiple origins ──────────────────────────────────────────────────── */

group('CORS parsing');

check('a comma-separated list becomes an array of origins', () => {
  const r = audit(Object.assign({}, PRODUCTION_OK, { CORS_ORIGIN: 'https://a.example, https://b.example' }));
  assert.deepStrictEqual(r.cors, ['https://a.example', 'https://b.example']);
});

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
