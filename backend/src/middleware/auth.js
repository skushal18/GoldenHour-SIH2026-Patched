/* ============================================================================
   requireAuth(roles, options) — the only way into a signed-in endpoint.

   Verifies the bearer token and the account behind it (see authService.verify)
   on every request, puts the account on req.account, and refuses an account
   that still has to change its temporary password unless the route opts in
   with { allowPasswordChange: true } (the change-password route itself).
   ========================================================================== */
'use strict';
const auth = require('../services/authService');

function requireAuth(roles, options) {
  const allowed = roles && roles.length ? roles : null;
  const opts = options || {};
  return async function (req, res, next) {
    try {
      const result = await auth.verify(auth.bearer(req));
      if (!result.ok) return res.status(result.status).json({ success: false, reason: result.reason, message: result.message });
      const account = result.account;
      if (allowed && allowed.indexOf(account.role) === -1) {
        return res.status(403).json({ success: false, reason: 'FORBIDDEN', message: 'This login cannot open that page.' });
      }
      if (account.must_change_password && !opts.allowPasswordChange) {
        return res.status(403).json({ success: false, reason: 'PASSWORD_CHANGE_REQUIRED', message: 'Set a new password before continuing.' });
      }
      req.account = account;
      next();
    } catch (err) { next(err); }
  };
}

module.exports = { requireAuth };
