/* ============================================================================
   Production entry point (Elastic Beanstalk runs `npm start`).

   Reads the secrets from AWS Secrets Manager into the environment first
   (config/awsSecrets.js), then starts the server exactly as
   `node src/server.js` would. Without GH_*_SECRET_ARN it is the same as
   running server.js directly.
   ========================================================================== */
'use strict';
const secrets = require('./config/awsSecrets');

secrets.loadIntoEnv(console).then(() => {
  require('./server');
  const { getPool } = require('./store');
  /* The pool exists once the store has connected; check shortly after boot. */
  const t = setInterval(() => {
    const pool = getPool();
    if (pool) { clearInterval(t); secrets.watchDbSecret(pool, console); }
  }, 2000);
  setTimeout(() => clearInterval(t), 120000).unref();
}, err => {
  console.error('❌ could not read secrets from AWS Secrets Manager: ' + err.message);
  process.exit(1);
});
