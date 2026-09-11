/* ============================================================================
   Authentication routes.

   `register` runs behind an OPTIONAL token: the controller needs to know who
   the caller is when there is one (only an ADMIN may create accounts) but must
   still be reachable with no token at all for the first-run bootstrap, when
   there is no administrator to authorise anything yet.
   ========================================================================== */
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

const { login, register } = require('../controllers/authController');
const { createRateLimiter } = require('../middleware/protect');

/* Tight, unlike the crew endpoints: nobody legitimately signs in twenty times
   a minute, and this is the one endpoint worth brute-forcing. */
const loginLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 20, name: 'sign-in attempts' });
const registerLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 10, name: 'account creations' });

function optionalToken(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (!err) req.user = user;
    next();
  });
}

router.post('/login', loginLimiter, login);
router.post('/register', registerLimiter, optionalToken, register);

module.exports = router;
