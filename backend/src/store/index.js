/* ============================================================================
   Store selection.

   DB_DRIVER=auto   (default) try MySQL, fall back to memory with a loud warning
   DB_DRIVER=mysql  require MySQL; refuse to start without it
   DB_DRIVER=memory skip MySQL entirely — the fastest way to demo
   ========================================================================== */

'use strict';

const { createMemoryStore } = require('./memoryStore');
const { createMysqlStore } = require('./mysqlStore');

let active = null;

async function initStore() {
  /* `npm run demo` passes --memory, which works the same on Windows,
     macOS and Linux without a cross-env dependency. */
  const forcedMemory = process.argv.indexOf('--memory') !== -1;
  const wanted = forcedMemory ? 'memory' : (process.env.DB_DRIVER || 'auto').toLowerCase();

  if (wanted === 'memory') {
    active = createMemoryStore();
    await active.init();
    console.log('🗃️  Store: in-memory — fast to demo, nothing is persisted');
    return active;
  }

  try {
    const pool = require('../config/db');
    const store = createMysqlStore(pool);
    await store.init();
    active = store;
    console.log('🗃️  Store: MySQL');
    return active;
  } catch (err) {
    if (wanted === 'mysql') {
      console.error('❌ MySQL required (DB_DRIVER=mysql) but unreachable:', err.message);
      throw err;
    }
    console.warn('');
    console.warn('⚠️  ────────────────────────────────────────────────────────────');
    console.warn('⚠️   MySQL is not reachable:', err.message);
    console.warn('⚠️   Falling back to the IN-MEMORY store so the demo still runs.');
    console.warn('⚠️   Broadcasts will be lost when this server restarts.');
    console.warn('⚠️   Set DB_DRIVER=mysql to make this a hard failure instead.');
    console.warn('⚠️  ────────────────────────────────────────────────────────────');
    console.warn('');
    active = createMemoryStore();
    await active.init();
    return active;
  }
}

function getStore() {
  if (!active) throw new Error('Store used before initStore() finished');
  return active;
}

module.exports = { initStore, getStore };
