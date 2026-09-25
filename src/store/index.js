'use strict';

const { applyMigrations } = require('./migrations');
const { runAtomic } = require('./atomic');

/**
 * In-memory data store. This stands in for a real database and holds all
 * application state in plain Maps keyed by id. State is lost on restart, which
 * is acceptable for a mock/demo backend.
 */
const store = {
  vaults: new Map(),
  positions: new Map(),
  transactions: new Map(),
  transactionStates: new Map(),
  auditEvents: new Map(),
};

applyMigrations(store);

/**
 * Return record counts for each collection. Useful for health/diagnostics.
 */
store.runAtomic = function runAtomicBound(fn) {
  return runAtomic(store, fn);
};

store.stats = function stats() {
  return {
    vaults: store.vaults.size,
    positions: store.positions.size,
    transactions: store.transactions.size,
    transactionStates: store.transactionStates.size,
  };
};

module.exports = store;
