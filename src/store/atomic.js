'use strict';

/**
 * Snapshot / restore helpers for multi-record mutations on the in-memory store.
 *
 * The demo backend has no real DB transactions. These helpers give deposit and
 * withdraw the same all-or-nothing guarantee by cloning collection Maps before
 * a mutation and restoring them if the mutation throws.
 */

const COLLECTIONS = Object.freeze([
  'vaults',
  'positions',
  'transactions',
  'transactionStates',
  'auditEvents',
]);

function cloneValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'object') {
    return value;
  }
  // Preserve invalid numeric evidence and explicit undefined fields on rollback.
  return structuredClone(value);
}

function ensureMap(store, name) {
  if (!store[name] || typeof store[name].set !== 'function') {
    store[name] = new Map();
  }
  return store[name];
}

/**
 * Deep-clone every tracked collection into plain Maps.
 */
function snapshot(store) {
  const snap = {};
  for (const name of COLLECTIONS) {
    const map = ensureMap(store, name);
    snap[name] = new Map();
    for (const [key, value] of map.entries()) {
      snap[name].set(key, cloneValue(value));
    }
  }
  return snap;
}

/**
 * Replace live collection contents with a prior snapshot. Existing Map
 * instances are cleared and refilled so module-level references stay valid.
 */
function restore(store, snap) {
  for (const name of COLLECTIONS) {
    const map = ensureMap(store, name);
    map.clear();
    for (const [key, value] of snap[name].entries()) {
      map.set(key, cloneValue(value));
    }
  }
}

/**
 * Run `fn` atomically against `store`. On any thrown error the pre-call
 * snapshot is restored before the error is rethrown.
 */
function runAtomic(store, fn) {
  if (!store || typeof fn !== 'function') {
    throw new TypeError('runAtomic(store, fn) requires a store and a function');
  }
  const snap = snapshot(store);
  try {
    return fn();
  } catch (error) {
    restore(store, snap);
    throw error;
  }
}

module.exports = {
  COLLECTIONS,
  snapshot,
  restore,
  runAtomic,
};
