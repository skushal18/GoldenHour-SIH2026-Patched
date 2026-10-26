#!/usr/bin/env node
/* ============================================================================
   Loads the GoldenHour network's starting hospitals into MySQL.

   Reads the ids in data/hospitals/network_hospitals.csv, takes each
   hospital's row from data/hospitals/india_hospitals.csv and inserts it into
   the hospitals table (creating the schema first if it is missing).

   Repeatable: a hospital already in the table is left exactly as it is, so a
   second run inserts nothing and changes nothing — including a hospital the
   administrator has switched off since.

     npm --prefix backend run seed:hospitals            # uses the DB_* / DATABASE_URL settings
     npm --prefix backend run seed:hospitals -- --dry-run
   On AWS the instance reads its database secret first (src/config/awsSecrets.js).
   ========================================================================== */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  await require('../src/config/awsSecrets').loadIntoEnv(console);
  const catalogue = require('../src/services/catalogueService');
  const ids = catalogue.networkIds();
  const found = catalogue.networkSeed();
  console.log('network_hospitals.csv: ' + ids.length + ' ids, ' + found.length + ' found in the catalogue');
  if (process.argv.includes('--dry-run')) return 0;

  const pool = require('../src/config/db');
  try {
    await require('../src/store/migrate').ensureSchema(pool);
    const r = await require('../src/services/directoryService').seedNetwork(pool);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM hospitals');
    console.log('inserted ' + r.inserted + ', already present ' + r.already + (r.missing.length ? ', not in catalogue: ' + r.missing.join(' ') : '') +
      ' — hospitals table now holds ' + n + ' (' + pool.settings.host + '/' + pool.settings.database + ')');
    return r.missing.length ? 1 : 0;
  } finally { await pool.end(); }
}

main().then(code => process.exit(code), err => { console.error('❌ seed failed: ' + err.message); process.exit(1); });
