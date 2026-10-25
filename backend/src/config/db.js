/* ============================================================================
   MySQL connection pool.

   Reads, in order of precedence:
     1. A connection URL: DATABASE_URL, MYSQL_URL or MYSQL_PUBLIC_URL
        (mysql://user:pass@host:port/db) — what Railway's MySQL plugin injects
     2. Railway's split variables: MYSQLHOST, MYSQLPORT, MYSQLUSER,
        MYSQLPASSWORD, MYSQLDATABASE
     3. GoldenHour's own: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME

   DB_PORT used to be documented and then ignored, so a managed database on
   any port but 3306 failed to connect and the server quietly fell back to
   the in-memory store. Every source above now honours its port.
   ========================================================================== */
'use strict';
const mysql = require('mysql2/promise');

function fromUrl(raw) {
  try {
    const u = new URL(raw);
    if (!/^mysql2?:$/.test(u.protocol)) return null;
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'goldenhour',
    };
  } catch (_) { return null; }
}

function connectionSettings(env) {
  const e = env || process.env;
  const url = e.DATABASE_URL || e.MYSQL_URL || e.MYSQL_PUBLIC_URL;
  const parsed = url ? fromUrl(url) : null;
  if (parsed) return Object.assign(parsed, { source: 'url' });
  if (e.MYSQLHOST) {
    return {
      host: e.MYSQLHOST, port: Number(e.MYSQLPORT) || 3306,
      user: e.MYSQLUSER || 'root', password: e.MYSQLPASSWORD || '',
      database: e.MYSQLDATABASE || 'railway', source: 'railway',
    };
  }
  return {
    host: e.DB_HOST || 'localhost', port: Number(e.DB_PORT) || 3306,
    user: e.DB_USER || 'root', password: e.DB_PASSWORD || '',
    database: e.DB_NAME || 'goldenhour', source: 'db_vars',
  };
}

const settings = connectionSettings();
const pool = mysql.createPool({
  host: settings.host,
  port: settings.port,
  user: settings.user,
  password: settings.password,
  database: settings.database,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
  ssl: String(process.env.DB_SSL || '').toLowerCase() === 'true' ? { rejectUnauthorized: true } : undefined,
  dateStrings: false,
});
pool.settings = { host: settings.host, port: settings.port, database: settings.database, source: settings.source };

module.exports = pool;
module.exports.connectionSettings = connectionSettings;
