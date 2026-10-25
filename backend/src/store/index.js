/* ============================================================================
   Picks the storage driver once at boot and hands out the case store and the
   account store. Both always use the same driver, so a deployment is either
   wholly persistent (MySQL) or wholly in-memory (demo) — never half and half.

   DB_DRIVER: auto (default: MySQL, falling back to memory with a loud
   warning) · mysql (MySQL or refuse to start) · memory.
   Production refuses anything but mysql (config/security.js).
   ========================================================================== */
'use strict';
const { createMemoryStore } = require('./memoryStore');
const { createMysqlStore } = require('./mysqlStore');
const { createMemoryAccounts, createMysqlAccounts } = require('./accountStore');
const { ensureSchema } = require('./migrate');

let active = null;
let accounts = null;
let pool = null;

async function initStore() {
  const forceMemory = process.argv.indexOf('--memory') !== -1;
  const want = forceMemory ? 'memory' : (process.env.DB_DRIVER || 'auto').toLowerCase();
  if (want === 'memory') return useMemory('in-memory');
  try {
    pool = require('../config/db');
    const conn = await pool.getConnection(); conn.release();
    await ensureSchema(pool);
    active = createMysqlStore(pool); await active.init();
    accounts = createMysqlAccounts(pool); await accounts.init();
    const s = pool.settings || {};
    console.log('🗃️  Store: MySQL (' + s.host + ':' + s.port + '/' + s.database + ', from ' + s.source + ')');
    return active;
  } catch (err) {
    pool = null;
    if (want === 'mysql') throw err;
    console.warn('⚠️  MySQL unreachable — falling back to memory. Nothing will survive a restart. (' + err.message + ')');
    return useMemory('in-memory (MySQL fallback)');
  }
}

async function useMemory(label) {
  active = createMemoryStore(); await active.init();
  accounts = createMemoryAccounts(); await accounts.init();
  console.log('🗃️  Store: ' + label);
  return active;
}

function getStore() { if (!active) throw new Error('Store not initialised'); return active; }
function getAccounts() { if (!accounts) throw new Error('Store not initialised'); return accounts; }
/** The MySQL pool when MySQL is live, else null. Used for write-through persistence. */
function getPool() { return pool; }

/* Test hook: run the services against the in-memory drivers without booting a server. */
async function useMemoryForTests() { return useMemory('in-memory (test)'); }

module.exports = { initStore, getStore, getAccounts, getPool, useMemoryForTests };
