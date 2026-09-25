'use strict';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const createApp = require('../src/app');
const config = require('../src/config');
const store = require('../src/store');
const seed = require('../src/store/seed');
const dependencyHealth = require('../src/services/dependencyHealthService');

let server;
let baseUrl;
let originalTimeout;

function ensureSeeded() {
  if (store.vaults.size === 0) {
    seed();
  }
}

before(() => {
  originalTimeout = config.health.checkTimeoutMs;
  config.health.checkTimeoutMs = 50;
  ensureSeeded();

  const app = createApp();
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => {
  config.health.checkTimeoutMs = originalTimeout;
  dependencyHealth.resetForTests();
  if (server) {
    server.close();
  }
});

beforeEach(() => {
  dependencyHealth.resetForTests();
  config.health.checkTimeoutMs = 50;
  ensureSeeded();
});

afterEach(() => {
  dependencyHealth.resetForTests();
});

async function fetchJson(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

// ─── Happy path ──────────────────────────────────────────────────────────────

test('readiness is ready when store, chain, and queue are healthy', async () => {
  const { status, body } = await fetchJson('/api/health/ready');
  assert.equal(status, 200);
  assert.equal(body.status, 'ready');
  for (const name of dependencyHealth.DEPENDENCIES) {
    assert.equal(body.checks[name].status, 'ok');
    assert.equal(body.checks[name].reason, undefined);
    assert.ok(typeof body.checks[name].latencyMs === 'number');
  }
});

test('evaluateReadiness reports ready=true with all ok checks', async () => {
  const result = await dependencyHealth.evaluateReadiness({ timeoutMs: 50 });
  assert.equal(result.ready, true);
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    Object.keys(result.checks).sort(),
    [...dependencyHealth.DEPENDENCIES].sort()
  );
});

// ─── Dependency failure (original failure mode regression) ───────────────────

test('readiness returns 503 when the chain provider is unavailable', async () => {
  dependencyHealth.forceDependencyState('chain', {
    mode: 'fail',
    reason: dependencyHealth.REASON.CHAIN_UNAVAILABLE,
  });

  const { status, body } = await fetchJson('/api/health/ready');
  assert.equal(status, 503);
  assert.equal(body.status, 'not_ready');
  assert.equal(body.checks.chain.status, 'error');
  assert.equal(body.checks.chain.reason, 'CHAIN_UNAVAILABLE');
  assert.equal(body.checks.store.status, 'ok');
  assert.equal(body.checks.queue.status, 'ok');
});

test('readiness returns 503 when the store dependency fails', async () => {
  dependencyHealth.forceDependencyState('store', {
    mode: 'fail',
    reason: dependencyHealth.REASON.STORE_UNAVAILABLE,
  });

  const { status, body } = await fetchJson('/api/health/ready');
  assert.equal(status, 503);
  assert.equal(body.status, 'not_ready');
  assert.equal(body.checks.store.reason, 'STORE_UNAVAILABLE');
});

test('readiness returns 503 when the queue dependency fails', async () => {
  dependencyHealth.forceDependencyState('queue', {
    mode: 'fail',
    reason: dependencyHealth.REASON.QUEUE_UNAVAILABLE,
  });

  const { status, body } = await fetchJson('/api/health/ready');
  assert.equal(status, 503);
  assert.equal(body.checks.queue.reason, 'QUEUE_UNAVAILABLE');
});

test('readiness returns 503 when the store is empty (unseeded regression)', async () => {
  // Snapshot and clear vaults to recreate the original "always-green while
  // empty" failure mode, then restore so later tests stay seeded.
  const snapshot = new Map(store.vaults);
  store.vaults.clear();
  try {
    const { status, body } = await fetchJson('/api/health/ready');
    assert.equal(status, 503);
    assert.equal(body.status, 'not_ready');
    assert.equal(body.checks.store.status, 'error');
    assert.equal(body.checks.store.reason, 'STORE_UNAVAILABLE');
  } finally {
    for (const [id, vault] of snapshot) {
      store.vaults.set(id, vault);
    }
  }
});

// ─── Liveness stays responsive during outages ────────────────────────────────

test('liveness remains 200 while readiness is not_ready', async () => {
  dependencyHealth.forceDependencyState('chain', { mode: 'fail' });
  dependencyHealth.forceDependencyState('queue', { mode: 'fail' });
  dependencyHealth.forceDependencyState('store', { mode: 'fail' });

  const live = await fetchJson('/api/health/live');
  assert.equal(live.status, 200);
  assert.equal(live.body.status, 'alive');

  const ready = await fetchJson('/api/health/ready');
  assert.equal(ready.status, 503);
  assert.equal(ready.body.status, 'not_ready');
});

test('base /api/health stays ok during dependency outages', async () => {
  dependencyHealth.forceDependencyState('chain', { mode: 'fail' });
  const { status, body } = await fetchJson('/api/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
});

// ─── Timeout: dependency checks cannot hang ──────────────────────────────────

test('readiness returns 503 with *_TIMEOUT when a dependency hangs', async () => {
  dependencyHealth.forceDependencyState('queue', {
    mode: 'timeout',
    delayMs: 5000,
  });

  const started = Date.now();
  const { status, body } = await fetchJson('/api/health/ready');
  const elapsed = Date.now() - started;

  assert.equal(status, 503);
  assert.equal(body.checks.queue.status, 'error');
  assert.equal(body.checks.queue.reason, 'QUEUE_TIMEOUT');
  assert.ok(elapsed < 1000, `readiness hung for ${elapsed}ms`);
});

test('runCheck maps a hanging probe to a timeout reason within budget', async () => {
  dependencyHealth.setProbeForTests('store', () => new Promise(() => {}));
  const started = Date.now();
  const result = await dependencyHealth.runCheck('store', 40);
  const elapsed = Date.now() - started;

  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'STORE_TIMEOUT');
  assert.ok(elapsed < 500, `check hung for ${elapsed}ms`);
});

// ─── Recovery without restart ────────────────────────────────────────────────

test('readiness recovers after a failed dependency becomes healthy again', async () => {
  dependencyHealth.forceDependencyState('chain', {
    mode: 'fail',
    reason: dependencyHealth.REASON.CHAIN_UNAVAILABLE,
  });

  const down = await fetchJson('/api/health/ready');
  assert.equal(down.status, 503);
  assert.equal(down.body.checks.chain.reason, 'CHAIN_UNAVAILABLE');

  dependencyHealth.clearForcedStates();

  const up = await fetchJson('/api/health/ready');
  assert.equal(up.status, 200);
  assert.equal(up.body.status, 'ready');
  assert.equal(up.body.checks.chain.status, 'ok');
  assert.equal(up.body.checks.chain.reason, undefined);
});

// ─── Status codes ────────────────────────────────────────────────────────────

test('status codes: 200 when ready, 503 when any dependency fails', async () => {
  const ok = await fetchJson('/api/health/ready');
  assert.equal(ok.status, 200);

  dependencyHealth.forceDependencyState('store', { mode: 'fail' });
  const bad = await fetchJson('/api/health/ready');
  assert.equal(bad.status, 503);

  dependencyHealth.clearForcedStates();
  const recovered = await fetchJson('/api/health/ready');
  assert.equal(recovered.status, 200);
});

// ─── Redaction ───────────────────────────────────────────────────────────────

test('readiness redacts raw error messages and secrets from responses', async () => {
  const secret = 'postgres://user:super-secret@db.internal:5432/yieldvault';
  dependencyHealth.forceDependencyState('store', {
    mode: 'throw',
    message: `${secret} password=hunter2 apiKey=sk_live_abc`,
  });

  const { status, body } = await fetchJson('/api/health/ready');
  assert.equal(status, 503);
  assert.equal(body.checks.store.status, 'error');
  assert.equal(body.checks.store.reason, 'STORE_UNAVAILABLE');

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('super-secret'), false);
  assert.equal(serialized.includes('hunter2'), false);
  assert.equal(serialized.includes('sk_live_abc'), false);
  assert.equal(serialized.includes('postgres://'), false);
  assert.equal(serialized.includes('password='), false);
  assert.equal(body.checks.store.message, undefined);
  assert.equal(body.checks.store.stack, undefined);
});

test('unit redact path never leaks custom throw messages', async () => {
  dependencyHealth.forceDependencyState('chain', {
    mode: 'throw',
    message: 'Authorization: Bearer sk_live_should_not_leak',
  });
  const result = await dependencyHealth.runCheck('chain', 50);
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'CHAIN_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('sk_live'), false);
});
