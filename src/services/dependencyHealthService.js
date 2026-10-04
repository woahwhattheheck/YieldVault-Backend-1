'use strict';

const config = require('../config');
const store = require('../store');
const stellarService = require('./stellarService');
const { createProbePool } = require('./inFlightProbe');
const probePool = createProbePool();

/**
 * Dependency-aware readiness diagnostics.
 *
 * Separates process liveness from traffic readiness by probing the store
 * (database stand-in), chain provider (Stellar/Soroban), and transaction
 * lifecycle queue with a per-check time budget. Failures surface as stable,
 * redacted reason codes — never raw messages, stacks, or connection material —
 * and completed probes are re-evaluated on the next request so recovery does
 * not require a process restart.
 */

/** Stable dependency names exposed on the readiness payload. */
const DEPENDENCIES = Object.freeze(['store', 'chain', 'queue']);

/** Reason codes returned to callers. Keep these stable for monitors. */
const REASON = Object.freeze({
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  STORE_TIMEOUT: 'STORE_TIMEOUT',
  CHAIN_UNAVAILABLE: 'CHAIN_UNAVAILABLE',
  CHAIN_TIMEOUT: 'CHAIN_TIMEOUT',
  QUEUE_UNAVAILABLE: 'QUEUE_UNAVAILABLE',
  QUEUE_TIMEOUT: 'QUEUE_TIMEOUT',
  CHECK_ERROR: 'CHECK_ERROR',
});

/**
 * Test-only overrides. A Map of dependency name -> override descriptor:
 *   { mode: 'fail', reason?: string }
 *   { mode: 'timeout', delayMs?: number }
 *   { mode: 'throw', message?: string }  // message is redacted from responses
 * @type {Map<string, {mode: string, reason?: string, delayMs?: number, message?: string}>}
 */
const forcedStates = new Map();

/**
 * Default probe implementations. Each returns a Promise that resolves on
 * success or rejects with an Error carrying a `reasonCode`.
 */
const defaultProbes = Object.freeze({
  async store() {
    if (
      !store ||
      !(store.vaults instanceof Map) ||
      !(store.positions instanceof Map) ||
      !(store.transactions instanceof Map)
    ) {
      const err = new Error('store unavailable');
      err.reasonCode = REASON.STORE_UNAVAILABLE;
      throw err;
    }
    // Touch the maps so a corrupted store surfaces as unavailable.
    void store.vaults.size;
    void store.positions.size;
    void store.transactions.size;
    // Preserve the prior readiness gate: refuse traffic until at least one
    // vault is seeded so callers never hit an empty catalog mid-boot.
    if (store.vaults.size === 0) {
      const err = new Error('store not seeded');
      err.reasonCode = REASON.STORE_UNAVAILABLE;
      throw err;
    }
    return { ok: true };
  },

  async chain(ping = stellarService.ping) {
    const result = await ping.call(stellarService);
    if (!result || result.ok !== true) {
      const err = new Error('chain unavailable');
      err.reasonCode = REASON.CHAIN_UNAVAILABLE;
      throw err;
    }
    return { ok: true };
  },

  async queue() {
    // Transaction lifecycle state is the durable queue stand-in for retries
    // and confirmation workers. Confirm the Map is present and readable.
    if (!store || !(store.transactionStates instanceof Map)) {
      const err = new Error('queue unavailable');
      err.reasonCode = REASON.QUEUE_UNAVAILABLE;
      throw err;
    }
    void store.transactionStates.size;
    return { ok: true };
  },
});

/** Active probes — start as defaults; tests may replace individual ones. */
const probes = {
  store: defaultProbes.store,
  chain: defaultProbes.chain,
  queue: defaultProbes.queue,
};

/**
 * Resolve the per-check timeout budget in milliseconds.
 * @returns {number}
 */
function checkTimeoutMs() {
  return normaliseTimeoutMs(config.health && config.health.checkTimeoutMs, 1000);
}

/** Keep the advertised budget equal to a representable Node timer delay. */
function normaliseTimeoutMs(raw, fallback) {
  const n = Number(raw);
  // Node turns overflowing delays into 1 ms instead of waiting longer.
  return Number.isFinite(n) && n > 0 && n <= 2147483647
    ? Math.max(1, Math.trunc(n)) : fallback;
}

/**
 * Race a probe against a hard deadline. The original promise is not
 * cancelled (Node has no Abort for plain promises), but readiness never
 * waits longer than the budget.
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @param {string} timeoutReason
 * @returns {Promise<unknown>}
 */
function withTimeout(promise, ms, timeoutReason) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('dependency check timed out');
      err.reasonCode = timeoutReason;
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Map an arbitrary failure to a redacted reason code. Raw messages and
 * stacks never leave this function.
 * @param {string} name
 * @param {unknown} err
 * @returns {string}
 */
function redactReason(name, err) {
  const timeouts = {
    store: REASON.STORE_TIMEOUT,
    chain: REASON.CHAIN_TIMEOUT,
    queue: REASON.QUEUE_TIMEOUT,
  };
  const unavailable = {
    store: REASON.STORE_UNAVAILABLE,
    chain: REASON.CHAIN_UNAVAILABLE,
    queue: REASON.QUEUE_UNAVAILABLE,
  };
  const timeoutReason = timeouts[name];
  const unavailableReason = unavailable[name];

  // A timeout is a property of the dependency being checked. Give it
  // precedence over any stale or foreign reasonCode carried by the error.
  if (err && typeof err === 'object' && err.code === 'TIMEOUT') {
    return timeoutReason || REASON.CHECK_ERROR;
  }

  const code = err && typeof err === 'object' ? err.reasonCode : undefined;
  if (
    typeof code === 'string' &&
    (code === timeoutReason || code === unavailableReason)
  ) {
    return code;
  }

  return unavailableReason || REASON.CHECK_ERROR;
}

/**
 * Apply a test override before the real probe, if one is set.
 * @param {string} name
 * @returns {Promise<unknown>|null}
 */
function applyForcedState(name) {
  const forced = forcedStates.get(name);
  if (!forced) return null;

  if (forced.mode === 'fail') {
    const err = new Error('forced failure');
    err.reasonCode =
      forced.reason ||
      ({
        store: REASON.STORE_UNAVAILABLE,
        chain: REASON.CHAIN_UNAVAILABLE,
        queue: REASON.QUEUE_UNAVAILABLE,
      }[name] || REASON.CHECK_ERROR);
    return Promise.reject(err);
  }

  if (forced.mode === 'timeout') {
    const delay = Number(forced.delayMs) > 0 ? Number(forced.delayMs) : checkTimeoutMs() * 5;
    return new Promise((resolve) => {
      const t = setTimeout(resolve, delay);
      if (typeof t.unref === 'function') t.unref();
    });
  }

  if (forced.mode === 'throw') {
    const err = new Error(
      forced.message ||
        'postgres://user:super-secret@db.internal:5432/yieldvault leaked'
    );
    return Promise.reject(err);
  }

  return null;
}

/**
 * Run a single named dependency check under the shared time budget.
 * @param {string} name
 * @param {number} [timeoutMs]
 * @returns {Promise<{name: string, status: 'ok'|'error', reason?: string, latencyMs: number}>}
 */
async function runCheck(name, timeoutMs = checkTimeoutMs()) {
  timeoutMs = normaliseTimeoutMs(timeoutMs, checkTimeoutMs());
  const started = Date.now();
  const timeoutReason = {
    store: REASON.STORE_TIMEOUT,
    chain: REASON.CHAIN_TIMEOUT,
    queue: REASON.QUEUE_TIMEOUT,
  }[name] || REASON.CHECK_ERROR;

  try {
    const forced = applyForcedState(name);
    const probe = typeof probes[name] === 'function' ? probes[name] : null;
    if (!probe && !forced) {
      const err = new Error('unknown dependency');
      err.reasonCode = REASON.CHECK_ERROR;
      throw err;
    }
    // Capture the adapter generation before deferring the call. A replacement
    // must not inherit an old adapter's unfinished operation.
    const adapter = probe === defaultProbes.chain ? stellarService.ping : probe;
    const invoke = probe === defaultProbes.chain ? () => probe(adapter) : probe;
    const subscription = forced ? null : probePool.acquire(name, invoke, adapter);
    try {
      await withTimeout(forced || subscription.promise, timeoutMs, timeoutReason);
    } finally {
      if (subscription) subscription.release();
    }
    return {
      name,
      status: 'ok',
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      name,
      status: 'error',
      reason: redactReason(name, err),
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Evaluate every dependency. Overlapping requests share only unfinished
 * probes; each caller keeps its own deadline and completed checks are not cached.
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{
 *   ready: boolean,
 *   status: 'ready'|'not_ready',
 *   checks: Record<string, {status: string, reason?: string, latencyMs: number}>,
 *   timeoutMs: number
 * }>}
 */
async function evaluateReadiness(options = {}) {
  const timeoutMs = normaliseTimeoutMs(options.timeoutMs, checkTimeoutMs());
  const results = await Promise.all(DEPENDENCIES.map((name) => runCheck(name, timeoutMs)));

  /** @type {Record<string, {status: string, reason?: string, latencyMs: number}>} */
  const checks = {};
  let ready = true;
  for (const result of results) {
    const entry = { status: result.status, latencyMs: result.latencyMs };
    if (result.reason) entry.reason = result.reason;
    checks[result.name] = entry;
    if (result.status !== 'ok') ready = false;
  }

  return {
    ready,
    status: ready ? 'ready' : 'not_ready',
    checks,
    timeoutMs,
  };
}

/**
 * Force a dependency into a known bad state for tests.
 * @param {string} name
 * @param {{mode: 'fail'|'timeout'|'throw', reason?: string, delayMs?: number, message?: string}} state
 */
function forceDependencyState(name, state) {
  if (!DEPENDENCIES.includes(name)) {
    throw new Error(`unknown dependency: ${name}`);
  }
  forcedStates.set(name, state);
}

/** Remove every test override so subsequent probes hit the real path. */
function clearForcedStates() {
  forcedStates.clear();
}

/**
 * Replace a probe implementation (tests only). Pass `null` to restore default.
 * @param {string} name
 * @param {null|(() => Promise<unknown>)} fn
 */
function setProbeForTests(name, fn) {
  if (!DEPENDENCIES.includes(name)) {
    throw new Error(`unknown dependency: ${name}`);
  }
  probes[name] = typeof fn === 'function' ? fn : defaultProbes[name];
}

/** Restore default probes and clear forced states (tests only). */
function resetForTests() {
  probePool.clear();
  for (const name of DEPENDENCIES) {
    probes[name] = defaultProbes[name];
  }
  forcedStates.clear();
}

module.exports = {
  DEPENDENCIES,
  REASON,
  evaluateReadiness,
  runCheck,
  forceDependencyState,
  clearForcedStates,
  setProbeForTests,
  resetForTests,
  checkTimeoutMs,
};
