/* ============================================================================
   GoldenHour backend.

   Serves three things from one process: the JSON API, the Socket.IO realtime
   channel, and the two static front-ends. That is deliberate — it means a
   clean clone plus `npm start` gives a judge, or a crew, a working system with
   no reverse proxy to configure and no CORS to get wrong on the LAN.
   ========================================================================== */
'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const security = require('./config/security');
const hospitalsConfig = require('./config/hospitals');
const { initStore, getStore, getPool } = require('./store');
const directory = require('./services/directoryService');
const authService = require('./services/authService');
const capacity = require('./services/capacityService');
const audit = require('./services/auditService');
const socketHandler = require('./sockets/socketHandler');
const { startExpiryLoop } = require('./services/broadcastService');
const { securityHeaders, notFound, errorHandler } = require('./middleware/protect');

const requestRoutes = require('./routes/requestRoutes');
const hospitalDeskRoutes = require('./routes/hospitalDeskRoutes');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');

/* Refuses to continue on an unsafe production configuration. Everything below
   can then assume the environment is sane. A stack trace would only bury the
   explanation the operator needs, so this exits on the message alone. */
let configReport;
try {
  configReport = security.enforce(console);
} catch (err) {
  if (err && err.fatalConfig) process.exit(78);   // EX_CONFIG
  throw err;
}

const app = express();
const server = http.createServer(app);

/* ── CORS ──────────────────────────────────────────────────────────────────
   Where CORS_ORIGIN names origins, only those may call the API. Where it does
   not — the LAN demo — anything may, and security.enforce() has already made
   that impossible in production. */
const configured = security.corsOrigins();
const corsOrigin = (configured === null || configured === '*') ? true : configured;
const corsOptions = {
  origin: corsOrigin,
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  /* X-Crew-Token: the APK runs on https://localhost, so reading a case's
     status with its crew token is a cross-origin request that the browser
     preflights — without it here, every status poll from the APK fails. */
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Request-Id', 'X-Hospital-Id', 'X-Crew-Token'],
  maxAge: 600,
};

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
  /* Four compressed photos plus the case body. Anything larger is not a case. */
  maxHttpBufferSize: 12e6,
});

/* A proxy terminates TLS, so req.ip must come from the forwarded header or
   every client looks like the proxy — which would make rate limiting throttle
   everybody at once. TRUST_PROXY is the number of proxies in front of this
   process: 1 behind CloudFront alone, 2 behind CloudFront + the Elastic
   Beanstalk nginx. Too high lets a client forge its address; too low makes
   everyone share one. */
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.disable('x-powered-by');

app.use(securityHeaders);
app.use(cors(corsOptions));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.set('io', io);

/* ── Static front-ends ─────────────────────────────────────────────────── */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const APP_DIR = path.join(__dirname, '..', '..', 'app', 'www');

/* /hospital is the ER desk and /admin the administrator console: the same
   single-page app, which shows whichever screen the signed-in account may
   use. Neither shows anything before sign-in. */
app.use('/hospital', express.static(path.join(PUBLIC_DIR, 'hospital')));
app.use('/admin', express.static(path.join(PUBLIC_DIR, 'hospital')));
app.use('/ambulance', express.static(APP_DIR));
app.use('/', express.static(path.join(PUBLIC_DIR, 'landing')));
/* Vendored client libraries: socket.io (shared with the ambulance app) and Leaflet. */
app.use('/vendor', express.static(path.join(APP_DIR, 'vendor')));
app.use('/vendor', express.static(path.join(PUBLIC_DIR, 'vendor')));

/* ── Activity ──────────────────────────────────────────────────────────────
   When the last real request arrived — any API call or new realtime
   connection, not /health. On AWS a scheduled job reads it from /health and
   puts the stack to sleep after IDLE_STOP_MINUTES without any (see
   infra/goldenhour.yaml, IdleSleeper). An open ER desk polls every 10 s, so
   it keeps the stack awake, which is what a desk waiting for ambulances needs. */
let lastActivity = Date.now();
function touch() { lastActivity = Date.now(); }
app.use('/api', (req, res, next) => { touch(); next(); });
io.on('connection', touch);

/* ── API ───────────────────────────────────────────────────────────────── */
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/desk', hospitalDeskRoutes);
app.use('/api/v1', requestRoutes);

/* ── Health ────────────────────────────────────────────────────────────────
   Reports what an operator actually needs to decide whether this deploy is
   serving real traffic correctly: which store is live, how desks are being
   identified, and whether the demo fan-out is still on. It deliberately does
   not report secrets, and it reports the hospital list only while the demo
   mode that hardcodes it is enabled. */
app.get('/health', async (req, res) => {
  let store = 'pending';
  let storeHealthy = false;
  try {
    const active = getStore();
    store = active.driver;
    storeHealthy = typeof active.ping === 'function' ? await active.ping() : true;
  } catch (_) { /* not initialised yet */ }
  const pool = getPool();

  const body = {
    success: storeHealthy,
    message: 'GoldenHour backend',
    version: require('../package.json').version,
    env: security.envName(),
    store,
    store_healthy: storeHealthy,
    database: pool && pool.settings ? { host: pool.settings.host, name: pool.settings.database } : null,
    desk_auth: security.deskAuthMode(),
    hackathon_mode: hospitalsConfig.HACKATHON_MODE,
    directory_hospitals: directory.count(),
    directory_source: directory.summary().source,
    uptime_seconds: Math.round(process.uptime()),
    last_activity_at: new Date(lastActivity).toISOString(),
    idle_seconds: Math.round((Date.now() - lastActivity) / 1000),
  };
  if (hospitalsConfig.HACKATHON_MODE && security.deskAuthMode() === 'ip') {
    body.laptops = hospitalsConfig.HOSPITAL_LAPTOPS.map(h => ({ id: h.hospital_id, name: h.name, ip: h.ip }));
  }
  res.status(storeHealthy ? 200 : 503).json(body);
});

app.use('/api', notFound);
app.use(errorHandler);

socketHandler(io);

const PORT = Number(process.env.PORT) || 5000;

/* The database may be starting (on AWS it is stopped while the stack sleeps
   and started by the first request). DB_WAIT_SECONDS: keep retrying the first
   connection this long instead of exiting — exiting would make systemd
   restart the process in a tight loop until it gives up for good. Unset (the
   default) an unreachable database is an immediate, loud failure. */
async function initStoreWhenReachable() {
  const until = Date.now() + (Number(process.env.DB_WAIT_SECONDS) || 0) * 1000;
  for (;;) {
    try { return await initStore(); }
    catch (err) {
      if (Date.now() + 10000 > until) throw err;
      console.warn('⏳ database not reachable yet (' + err.message + ') — retrying in 10 s');
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

(async () => {
  try {
    await initStoreWhenReachable();
    const pool = getPool();
    if (pool) {
      if (String(process.env.HOSPITAL_SEED_ON_BOOT || '').toLowerCase() === 'true') {
        const seeded = await directory.seedNetwork(pool);
        if (seeded.inserted) console.log('🏥 Seeded ' + seeded.inserted + ' network hospitals into MySQL');
      }
      const n = await directory.attach(pool);
      console.log('🏥 Hospital directory: ' + n + ' hospitals (MySQL hospitals table)');
      if (!n) console.warn('⚠️  The hospitals table is empty — no ambulance can be matched. Run: npm --prefix backend run seed:hospitals');
    } else {
      console.log('🏥 Hospital directory: ' + directory.useMemory() + ' hospitals (data/hospitals/network_hospitals.csv, in memory)');
    }
    if (pool) {
      const caps = await capacity.attachPersistence(pool);
      const evts = await audit.attachPersistence(pool);
      console.log('🗃️  Restored ' + caps + ' capacity records and ' + evts + ' case events');
    }
    await authService.bootstrap(console);
    startExpiryLoop(io, 10000);
    server.listen(PORT, '0.0.0.0', () => {
      console.log('🚑 GoldenHour listening on :' + PORT +
        '  [env ' + configReport.env + ' · store ' + configReport.driver +
        ' · desk auth ' + configReport.deskAuth + ']');
    });
  } catch (err) {
    console.error('❌ server failed to start:', err.message);
    process.exit(1);
  }
})();

/* A container that is being replaced should finish what it is holding. An
   ambulance mid-POST during a deploy should not get a connection reset. */
function shutdown(signal) {
  console.log(signal + ' received — closing.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, io };
