'use strict';
const { createMemoryStore } = require('./memoryStore');
const { createMysqlStore } = require('./mysqlStore');
let active = null;
async function initStore(){
  const fm = process.argv.indexOf('--memory') !== -1;
  const want = fm ? 'memory' : (process.env.DB_DRIVER || 'auto').toLowerCase();
  if (want === 'memory'){
    active = createMemoryStore(); await active.init();
    console.log('🗃️  Store: in-memory'); return active;
  }
  try{
    const pool = require('../config/db');
    active = createMysqlStore(pool); await active.init();
    console.log('🗃️  Store: MySQL'); return active;
  }catch(err){
    if (want === 'mysql') throw err;
    console.warn('⚠️  MySQL unreachable. Falling back to memory:', err.message);
    active = createMemoryStore(); await active.init(); return active;
  }
}
function getStore(){ if (!active) throw new Error('Store not initialised'); return active; }
module.exports = { initStore, getStore };
