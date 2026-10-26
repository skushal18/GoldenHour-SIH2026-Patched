/* ============================================================================
   Secrets from AWS Secrets Manager, read at startup with the instance role.

   On AWS no secret is written into the environment, the code, the template
   or a log. The Elastic Beanstalk environment holds only two secret ARNs:

     GH_DB_SECRET_ARN   the RDS-managed master secret  {"username","password"}
                        → DB_USER, DB_PASSWORD
     GH_APP_SECRET_ARN  GoldenHour's own secret
                        {"JWT_SECRET","SUPER_ADMIN_USERNAME","SUPER_ADMIN_PASSWORD"}
                        → the same names

   A value already in the environment wins, so local runs and tests never
   touch AWS. With neither ARN set this does nothing.

   RDS rotates its managed secret (every 7 days by default). Connections that
   are open keep working; new ones need the new password. watchDbSecret
   re-reads the secret every few minutes and hands a changed password to the
   pool, so a rotation costs at most one refresh interval of failed
   reconnects, not an outage until the next deploy.
   ========================================================================== */
'use strict';

const APP_KEYS = ['JWT_SECRET', 'SUPER_ADMIN_USERNAME', 'SUPER_ADMIN_PASSWORD'];
const REFRESH_MS = Number(process.env.DB_SECRET_REFRESH_MS) || 5 * 60_000;

let client = null;
function sm() {
  if (!client) {
    const { SecretsManagerClient } = require('@aws-sdk/client-secrets-manager');
    client = new SecretsManagerClient({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-southeast-2' });
  }
  return client;
}

async function readJson(arn) {
  const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const out = await sm().send(new GetSecretValueCommand({ SecretId: arn }));
  return JSON.parse(out.SecretString || '{}');
}

/** Fills process.env from the secrets named by GH_*_SECRET_ARN. Never logs a value. */
async function loadIntoEnv(logger) {
  const log = logger || console;
  const loaded = [];
  const dbArn = process.env.GH_DB_SECRET_ARN;
  const appArn = process.env.GH_APP_SECRET_ARN;
  if (dbArn) {
    const s = await readJson(dbArn);
    if (!process.env.DB_USER && s.username) { process.env.DB_USER = s.username; loaded.push('DB_USER'); }
    if (!process.env.DB_PASSWORD && s.password) { process.env.DB_PASSWORD = s.password; loaded.push('DB_PASSWORD'); }
  }
  if (appArn) {
    const s = await readJson(appArn);
    for (const k of APP_KEYS) if (!process.env[k] && s[k]) { process.env[k] = String(s[k]); loaded.push(k); }
  }
  if (loaded.length) log.log('🔐 Secrets Manager: ' + loaded.join(', '));
  return loaded;
}

/** Keeps the pool's password current across RDS secret rotation. */
function watchDbSecret(pool, logger) {
  const log = logger || console;
  const arn = process.env.GH_DB_SECRET_ARN;
  if (!arn || !pool || typeof pool.setPassword !== 'function') return null;
  const timer = setInterval(async () => {
    try {
      const s = await readJson(arn);
      if (s.password && s.password !== process.env.DB_PASSWORD) {
        process.env.DB_PASSWORD = s.password;
        pool.setPassword(s.password);
        log.log('🔐 database password rotated — new connections use the new one');
      }
    } catch (err) {
      log.warn('⚠️  could not re-read the database secret: ' + err.message);
    }
  }, REFRESH_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { loadIntoEnv, watchDbSecret };
