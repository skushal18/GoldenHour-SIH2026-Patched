/* ============================================================================
   Central sign-in for GoldenHour.

   One central server, one account database. Each hospital has its own login;
   signing in opens that hospital's ER desk and nothing else, because the
   hospital a desk acts for comes from the signed token — never from the URL,
   a header, the IP address or anything else the browser can change.

   Rules:
   * Passwords are bcrypt hashes. A temporary password set by an administrator
     must be changed at first sign-in; until then the desk API refuses.
   * Five wrong passwords lock the account for 15 minutes. "No such user" and
     "wrong password" give the same answer and take the same time.
   * A token names its account and the account's token_version. Disabling an
     account, resetting its password or signing out everywhere bumps the
     version, which voids every token issued before — so a disabled hospital
     is locked out on its very next request, not when its token expires.
   ========================================================================== */
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getAccounts } = require('../store');
const { publicView } = require('../store/accountStore');
const directory = require('./directoryService');

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 11;
const MIN_PASSWORD = 10;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const TOKEN_TTL = process.env.JWT_TTL || '12h';
const ROLES = ['SUPER_ADMIN', 'HOSPITAL_STAFF'];
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
/* A real bcrypt hash of a random string, compared against when the user does
   not exist so both paths take the same time. */
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 4);

let ephemeralSecret = null;
function secret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  /* Development only (production refuses to boot without one): a random
     per-process secret, so sign-in works out of the box and nobody can
     forge a token with a value printed in the repository. Restarting the
     server signs everybody out. */
  if (!ephemeralSecret) ephemeralSecret = crypto.randomBytes(48).toString('base64url');
  return ephemeralSecret;
}

function hashPassword(pw) { return bcrypt.hash(String(pw), BCRYPT_ROUNDS); }

/** A readable temporary password: no 0/O/1/l/I, grouped for reading aloud. */
function generatePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(15);
  let s = '';
  for (let i = 0; i < 15; i++) s += alphabet[bytes[i] % alphabet.length];
  return s.slice(0, 5) + '-' + s.slice(5, 10) + '-' + s.slice(10);
}

function passwordProblem(pw, username) {
  const p = String(pw || '');
  if (p.length < MIN_PASSWORD) return 'Use at least ' + MIN_PASSWORD + ' characters.';
  if (p.length > 200) return 'That password is too long.';
  if (username && p.toLowerCase().indexOf(String(username).toLowerCase()) !== -1) return 'The password must not contain the username.';
  if (/^(.)\1+$/.test(p)) return 'That password is too easy to guess.';
  if (['password123', 'goldenhour1', '1234567890', 'qwertyuiop'].includes(p.toLowerCase())) return 'That password is too easy to guess.';
  return null;
}

function normaliseUsername(u) { return String(u || '').trim().toLowerCase(); }

function hospitalFor(account) {
  if (!account || account.hospital_id == null) return null;
  const h = directory.get(account.hospital_id);
  if (!h) return { hospital_id: account.hospital_id, name: 'Hospital #' + account.hospital_id };
  return {
    hospital_id: h.hospital_id, name: h.name, state: h.state, district: h.district, pincode: h.pincode,
    lat: h.lat, lng: h.lng, contact: h.contact, ownership: h.ownership, coord_source: h.coord_source,
  };
}

function issueToken(account) {
  return jwt.sign({ sub: String(account.account_id), role: account.role, hospital_id: account.hospital_id,
    tv: account.token_version || 0 }, secret(), { expiresIn: TOKEN_TTL, algorithm: 'HS256' });
}

function sessionBody(account, token) {
  return { token, expires_in: TOKEN_TTL, account: publicView(account), hospital: hospitalFor(account) };
}

/**
 * @returns {Promise<{ok:true, session}|{ok:false, status, reason, message, retry_after?}>}
 */
async function login(username, password) {
  const accounts = getAccounts();
  const name = normaliseUsername(username);
  if (!name || !password) return { ok: false, status: 400, reason: 'MISSING', message: 'Enter your username and password.' };

  const account = await accounts.findByUsername(name);
  const ok = await bcrypt.compare(String(password), account ? account.password_hash : DUMMY_HASH);
  const now = Date.now();

  if (account && account.locked_until && new Date(account.locked_until).getTime() > now) {
    const mins = Math.ceil((new Date(account.locked_until).getTime() - now) / 60000);
    return { ok: false, status: 423, reason: 'LOCKED', retry_after: mins * 60,
      message: 'Too many wrong passwords. Try again in ' + mins + ' minute' + (mins === 1 ? '' : 's') + ', or ask your administrator.' };
  }
  if (!account || !ok) {
    if (account) {
      const failed = (account.failed_attempts || 0) + 1;
      const patch = { failed_attempts: failed };
      if (failed >= MAX_FAILED) { patch.locked_until = new Date(now + LOCK_MINUTES * 60000).toISOString(); patch.failed_attempts = 0; }
      await accounts.update(account.account_id, patch);
      if (patch.locked_until) {
        return { ok: false, status: 423, reason: 'LOCKED', retry_after: LOCK_MINUTES * 60,
          message: 'Too many wrong passwords. This login is locked for ' + LOCK_MINUTES + ' minutes.' };
      }
      return { ok: false, status: 401, reason: 'INVALID', remaining: MAX_FAILED - failed,
        message: 'Username or password is incorrect. ' + (MAX_FAILED - failed) + ' tr' + (MAX_FAILED - failed === 1 ? 'y' : 'ies') + ' left.' };
    }
    return { ok: false, status: 401, reason: 'INVALID', message: 'Username or password is incorrect.' };
  }
  if (account.status !== 'ACTIVE') {
    return { ok: false, status: 403, reason: 'DISABLED', message: 'This login has been disabled. Contact your GoldenHour administrator.' };
  }
  if (account.role === 'HOSPITAL_STAFF' && !directory.get(account.hospital_id)) {
    return { ok: false, status: 403, reason: 'NO_HOSPITAL', message: 'This login is not linked to a hospital in the directory.' };
  }
  const updated = await accounts.update(account.account_id, { failed_attempts: 0, locked_until: null, last_login_at: new Date().toISOString() });
  return { ok: true, session: sessionBody(updated, issueToken(updated)) };
}

/**
 * Verifies a bearer token AND the account behind it, on every request.
 * @returns {Promise<{ok:true, account}|{ok:false, status, reason, message}>}
 */
async function verify(token) {
  if (!token) return { ok: false, status: 401, reason: 'NO_TOKEN', message: 'Sign in first.' };
  let claims;
  try { claims = jwt.verify(String(token), secret(), { algorithms: ['HS256'] }); }
  catch (err) {
    const expired = err && err.name === 'TokenExpiredError';
    return { ok: false, status: 401, reason: expired ? 'EXPIRED' : 'BAD_TOKEN', message: expired ? 'Your session has ended. Sign in again.' : 'Sign in again.' };
  }
  const account = await getAccounts().findById(claims.sub);
  if (!account) return { ok: false, status: 401, reason: 'NO_ACCOUNT', message: 'Sign in again.' };
  if ((account.token_version || 0) !== (claims.tv || 0)) return { ok: false, status: 401, reason: 'REVOKED', message: 'You were signed out. Sign in again.' };
  if (account.status !== 'ACTIVE') return { ok: false, status: 403, reason: 'DISABLED', message: 'This login has been disabled.' };
  return { ok: true, account };
}

function bearer(req) {
  const h = req.headers && req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  return null;
}

async function changePassword(account, current, next) {
  const accounts = getAccounts();
  const fresh = await accounts.findById(account.account_id);
  if (!fresh || !(await bcrypt.compare(String(current || ''), fresh.password_hash))) {
    return { ok: false, status: 400, reason: 'WRONG_CURRENT', message: 'Your current password is not right.' };
  }
  const problem = passwordProblem(next, fresh.username);
  if (problem) return { ok: false, status: 400, reason: 'WEAK', message: problem };
  if (await bcrypt.compare(String(next), fresh.password_hash)) {
    return { ok: false, status: 400, reason: 'SAME', message: 'Choose a password different from the old one.' };
  }
  const updated = await accounts.update(fresh.account_id, {
    password_hash: await hashPassword(next), must_change_password: false, token_version: (fresh.token_version || 0) + 1,
  });
  /* Every other session for this login ends; this one gets a fresh token. */
  return { ok: true, session: sessionBody(updated, issueToken(updated)) };
}

async function signOutEverywhere(account) {
  const fresh = await getAccounts().findById(account.account_id);
  if (fresh) await getAccounts().update(fresh.account_id, { token_version: (fresh.token_version || 0) + 1 });
}

/* ── Administration ──────────────────────────────────────────────────────── */

async function createHospitalAccount({ hospital_id, username }, actor) {
  const accounts = getAccounts();
  const h = directory.get(hospital_id);
  if (!h) return { ok: false, status: 400, reason: 'NO_HOSPITAL', message: 'Pick a hospital from the directory.' };
  const name = normaliseUsername(username) || suggestUsername(h);
  if (!USERNAME_RE.test(name)) return { ok: false, status: 400, reason: 'BAD_USERNAME', message: 'Usernames are 3–64 characters: lower-case letters, digits, dot, dash or underscore.' };
  const temp = generatePassword();
  try {
    const account = await accounts.create({ username: name, password_hash: await hashPassword(temp), role: 'HOSPITAL_STAFF',
      hospital_id: h.hospital_id, must_change_password: true, created_by: actor ? actor.username : null });
    return { ok: true, account: publicView(account), hospital: hospitalFor(account), temporary_password: temp };
  } catch (err) {
    if (err.code === 'DUPLICATE') return { ok: false, status: 409, reason: 'TAKEN', message: 'That username is already in use.' };
    throw err;
  }
}

function suggestUsername(h) {
  const words = String(h.name).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w && !['the', 'and', 'of', 'hospital', 'hospitals', 'pvt', 'ltd', 'private', 'limited', 'centre', 'center', 'st', 'dr', 'shri', 'sri'].includes(w));
  const core = (words.slice(0, 2).join('-') || 'hospital').slice(0, 40);
  return 'er.' + core + '.' + h.hospital_id;
}

async function resetPassword(accountId, actor) {
  const accounts = getAccounts();
  const a = await accounts.findById(accountId);
  if (!a) return { ok: false, status: 404, reason: 'NOT_FOUND', message: 'No such account.' };
  if (a.role === 'SUPER_ADMIN' && actor && a.account_id === actor.account_id) {
    return { ok: false, status: 400, reason: 'SELF', message: 'Change your own password from your account menu.' };
  }
  const temp = generatePassword();
  const updated = await accounts.update(a.account_id, { password_hash: await hashPassword(temp), must_change_password: true,
    failed_attempts: 0, locked_until: null, token_version: (a.token_version || 0) + 1 });
  return { ok: true, account: publicView(updated), temporary_password: temp };
}

async function setStatus(accountId, status, actor) {
  const accounts = getAccounts();
  const a = await accounts.findById(accountId);
  if (!a) return { ok: false, status: 404, reason: 'NOT_FOUND', message: 'No such account.' };
  if (actor && a.account_id === actor.account_id) return { ok: false, status: 400, reason: 'SELF', message: 'You cannot disable your own login.' };
  if (status === 'DISABLED' && a.role === 'SUPER_ADMIN' && (await accounts.countByRole('SUPER_ADMIN')) <= 1) {
    return { ok: false, status: 400, reason: 'LAST_ADMIN', message: 'This is the only administrator.' };
  }
  const updated = await accounts.update(a.account_id, { status, token_version: (a.token_version || 0) + 1,
    failed_attempts: 0, locked_until: null });
  return { ok: true, account: publicView(updated) };
}

async function listAccounts({ q, state } = {}) {
  const all = await getAccounts().list();
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const st = state ? String(state).toLowerCase() : null;
  return all.map(a => Object.assign(publicView(a), { hospital: hospitalFor(a) })).filter(a => {
    if (st && !(a.hospital && String(a.hospital.state || '').toLowerCase() === st)) return false;
    if (!terms.length) return true;
    const hay = (a.username + ' ' + (a.hospital ? a.hospital.name + ' ' + a.hospital.district + ' ' + a.hospital.state : '') + ' ' + a.role).toLowerCase();
    return terms.every(t => hay.indexOf(t) !== -1);
  });
}

/* ── First run ───────────────────────────────────────────────────────────── */

/**
 * Makes sure someone can sign in.
 * * SUPER_ADMIN_USERNAME / SUPER_ADMIN_PASSWORD create the administrator on a
 *   database that has none (the password must pass the same rules; it is
 *   flagged for change at first sign-in).
 * * Outside production, an empty store also gets demo logins for two
 *   Bengaluru hospitals, with random passwords printed once in the log —
 *   unless DEMO_SEED=false. DEMO_PASSWORD fixes them for a rehearsed demo.
 */
async function bootstrap(log) {
  const logger = log || console;
  const accounts = getAccounts();
  const prod = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const printed = [];

  if ((await accounts.countByRole('SUPER_ADMIN')) === 0) {
    const envUser = normaliseUsername(process.env.SUPER_ADMIN_USERNAME || '');
    const envPass = process.env.SUPER_ADMIN_PASSWORD || '';
    if (envUser && envPass) {
      const problem = passwordProblem(envPass, envUser);
      if (problem) logger.error('❌ SUPER_ADMIN_PASSWORD rejected: ' + problem + ' No administrator was created.');
      else {
        await accounts.create({ username: envUser, password_hash: await hashPassword(envPass), role: 'SUPER_ADMIN', must_change_password: true, created_by: 'bootstrap' });
        logger.log('👤 administrator "' + envUser + '" created from SUPER_ADMIN_USERNAME — change the password at first sign-in.');
      }
    } else if (!prod && String(process.env.DEMO_SEED || 'true').toLowerCase() !== 'false') {
      const pw = process.env.DEMO_PASSWORD || generatePassword();
      await accounts.create({ username: 'admin', password_hash: await hashPassword(pw), role: 'SUPER_ADMIN', must_change_password: false, created_by: 'demo-seed' });
      printed.push(['admin', pw, 'GoldenHour administrator']);
    } else {
      logger.warn('⚠️  No administrator exists. Set SUPER_ADMIN_USERNAME and SUPER_ADMIN_PASSWORD and restart to create one.');
    }
  }

  if (!prod && String(process.env.DEMO_SEED || 'true').toLowerCase() !== 'false' && (await accounts.countByRole('HOSPITAL_STAFF')) === 0) {
    for (const [username, id] of demoHospitals()) {
      if (!directory.get(id)) continue;
      const pw = process.env.DEMO_PASSWORD || generatePassword();
      await accounts.create({ username, password_hash: await hashPassword(pw), role: 'HOSPITAL_STAFF', hospital_id: id, must_change_password: false, created_by: 'demo-seed' });
      printed.push([username, pw, directory.get(id).name]);
    }
  }

  if (printed.length) {
    logger.log('');
    logger.log('  Demo sign-ins (shown once — set DEMO_PASSWORD to fix them, DEMO_SEED=false to skip):');
    for (const [u, p, what] of printed) logger.log('    ' + u.padEnd(22) + p.padEnd(20) + what);
    logger.log('');
  }
}

/* Two Bengaluru hospitals with directory-listed coordinates, so distances in
   the demo are measured rather than pincode estimates. Override with
   DEMO_HOSPITAL_IDS=12179,12815 (directory ids). */
function demoHospitals() {
  const ids = String(process.env.DEMO_HOSPITAL_IDS || '').split(',').map(s => Number(s.trim())).filter(Boolean);
  const chosen = ids.length ? ids : [12179, 12815];
  return chosen.map((id, i) => {
    const h = directory.get(id);
    return [h ? suggestUsername(h) : 'er.demo' + (i + 1), id];
  });
}

module.exports = {
  login, verify, bearer, issueToken, changePassword, signOutEverywhere,
  createHospitalAccount, resetPassword, setStatus, listAccounts, bootstrap,
  hashPassword, generatePassword, passwordProblem, suggestUsername, hospitalFor, secret,
  ROLES, MIN_PASSWORD, MAX_FAILED, LOCK_MINUTES,
};
