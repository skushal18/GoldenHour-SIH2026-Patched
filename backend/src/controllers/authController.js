/* ============================================================================
   Desk and crew authentication.

   This is what DESK_AUTH=jwt rests on, so the rules are stricter than the
   convenience version this replaces:

   * Registration is not public. The previous handler let any unauthenticated
     caller POST a role of their choosing — including ADMIN, and including
     HOSPITAL_STAFF for a hospital they had nothing to do with. That is not a
     weak password policy, it is an authentication bypass: it hands out exactly
     the token that protects the ER desk endpoints.

   * The one exception is bootstrap. A fresh database has no administrator, so
     the very first account may be created without a token — and only while the
     users table is genuinely empty.

   * Roles come from an allowlist, and a role that owns a hospital must name
     one that exists.
   ========================================================================== */
'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const ROLES = ['ADMIN', 'HOSPITAL_STAFF', 'AMBULANCE_CREW'];
const HOSPITAL_ROLES = ['HOSPITAL_STAFF'];
const MIN_PASSWORD = 12;
const TOKEN_TTL = process.env.JWT_TTL || '12h';
const BCRYPT_ROUNDS = 12;

function fail(res, status, message, extra) {
  return res.status(status).json(Object.assign({ success: false, message }, extra || {}));
}

/* ── Login ───────────────────────────────────────────────────────────────── */

const login = async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return fail(res, 400, 'Email and password are required');

  try {
    const [rows] = await pool.query(
      'SELECT user_id, name, email, password_hash, role, hospital_id, ambulance_id FROM users WHERE email = ? LIMIT 1',
      [String(email).trim().toLowerCase()]
    );

    /* One message and one timing profile for "no such user" and "wrong
       password". Distinguishing them turns the login form into a way to
       enumerate which addresses are registered. */
    const user = rows[0];
    const hash = user ? user.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';
    const ok = await bcrypt.compare(String(password), hash);
    if (!user || !ok) return fail(res, 401, 'Invalid credentials');

    const token = jwt.sign(
      {
        user_id: user.user_id,
        email: user.email,
        role: user.role,
        hospital_id: user.hospital_id,
        ambulance_id: user.ambulance_id,
      },
      process.env.JWT_SECRET,
      { expiresIn: TOKEN_TTL }
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        expires_in: TOKEN_TTL,
        user: { user_id: user.user_id, name: user.name, email: user.email, role: user.role, hospital_id: user.hospital_id },
      },
    });
  } catch (err) {
    console.error('login failed:', err);
    fail(res, 500, 'Could not sign you in');
  }
};

/* ── Register ────────────────────────────────────────────────────────────── */

const register = async (req, res) => {
  const { name, email, password, role, hospital_id, ambulance_id } = req.body || {};

  if (!name || !email || !password) return fail(res, 400, 'name, email and password are required');
  if (String(password).length < MIN_PASSWORD) {
    return fail(res, 400, 'Password must be at least ' + MIN_PASSWORD + ' characters');
  }
  if (!ROLES.includes(String(role))) {
    return fail(res, 400, 'role must be one of: ' + ROLES.join(', '));
  }
  if (HOSPITAL_ROLES.includes(String(role)) && !hospital_id) {
    return fail(res, 400, 'hospital_id is required for ' + role);
  }

  try {
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM users');
    const bootstrapping = total === 0;
    const actor = req.user || null;

    /* Anyone may create the very first account, because there is nobody to
       authorise it yet. After that, only an administrator. */
    if (!bootstrapping && (!actor || actor.role !== 'ADMIN')) {
      return fail(res, 403, 'Only an administrator can create accounts');
    }
    if (bootstrapping && String(role) !== 'ADMIN') {
      return fail(res, 400, 'The first account must be an ADMIN');
    }

    if (hospital_id) {
      const [h] = await pool.query('SELECT hospital_id FROM hospitals WHERE hospital_id = ?', [hospital_id]);
      if (!h.length) return fail(res, 400, 'No such hospital');
    }

    const normalised = String(email).trim().toLowerCase();
    const [existing] = await pool.query('SELECT user_id FROM users WHERE email = ?', [normalised]);
    if (existing.length) return fail(res, 409, 'That email is already registered');

    const password_hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const [result] = await pool.query(
      'INSERT INTO users (name, email, password_hash, role, hospital_id, ambulance_id) VALUES (?, ?, ?, ?, ?, ?)',
      [String(name).trim(), normalised, password_hash, String(role), hospital_id || null, ambulance_id || null]
    );

    console.log('👤 account created: ' + normalised + ' (' + role + ')' + (bootstrapping ? ' — bootstrap' : ' by ' + actor.email));
    res.status(201).json({
      success: true,
      message: 'Account created',
      data: { user_id: result.insertId, name, email: normalised, role },
    });
  } catch (err) {
    console.error('register failed:', err);
    fail(res, 500, 'Could not create the account');
  }
};

module.exports = { login, register, ROLES, MIN_PASSWORD };
