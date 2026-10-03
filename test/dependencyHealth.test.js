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

async function fetchJson(path, origin = baseUrl) {
  const res = await fetch(`${origin}${path}`);
  const body = await res.json();
  return { status: res.status, body, headers: res.headers };
}

async function appWithQuota(t, max) {
  const originalMax = config.rateLimit.max;
  let app;
  try {
    config.rateLimit.max = max;
    app = createApp();
  } finally {
    config.rateLimit.max = originalMax;
  }
  const quotaServer = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => quotaServer.close(resolve)));
  return `http://127.0.0.1:${quotaServer.address().port}`;
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

test('GET and HEAD liveness remain available after outage probes exhaust the API quota', async (t) => {
  const origin = await appWithQuota(t, 2);
  const transactionStates = store.transactionStates;
  store.transactionStates = null;
  try {
    for (let i = 0; i < 2; i += 1) {
      const ready = await fetchJson('/api/health/ready', origin);
      assert.equal(ready.status, 503);
      assert.equal(ready.body.checks.queue.reason, 'QUEUE_UNAVAILABLE');
    }

    const live = await fetchJson('/api/health/live', origin);
    assert.equal(live.status, 200);
    assert.equal(live.body.status, 'alive');
    assert.equal(typeof live.body.uptime, 'number');
    assert.equal(live.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(live.headers.get('x-request-id'));
    assert.equal(live.headers.get('x-ratelimit-limit'), null);

    const head = await fetch(`${origin}/api/health/live`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    assert.equal((await fetchJson('/api/health/ready', origin)).status, 429);
    assert.equal((await fetchJson('/api/version', origin)).status, 429);
    assert.equal((await fetchJson('/api/health/live-extra', origin)).status, 429);
    const post = await fetch(`${origin}/api/health/live`, { method: 'POST' });
    assert.equal(post.status, 429);
    await post.arrayBuffer();
  } finally {
    store.transactionStates = transactionStates;
  }
});

test('liveness polling preserves the ordinary API request budget', async (t) => {
  const origin = await appWithQuota(t, 2);
  for (const path of ['/api/health/live', '/api/health/live?check=process', '/api/health/live/', '/api/HEALTH/LIVE']) {
    const live = await fetchJson(path, origin);
    assert.equal(live.status, 200);
    assert.equal(live.body.status, 'alive');
  }

  assert.equal((await fetchJson('/api/version', origin)).status, 200);
  assert.equal((await fetchJson('/api/version', origin)).status, 200);
  const limited = await fetchJson('/api/version', origin);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
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


// ─── Default chain adapter: async results must settle inside the check ────────

test('default chain probe awaits an asynchronous successful provider result', async () => {
  const stellarService = require('../src/services/stellarService');
  const originalPing = stellarService.ping;
  stellarService.ping = async () => ({ ok: true, network: 'testnet' });
  try {
    const { status, body } = await fetchJson('/api/health/ready');
    assert.equal(status, 200);
    assert.equal(body.status, 'ready');
    assert.equal(body.checks.chain.status, 'ok');
    assert.equal(body.checks.chain.reason, undefined);
  } finally {
    stellarService.ping = originalPing;
  }
});

test('default chain probe rejects unsuccessful asynchronous provider results', async () => {
  const stellarService = require('../src/services/stellarService');
  const originalPing = stellarService.ping;
  try {
    for (const result of [null, {}, { ok: false }]) {
      stellarService.ping = async () => result;
      const { status, body } = await fetchJson('/api/health/ready');
      assert.equal(status, 503);
      assert.equal(body.checks.chain.reason, 'CHAIN_UNAVAILABLE');
    }
  } finally {
    stellarService.ping = originalPing;
  }
});

test('default chain probe handles and redacts an asynchronous provider rejection', async () => {
  const stellarService = require('../src/services/stellarService');
  const originalPing = stellarService.ping;
  const secret = 'https://mock.invalid/rpc?apiKey=readiness-fixture-secret';
  stellarService.ping = async () => {
    throw new Error(secret);
  };
  try {
    const { status, body } = await fetchJson('/api/health/ready');
    assert.equal(status, 503);
    assert.equal(body.checks.chain.status, 'error');
    assert.equal(body.checks.chain.reason, 'CHAIN_UNAVAILABLE');
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal(body.checks.chain.message, undefined);
    assert.equal(body.checks.chain.stack, undefined);
  } finally {
    stellarService.ping = originalPing;
  }
});

test('default chain probe times out and recovers while liveness stays available', async () => {
  const stellarService = require('../src/services/stellarService');
  const originalPing = stellarService.ping;
  stellarService.ping = () => new Promise(() => {});
  try {
    const started = Date.now();
    const pending = fetchJson('/api/health/ready');
    const live = await fetchJson('/api/health/live');
    const down = await pending;
    assert.equal(live.status, 200);
    assert.equal(live.body.status, 'alive');
    assert.equal(down.status, 503);
    assert.equal(down.body.checks.chain.reason, 'CHAIN_TIMEOUT');
    assert.ok(Date.now() - started < 1000, 'asynchronous provider exceeded the readiness budget');

    stellarService.ping = async () => ({ ok: true });
    const recovered = await fetchJson('/api/health/ready');
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.checks.chain.status, 'ok');
    assert.equal(recovered.body.checks.chain.reason, undefined);
  } finally {
    stellarService.ping = originalPing;
  }
});
