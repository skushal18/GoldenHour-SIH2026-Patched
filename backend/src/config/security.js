/* ============================================================================
   Security configuration, validated once at boot.

   The design rule here: an unsafe *production* server must refuse to start,
   loudly, at boot — not fail open and serve patient data to anybody who asks.
   A misconfiguration that only shows up as a security hole under load is
   worth far less than a process that dies in the deploy log with a sentence
   explaining what to set.

   Development and the hackathon demo keep their conveniences. What changes is
   that those conveniences are now impossible to ship by accident.
   ========================================================================== */
'use strict';

/* Values that ship in .env.example or in the repo's history, and therefore
   are public knowledge. None of them may be a production secret. */
const KNOWN_WEAK_SECRETS = [
  'goldenhour_2026', 'goldenhour', 'secret', 'changeme', 'change_me',
  'jwt_secret', 'dev', 'development', 'test', 'admin123', 'password',
];

const MIN_SECRET_LENGTH = 32;

function envName() {
  return String(process.env.NODE_ENV || 'development').toLowerCase();
}

function isProduction() {
  return envName() === 'production';
}

function deskAuthMode() {
  const explicit = String(process.env.DESK_AUTH || '').toLowerCase();
  if (explicit) return explicit;
  /* Unset means "whatever is safe here": IP/override identity for the LAN
     demo, real tokens in production. */
  return isProduction() ? 'jwt' : 'ip';
}

function corsOrigins() {
  const raw = String(process.env.CORS_ORIGIN || '').trim();
  if (!raw) return null;                       // null = not configured
  if (raw === '*') return '*';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function jwtSecret() {
  return String(process.env.JWT_SECRET || '');
}

function weakSecret(secret) {
  if (!secret) return 'JWT_SECRET is not set';
  if (KNOWN_WEAK_SECRETS.indexOf(secret.toLowerCase()) !== -1) {
    return 'JWT_SECRET is a value published in this repository';
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return 'JWT_SECRET is only ' + secret.length + ' characters; use at least ' + MIN_SECRET_LENGTH;
  }
  return null;
}

function storeDriver() {
  if (process.argv.indexOf('--memory') !== -1) return 'memory';
  return String(process.env.DB_DRIVER || 'auto').toLowerCase();
}

/**
 * Everything wrong with this configuration, as sentences a person can act on.
 * Production problems are fatal; the same problems in development are notes.
 */
function audit() {
  const fatal = [];
  const warnings = [];
  const prod = isProduction();
  const mode = deskAuthMode();
  const origins = corsOrigins();
  const driver = storeDriver();

  /* ── Desk identity ─────────────────────────────────────────────────── */
  if (mode !== 'jwt') {
    const message =
      'DESK_AUTH=' + mode + ' lets any client claim to be any hospital by ' +
      'passing ?hospital=<id>. That is a demo mechanism, not authentication.';
    if (prod) fatal.push(message + ' Set DESK_AUTH=jwt.');
    else warnings.push(message);
  }

  /* ── JWT secret ────────────────────────────────────────────────────── */
  const secretProblem = weakSecret(jwtSecret());
  if (secretProblem) {
    /* Fatal in production only. Outside it, no real desk token protects
       anything, and refusing to boot would mean a test suite could not
       exercise the JWT path at all. NODE_ENV=production is the declaration
       that this instance matters, and that is where the gate belongs. */
    if (prod) {
      fatal.push(secretProblem + '. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
    } else if (mode === 'jwt') {
      warnings.push(secretProblem + '. Acceptable here, never in a deployment — set NODE_ENV=production and this becomes a refusal to start.');
    }
  }

  /* ── CORS ──────────────────────────────────────────────────────────── */
  if (origins === null) {
    const message = 'CORS_ORIGIN is not set, so every origin on the internet may call this API.';
    if (prod) fatal.push(message + ' Set it to the exact origins that should be allowed.');
    else warnings.push(message);
  } else if (origins === '*') {
    const message = 'CORS_ORIGIN=* allows every origin.';
    if (prod) fatal.push(message + ' Name the origins explicitly instead.');
    else warnings.push(message);
  }

  /* ── Persistence ───────────────────────────────────────────────────── */
  if (prod && driver !== 'mysql') {
    fatal.push(
      'DB_DRIVER=' + driver + ' in production. "auto" falls back to an in-memory store when ' +
      'MySQL is unreachable, which silently loses every case on restart. Set DB_DRIVER=mysql ' +
      'so an unreachable database is a failed deploy rather than invisible data loss.');
  }

  /* ── Demo fan-out ──────────────────────────────────────────────────── */
  if (prod && String(process.env.HACKATHON_MODE || 'true').toLowerCase() !== 'false') {
    fatal.push('HACKATHON_MODE is on in production: every broadcast is sent to the two hardcoded demo hospitals instead of the real ones. Set HACKATHON_MODE=false.');
  }

  if (prod && String(process.env.ALLOW_MANUAL_HOSPITAL_OVERRIDE || 'true').toLowerCase() !== 'false') {
    warnings.push('ALLOW_MANUAL_HOSPITAL_OVERRIDE is on. With DESK_AUTH=jwt it is ignored, but set it to false so a future change to DESK_AUTH cannot re-open ?hospital=<id>.');
  }

  return { fatal, warnings, env: envName(), deskAuth: mode, driver, cors: origins };
}

/** Print the audit and, in production, refuse to continue if anything is fatal. */
function enforce(logger) {
  const log = logger || console;
  const result = audit();

  result.warnings.forEach(w => log.warn('⚠️  ' + w));

  if (result.fatal.length) {
    log.error('');
    log.error('❌ GoldenHour refuses to start with this configuration:');
    result.fatal.forEach((f, i) => log.error('   ' + (i + 1) + '. ' + f));
    log.error('');
    log.error('   These are fatal because NODE_ENV=production. To run the demo');
    log.error('   configuration deliberately, leave NODE_ENV unset.');
    log.error('');
    const err = new Error('Unsafe production configuration');
    err.fatalConfig = result.fatal;
    throw err;
  }
  return result;
}

module.exports = {
  isProduction, envName, deskAuthMode, corsOrigins, jwtSecret,
  storeDriver, weakSecret, audit, enforce,
  KNOWN_WEAK_SECRETS, MIN_SECRET_LENGTH,
};
