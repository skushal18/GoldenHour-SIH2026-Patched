/* Headless browser walk-through of the real two-laptop demo.
   Not shipped as part of the product test suite — a development aid.
   Needs Playwright, which is deliberately NOT a dependency of this project:
       npm i -D playwright && npx playwright install chromium
       node tests/ui.check.js
   Screenshots land in .shots/ at the repo root. */

'use strict';

process.env.PORT = '5177';
process.env.DB_DRIVER = 'memory';
if (process.argv.indexOf('--memory') === -1) process.argv.push('--memory');

const path = require('path');
const { chromium } = require('playwright');
const { server } = require('../src/server');

const BASE = 'http://127.0.0.1:5177';
const OUT = path.join(__dirname, '..', '..', '.shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SAMPLE = {
  case_type_id: 12, age: 58, gender: 'M', blood_group: 'O+',
  vitals: { systolic_bp: 82, diastolic_bp: 50, heart_rate: 132, resp_rate: 26, spo2: 88, glucose: null },
  consciousness: 'Semi-Conscious',
  origin: { lat: 12.9716, lng: 77.5946, accuracy_m: 18 },
  broadcast_radius_km: 15, images: [], eta_minutes: 12,
  notes: 'entrapped 20 min, one unit O− given', ambulance_id: 'KA01AB1234',
  stroke_assessment: { face: false, arm: true, speech: true, onset_hours: 2 }
};

(async () => {
  await new Promise(r => server.listening ? r() : server.once('listening', r));
  require('fs').mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium' });
  const errors = [];

  const deskA = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const deskB = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  [['A', deskA], ['B', deskB]].forEach(([tag, p]) => {
    p.on('pageerror', e => errors.push(`desk${tag}: ${e.message}`));
    p.on('console', m => { if (m.type() === 'error') errors.push(`desk${tag} console: ${m.text()}`); });
  });

  await deskA.goto(`${BASE}/hospital?hospital=1`);
  await deskB.goto(`${BASE}/hospital?hospital=2`);
  await sleep(700);

  console.log('desk A identity :', await deskA.textContent('#hospitalName'));
  console.log('desk B identity :', await deskB.textContent('#hospitalName'));
  console.log('desk A link     :', await deskA.textContent('#linkPill'));
  await deskA.screenshot({ path: path.join(OUT, '1-desk-empty.png') });

  /* Broadcast */
  await fetch(`${BASE}/api/v1/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SAMPLE)
  });
  await sleep(900);

  const cardsA = await deskA.locator('.case').count();
  const cardsB = await deskB.locator('.case').count();
  console.log(`after broadcast : desk A ${cardsA} card(s), desk B ${cardsB} card(s)`);
  await deskA.screenshot({ path: path.join(OUT, '2-desk-incoming.png') });
  await deskB.screenshot({ path: path.join(OUT, '3-desk-b-incoming.png') });

  /* Accept on A */
  await deskA.click('.btn-accept');
  await sleep(1100);
  console.log('after accept    : desk A queue', await deskA.locator('#queue .case').count(),
              '· desk B queue', await deskB.locator('#queue .case').count());
  console.log('desk A history  :', (await deskA.textContent('#history')).replace(/\s+/g, ' ').trim().slice(0, 90));
  console.log('desk B history  :', (await deskB.textContent('#history')).replace(/\s+/g, ' ').trim().slice(0, 90));
  await deskA.screenshot({ path: path.join(OUT, '4-desk-a-accepted.png') });
  await deskB.screenshot({ path: path.join(OUT, '5-desk-b-cleared.png') });

  /* Ambulance app */
  const phone = await browser.newPage({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2 });
  phone.on('pageerror', e => errors.push(`phone: ${e.message}`));
  phone.on('console', m => { if (m.type() === 'error') errors.push(`phone console: ${m.text()}`); });
  await phone.context().grantPermissions(['geolocation'], { origin: BASE });
  await phone.context().setGeolocation({ latitude: 12.9716, longitude: 77.5946 });
  await phone.goto(`${BASE}/ambulance/`);
  await sleep(1200);
  console.log('phone net pill  :', await phone.textContent('#netPill'));
  console.log('phone location  :', await phone.textContent('#locationStatus'));
  console.log('phone options   :', await phone.locator('#caseType option').count());
  await phone.screenshot({ path: path.join(OUT, '6-app-form.png'), fullPage: false });

  /* Drive a real broadcast from the UI */
  await phone.selectOption('#caseType', '12');
  await phone.fill('#systolicBp', '82');
  await phone.fill('#spo2', '88');
  await sleep(200);
  await phone.screenshot({ path: path.join(OUT, '7-app-filled.png') });
  await phone.click('#submitBtn');
  await sleep(1200);
  console.log('phone status    :', (await phone.textContent('#statusChipText')).trim());
  await phone.screenshot({ path: path.join(OUT, '8-app-waiting.png') });

  await deskB.click('.btn-accept');
  await sleep(1400);
  console.log('phone status now:', (await phone.textContent('#statusChipText')).trim());
  console.log('phone accepted  :', (await phone.textContent('#acceptedMeta')).trim());
  await phone.screenshot({ path: path.join(OUT, '9-app-accepted.png') });

  /* The trap this whole fallback exists for: a plain-http LAN origin is not a
     secure context, so Chrome refuses geolocation outright. */
  const lanBase = 'http://192.0.2.2:5177';
  const lan = await browser.newPage({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 2 });
  lan.on('pageerror', e => errors.push(`lan: ${e.message}`));
  await lan.goto(`${lanBase}/ambulance/`);
  await sleep(1500);
  console.log('\nLAN origin (insecure, GPS refused by Chrome)');
  console.log('  secure context:', await lan.evaluate(() => window.isSecureContext));
  console.log('  location says :', (await lan.textContent('#locationStatus')).trim());
  console.log('  fallback shown:', await lan.locator('#locFallback').isVisible());
  console.log('  shortcuts     :', (await lan.textContent('#locFallbackChips')).trim());
  await lan.locator('#locFallback').scrollIntoViewIfNeeded();
  await sleep(400);
  await lan.screenshot({ path: path.join(OUT, 'a-app-no-gps.png') });

  await lan.selectOption('#caseType', '12');
  await lan.locator('#locFallbackChips .chip').first().click();
  await sleep(200);
  console.log('  hint now      :', (await lan.textContent('#submitHint')).trim());
  await lan.locator('#locBox').scrollIntoViewIfNeeded();
  await sleep(300);
  await lan.screenshot({ path: path.join(OUT, 'b-app-manual-origin.png') });
  await lan.click('#submitBtn');
  await sleep(1400);
  console.log('  broadcast     :', (await lan.textContent('#statusChipText')).trim());
  console.log('  desk A cards  :', await deskA.locator('#queue .case').count());
  console.log('  desk A flags  :', (await deskA.textContent('#queue')).includes('set by hand')
    ? 'shows "Position set by hand"' : 'NOT flagged');
  await deskA.screenshot({ path: path.join(OUT, 'c-desk-manual-origin.png') });

  const landing = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await landing.goto(`${BASE}/`);
  await sleep(600);
  await landing.screenshot({ path: path.join(OUT, '0-landing.png') });

  console.log('\npage errors     :', errors.length ? errors : 'none');
  await browser.close();
  server.close();
  process.exit(0);
})();
