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
const { initStore, getStore } = require('./store');
const socketHandler = require('./sockets/socketHandler');
const { startExpiryLoop } = require('./services/broadcastService');
const { securityHeaders, notFound, errorHandler } = require('./middleware/protect');

const requestRoutes = require('./routes/requestRoutes');
const hospitalDeskRoutes = require('./routes/hospitalDeskRoutes');

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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Request-Id', 'X-Hospital-Id'],
  maxAge: 600,
};

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
  /* Four compressed photos plus the case body. Anything larger is not a case. */
  maxHttpBufferSize: 12e6,
});

/* Railway (and any proxy) terminates TLS, so req.ip must come from the
   forwarded header or every client looks like the proxy — which would make
   rate limiting throttle everybody at once. */
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(securityHeaders);
app.use(cors(corsOptions));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.set('io', io);

/* ── Static front-ends ─────────────────────────────────────────────────── */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const APP_DIR = path.join(__dirname, '..', '..', 'app', 'www');

app.use('/hospital', express.static(path.join(PUBLIC_DIR, 'hospital')));
app.use('/ambulance', express.static(APP_DIR));
app.use('/', express.static(path.join(PUBLIC_DIR, 'landing')));
/* One vendored socket.io client, served to both front-ends. */
app.use('/vendor', express.static(path.join(APP_DIR, 'vendor')));

/* ── API ───────────────────────────────────────────────────────────────── */
/* Sign-in is deliberately NOT mounted.
   There is no login screen in either front-end and the demo does not need
   one: desks identify by ?hospital=<id> under DESK_AUTH=ip, and under
   DESK_AUTH=jwt the token is verified here but issued elsewhere. The handlers
   still exist, hardened, in routes/authRoutes.js and
   controllers/authController.js — mounting them again is this one line:

       app.use('/api/v1/auth', require('./routes/authRoutes'));

   Leaving an unused public endpoint that mints ER-desk tokens exposed is not
   worth it until something actually calls it. */
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

  const body = {
    success: storeHealthy,
    message: 'GoldenHour backend',
    env: security.envName(),
    store,
    store_healthy: storeHealthy,
    desk_auth: security.deskAuthMode(),
    hackathon_mode: hospitalsConfig.HACKATHON_MODE,
    uptime_seconds: Math.round(process.uptime()),
  };
  if (hospitalsConfig.HACKATHON_MODE) {
    body.laptops = hospitalsConfig.HOSPITAL_LAPTOPS.map(h => ({ id: h.hospital_id, name: h.name, ip: h.ip }));
  }
  res.status(storeHealthy ? 200 : 503).json(body);
});

app.use('/api', notFound);
app.use(errorHandler);

socketHandler(io);

const PORT = Number(process.env.PORT) || 5000;

(async () => {
  try {
    await initStore();
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
