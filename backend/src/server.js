/* ============================================================================
   GoldenHour master server.

   One process serves all three things, so the hackathon needs exactly one
   machine running exactly one command:

     /              a landing page with the LAN links to hand out
     /hospital      the hospital laptop dashboard  ← open this on both laptops
     /ambulance     the ambulance web app          ← same code as the APK
     /api/v1/...    the API

   Start:  npm start        (from the repo root, or from backend/)
   ========================================================================== */

'use strict';

const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const hospitalsConfig = require('./config/hospitals');
const { initStore } = require('./store');
const socketHandler = require('./sockets/socketHandler');
const { startExpiryLoop } = require('./services/broadcastService');

const authRoutes = require('./routes/authRoutes');
const caseRoutes = require('./routes/caseRoutes');
const hospitalRoutes = require('./routes/hospitalRoutes');
const requestRoutes = require('./routes/requestRoutes');
const hospitalDeskRoutes = require('./routes/hospitalDeskRoutes');

const app = express();
const server = http.createServer(app);

/* '*' is the right answer on a closed LAN and the wrong one anywhere else.
   Set CORS_ORIGIN to a comma-separated list before this leaves the network. */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const corsOrigin = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*';

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST', 'PUT'] },
  maxHttpBufferSize: 12e6            // photos ride along as data-URLs
});

/* ── Middleware ──────────────────────────────────────────────────────────── */
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '12mb' }));       // up to 4 compressed JPEGs
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.set('io', io);
app.set('trust proxy', true);

/* ── Static front-ends ───────────────────────────────────────────────────── */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const APP_DIR = path.join(__dirname, '..', '..', 'app', 'www');

app.use('/hospital', express.static(path.join(PUBLIC_DIR, 'hospital')));
app.use('/ambulance', express.static(APP_DIR));
app.use('/', express.static(path.join(PUBLIC_DIR, 'landing')));

/* The Socket.IO browser client is vendored into the repo (app/www/vendor) so
   the APK works offline and the demo network never needs the internet. Both
   front-ends load it from the same file. */
app.use('/vendor', express.static(path.join(APP_DIR, 'vendor')));

/* ── API ─────────────────────────────────────────────────────────────────── */
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/cases', caseRoutes);
app.use('/api/v1/hospitals', hospitalRoutes);
app.use('/api/v1/desk', hospitalDeskRoutes);
app.use('/api/v1', requestRoutes);

app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'GoldenHour backend running',
    hackathon_mode: hospitalsConfig.HACKATHON_MODE,
    laptops: hospitalsConfig.HOSPITAL_LAPTOPS.map(h => ({ id: h.hospital_id, name: h.name, ip: h.ip }))
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

socketHandler(io);

/* ── Boot ────────────────────────────────────────────────────────────────── */
const PORT = Number(process.env.PORT) || 5000;

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function banner() {
  const ips = lanAddresses();
  const host = ips[0] || 'localhost';
  const base = `http://${host}:${PORT}`;
  const line = '─'.repeat(66);

  console.log('');
  console.log(line);
  console.log('  🚑  GoldenHour  ·  master server');
  console.log(line);
  console.log(`  Listening on            :  0.0.0.0:${PORT}`);
  if (ips.length) console.log(`  This machine on the LAN :  ${ips.join(', ')}`);
  console.log('');
  console.log('  Open on the HOSPITAL laptops :  ' + base + '/hospital');
  console.log('  Open on the AMBULANCE device :  ' + base + '/ambulance');
  console.log('  Landing page with all links  :  ' + base + '/');
  console.log('');
  console.log(`  Hackathon mode          :  ${hospitalsConfig.HACKATHON_MODE ? 'ON — every broadcast alerts BOTH laptops' : 'off — radius filtering is live'}`);
  console.log(`  ER desk auth            :  ${require('./middleware/hospitalIdentity').deskAuthMode() === 'jwt' ? 'JWT (production)' : 'by laptop IP — LAN only, no login'}`);
  console.log(`  CORS                    :  ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : 'any origin (*)'}`);
  hospitalsConfig.HOSPITAL_LAPTOPS.forEach(h => {
    console.log(`    #${h.hospital_id}  ${h.ip.padEnd(15)}  ${h.name}`);
  });
  console.log('');
  console.log('  Laptop IP not matching? Open  ' + base + '/hospital?hospital=1  (or 2)');
  console.log(line);
  console.log('');
}

(async () => {
  try {
    await initStore();
    startExpiryLoop(io, 10000);
    server.listen(PORT, '0.0.0.0', banner);
  } catch (err) {
    console.error('❌ Server failed to start:', err.message);
    process.exit(1);
  }
})();

module.exports = { app, server, io };
