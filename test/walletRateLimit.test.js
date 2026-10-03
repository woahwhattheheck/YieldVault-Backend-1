'use strict';

const { test, before, after, beforeEach, afterEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const config = require('../src/config');
const walletRateLimit = require('../src/middleware/walletRateLimit');
const { validateBody } = require('../src/middleware/validate');
const errorHandler = require('../src/middleware/errorHandler');
const rateLimit = require('../src/middleware/rateLimit');

let server;
let baseUrl;

const originalWallet = { ...config.walletRateLimit };
const originalTrust = config.trustProxy;
const originalGlobal = { ...config.rateLimit };

const userRule = {
  type: 'string',
  required: true,
  minLength: 5,
  maxLength: 64,
  pattern: /^[A-Za-z0-9_]+$/,
};
const depositSchema = {
  user: userRule,
  vaultId: { type: 'string', required: true, minLength: 5, maxLength: 64 },
  amount: { type: 'number', required: true, positive: true, max: 1e12 },
};
const withdrawSchema = {
  user: userRule,
  vaultId: { type: 'string', required: true, minLength: 5, maxLength: 64 },
  shares: { type: 'number', required: true, positive: true },
};

/**
 * Focused app mirroring production wiring for wallet-sensitive mutations:
 * validateBody → walletRateLimit → handler, plus the global /api rate limit.
 * Stub handlers avoid an unrelated depositSuccess contract mismatch on main.
 */
function createTestApp() {
  const app = express();
  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }
  app.use(express.json({ limit: '64kb' }));

  const api = express.Router();
  api.post(
    '/positions/deposit',
    validateBody(depositSchema),
    walletRateLimit({ scope: 'deposit' }),
    (req, res) => {
      res.status(201).json({ ok: true, op: 'deposit', actor: req.rateLimitIdentity.actor });
    }
  );
  api.post(
    '/positions/withdraw',
    validateBody(withdrawSchema),
    walletRateLimit({ scope: 'withdraw' }),
    (req, res) => {
      res.status(201).json({ ok: true, op: 'withdraw', actor: req.rateLimitIdentity.actor });
    }
  );

  app.use('/api', rateLimit());
  app.use('/api', api);
  app.use(errorHandler);
  return app;
}

before(() => {
  config.rateLimit.max = 10000;
  config.rateLimit.maxKeys = 10000;
  config.walletRateLimit.windowMs = 60_000;
  config.walletRateLimit.maxPerActor = 5;
  config.walletRateLimit.maxPerClient = 8;
  config.walletRateLimit.maxKeys = 20;
  config.trustProxy = false;

  const app = createTestApp();
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  Object.assign(config.walletRateLimit, originalWallet);
  Object.assign(config.rateLimit, originalGlobal);
  config.trustProxy = originalTrust;
  walletRateLimit.resetWalletRateLimitStores();
  if (server) server.close();
});

beforeEach(() => {
  walletRateLimit.resetWalletRateLimitStores();
  config.trustProxy = false;
  config.walletRateLimit.windowMs = 60_000;
  config.walletRateLimit.maxPerActor = 5;
  config.walletRateLimit.maxPerClient = 8;
  config.walletRateLimit.maxKeys = 20;
});

afterEach(() => {
  walletRateLimit.resetWalletRateLimitStores();
});

async function deposit(body, headers = {}) {
  const res = await fetch(`${baseUrl}/api/positions/deposit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return {
    status: res.status,
    body: json,
    headers: {
      limit: res.headers.get('x-ratelimit-limit'),
      remaining: res.headers.get('x-ratelimit-remaining'),
      reset: res.headers.get('x-ratelimit-reset'),
      retryAfter: res.headers.get('retry-after'),
    },
  };
}

function depositBody(user, amount = 1) {
  return { user, vaultId: 'vault_test_1', amount };
}

function assertWalletRejection(result, limit, retryAfter, actor) {
  assert.equal(result.status, 429);
  assert.deepEqual(result.headers, {
    limit: String(limit),
    remaining: '0',
    reset: String(retryAfter),
    retryAfter: String(retryAfter),
  });
  assert.equal(result.body.error.message, 'Too many requests');
  assert.equal(result.body.error.details.code, 'RATE_LIMITED');
  assert.equal(result.body.error.details.retryAfter, retryAfter);
  assert.equal(JSON.stringify(result.body).toLowerCase().includes(actor.toLowerCase()), false);
}

function invokeLimiter(limiter, client, actor = 'wallet_capacity') {
  const headers = {};
  let error;
  limiter(
    {
      get: (name) => (name === 'X-Wallet-Address' ? actor : undefined),
      body: { user: actor },
      socket: { remoteAddress: client },
    },
    { setHeader: (name, value) => { headers[name] = value; } },
    (result) => { error = result; }
  );
  return { status: error?.statusCode || 200, error, headers };
}

describe('wallet rate limit suite', { concurrency: 1 }, () => {
  // ─── Wiring regression ───────────────────────────────────────────────────────

  test('positionRoutes mounts walletRateLimit on deposit and withdraw', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/routes/positionRoutes.js'),
      'utf8'
    );
    assert.match(src, /walletRateLimit\(\{\s*scope:\s*'deposit'\s*\}\)/);
    assert.match(src, /walletRateLimit\(\{\s*scope:\s*'withdraw'\s*\}\)/);
  });

  // ─── Unit: identity helpers ──────────────────────────────────────────────────

  describe('resolveActor / resolveClientId', () => {
    test('prefers X-Wallet-Address over body.user', () => {
      const req = {
        get: (name) => (name === 'X-Wallet-Address' ? 'HeaderWallet' : undefined),
        body: { user: 'BodyWallet' },
      };
      assert.equal(walletRateLimit.resolveActor(req), 'headerwallet');
    });

    test('falls back to body.user then anonymous', () => {
      assert.equal(
        walletRateLimit.resolveActor({ get: () => undefined, body: { user: 'Alice_1' } }),
        'alice_1'
      );
      assert.equal(
        walletRateLimit.resolveActor({ get: () => undefined, body: {} }),
        'anonymous'
      );
    });

    test('malformed actor collapses to anonymous (no key inflation)', () => {
      const req = {
        get: () => 'evil wallet with spaces!!!',
        body: {},
      };
      assert.equal(walletRateLimit.resolveActor(req), 'anonymous');
    });

    test('ignores X-Forwarded-For when trustProxy is false', () => {
      config.trustProxy = false;
      const req = {
        get: (name) => (name === 'X-Forwarded-For' ? '203.0.113.9' : undefined),
        ip: '203.0.113.9',
        socket: { remoteAddress: '127.0.0.1' },
      };
      assert.equal(walletRateLimit.resolveClientId(req), '127.0.0.1');
    });

    test('uses req.ip when trustProxy is enabled', () => {
      config.trustProxy = true;
      const req = {
        get: (name) => (name === 'X-Forwarded-For' ? '203.0.113.9, 10.0.0.1' : undefined),
        ip: '203.0.113.9',
        socket: { remoteAddress: '10.0.0.1' },
      };
      assert.equal(walletRateLimit.resolveClientId(req), '203.0.113.9');
    });
  });

  // ─── HTTP: quotas, 429, recovery, isolation ──────────────────────────────────

  test('legitimate deposits under quota succeed with rate-limit headers', async () => {
    const res = await deposit(depositBody('wallet_legit_1'), {
      'X-Wallet-Address': 'wallet_legit_1',
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.limit, '5');
    assert.equal(res.headers.remaining, '4');
    assert.ok(Number(res.headers.reset) >= 1);
  });

  test('burst over per-actor quota returns 429 with Retry-After and generic body', async () => {
    const user = 'wallet_burst_actor';
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await deposit(depositBody(user, 1), { 'X-Wallet-Address': user }));
    }
    const limited = results.filter((r) => r.status === 429);
    assert.ok(limited.length >= 1, 'expected at least one 429 after exceeding maxPerActor=5');
    const last = limited[0];
    assert.equal(last.body.error.message, 'Too many requests');
    assert.equal(last.body.error.details.code, 'RATE_LIMITED');
    assert.ok(last.body.error.details.retryAfter >= 1);
    assert.ok(last.headers.retryAfter);
    const dumped = JSON.stringify(last.body).toLowerCase();
    assert.equal(dumped.includes(user.toLowerCase()), false);
    assert.equal(dumped.includes('not found'), false);
    assert.equal(dumped.includes('exist'), false);
  });

  test('quota retry metadata follows a later exhausted actor window', async (t) => {
    let now = 10_000;
    t.mock.method(Date, 'now', () => now);
    config.walletRateLimit.maxPerActor = 2;
    config.walletRateLimit.maxPerClient = 3;
    const actor = 'wallet_later_actor';

    assert.equal((await deposit(depositBody('wallet_earlier_actor'))).status, 201);
    now = 20_000;
    assert.equal((await deposit(depositBody(actor))).status, 201);
    assert.equal((await deposit(depositBody(actor))).status, 201);
    assertWalletRejection(await deposit(depositBody(actor)), 2, 60, actor);
    assert.equal(walletRateLimit.walletRateLimitKeyCount(), 3);

    // The client expires first; the same actor must remain blocked for 10 seconds.
    now = 70_000;
    assertWalletRejection(await deposit(depositBody(actor)), 2, 10, actor);
    now = 80_000;
    const recovered = await deposit(depositBody(actor));
    assert.equal(recovered.status, 201);
    assert.equal(recovered.headers.retryAfter, null);
    assert.equal(walletRateLimit.walletRateLimitKeyCount(), 2);
  });

  test('quota retry metadata follows a renewed client window including its exact cap', async (t) => {
    let now = 10_000;
    t.mock.method(Date, 'now', () => now);
    config.walletRateLimit.maxPerActor = 2;
    config.walletRateLimit.maxPerClient = 3;
    const actor = 'wallet_renewed_client';

    assert.equal((await deposit(depositBody('wallet_client_seed'))).status, 201);
    now = 20_000;
    assert.equal((await deposit(depositBody(actor))).status, 201);
    assert.equal((await deposit(depositBody(actor))).status, 201);
    assertWalletRejection(await deposit(depositBody(actor)), 2, 60, actor);

    now = 70_000;
    // Rejected requests still consume the renewed client budget, ending at 130,000.
    for (const [limit, retryAfter] of [[2, 10], [2, 10], [3, 60], [3, 60]]) {
      assertWalletRejection(await deposit(depositBody(actor)), limit, retryAfter, actor);
    }
    assert.equal(walletRateLimit.walletRateLimitKeyCount(), 2);
    now = 80_000;
    assertWalletRejection(await deposit(depositBody(actor)), 3, 50, actor);
    now = 130_000;
    const recovered = await deposit(depositBody(actor));
    assert.equal(recovered.status, 201);
    assert.equal(recovered.headers.retryAfter, null);
  });

  test('quota retry ignores a later available actor window until its exact cap', async (t) => {
    let now = 10_000;
    t.mock.method(Date, 'now', () => now);
    config.walletRateLimit.maxPerActor = 3;
    config.walletRateLimit.maxPerClient = 2;
    const actor = 'wallet_exact_actor_cap';

    assert.equal((await deposit(depositBody('wallet_exact_cap_seed'))).status, 201);
    now = 20_000;
    const allowed = await deposit(depositBody(actor));
    assert.equal(allowed.status, 201);
    assert.deepEqual(allowed.headers, {
      limit: '2', remaining: '0', reset: '50', retryAfter: null,
    });
    // One actor slot remains, so its later deadline does not yet delay retries.
    assertWalletRejection(await deposit(depositBody(actor)), 2, 50, actor);
    // This rejected request fills that last slot without exceeding the actor cap.
    assertWalletRejection(await deposit(depositBody(actor)), 3, 60, actor);
    assert.equal(walletRateLimit.walletRateLimitKeyCount(), 3);
  });

  test('quota retry keeps actor ties and rounds up until the exact expiry boundary', async (t) => {
    let now = 10_000;
    t.mock.method(Date, 'now', () => now);
    config.walletRateLimit.maxPerActor = 2;
    config.walletRateLimit.maxPerClient = 3;
    const actor = 'wallet_equal_window';

    assert.equal((await deposit(depositBody(actor))).status, 201);
    assert.equal((await deposit(depositBody(actor))).status, 201);
    assertWalletRejection(await deposit(depositBody(actor)), 2, 60, actor);
    assertWalletRejection(await deposit(depositBody(actor)), 2, 60, actor);
    now = 68_999;
    assertWalletRejection(await deposit(depositBody(actor)), 2, 2, actor);
    now = 69_999;
    assertWalletRejection(await deposit(depositBody(actor)), 2, 1, actor);
    now = 70_000;
    const recovered = await deposit(depositBody(actor));
    assert.equal(recovered.status, 201);
    assert.deepEqual(recovered.headers, {
      limit: '2', remaining: '1', reset: '60', retryAfter: null,
    });
    assert.equal(walletRateLimit.walletRateLimitKeyCount(), 2);
  });

  test('identity isolation: one actor bursting does not block another actor', async () => {
    // Raise the shared-client cap so this assertion isolates actor buckets only.
    config.walletRateLimit.maxPerClient = 100;
    const noisy = 'wallet_noisy';
    const quiet = 'wallet_quiet';
    for (let i = 0; i < 6; i += 1) {
      await deposit(depositBody(noisy, 1), { 'X-Wallet-Address': noisy });
    }
    const ok = await deposit(depositBody(quiet, 1), { 'X-Wallet-Address': quiet });
    assert.equal(ok.status, 201, `quiet actor should still succeed, got ${ok.status}`);
  });

  test('client bucket bounds multi-actor spoofing from one client', async () => {
    const statuses = [];
    for (let i = 0; i < 10; i += 1) {
      const user = `wallet_spoof_${i}`;
      const res = await deposit(depositBody(user, 1), { 'X-Wallet-Address': user });
      statuses.push(res.status);
    }
    assert.ok(statuses.some((s) => s === 429), `expected client cap 429, got ${statuses}`);
    assert.ok(statuses.filter((s) => s === 201).length <= 8);
  });

  test('spoofed X-Forwarded-For does not split client buckets when trustProxy=false', async () => {
    config.trustProxy = false;
    const user = 'wallet_proxy_spoof';
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await deposit(depositBody(user, 1), {
        'X-Wallet-Address': user,
        'X-Forwarded-For': `198.51.100.${i}`,
      });
      statuses.push(res.status);
    }
    assert.ok(
      statuses.some((s) => s === 429),
      'spoofed forwarded IPs must not bypass per-actor/client limits'
    );
  });

  test('withdraw mutations share the same abuse controls', async () => {
    const user = 'wallet_withdraw';
    const withdraw = async () => {
      const res = await fetch(`${baseUrl}/api/positions/withdraw`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Wallet-Address': user,
        },
        body: JSON.stringify({ user, vaultId: 'vault_test_1', shares: 1 }),
      });
      return res.status;
    };

    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push(await withdraw());
    }
    assert.ok(statuses.slice(0, 5).every((s) => s === 201));
    assert.ok(statuses.some((s) => s === 429), `withdraw should 429, got ${statuses}`);
  });

  test('recovery: counters reset after the window elapses', async () => {
    config.walletRateLimit.windowMs = 80;
    config.walletRateLimit.maxPerActor = 2;
    config.walletRateLimit.maxPerClient = 10;
    walletRateLimit.resetWalletRateLimitStores();

    const user = 'wallet_recover';
    assert.equal((await deposit(depositBody(user), { 'X-Wallet-Address': user })).status, 201);
    assert.equal((await deposit(depositBody(user), { 'X-Wallet-Address': user })).status, 201);
    assert.equal((await deposit(depositBody(user), { 'X-Wallet-Address': user })).status, 429);

    await new Promise((r) => setTimeout(r, 100));
    const after = await deposit(depositBody(user), { 'X-Wallet-Address': user });
    assert.equal(after.status, 201);

    config.walletRateLimit.windowMs = 60_000;
    config.walletRateLimit.maxPerActor = 5;
    config.walletRateLimit.maxPerClient = 8;
  });

  test('capacity pressure preserves wallet quotas and recovers at window expiry', async (t) => {
    let now = 10_000;
    t.mock.method(Date, 'now', () => now);
    config.walletRateLimit.maxPerActor = 1;
    config.walletRateLimit.maxKeys = 3;

    const results = [];
    for (const user of ['wallet_one', 'wallet_one', 'wallet_two', 'wallet_new', 'wallet_one']) {
      results.push(await deposit(depositBody(user), { 'X-Wallet-Address': user }));
    }
    assert.deepEqual(results.map((result) => result.status), [201, 429, 201, 429, 429]);
    const capacity = results[3];
    assert.equal(capacity.body.error.message, 'Too many requests');
    assert.equal(capacity.body.error.details.code, 'RATE_LIMITED');
    assert.equal(capacity.headers.remaining, '0');
    assert.equal(capacity.headers.retryAfter, '60');
    assert.equal(capacity.headers.reset, '60');
    assert.equal(JSON.stringify(capacity.body).includes('wallet_new'), false);
    assert.equal(walletRateLimit.walletRateLimitKeyCount(), 3);

    now += 60_000;
    const recovered = await deposit(depositBody('wallet_new'), { 'X-Wallet-Address': 'wallet_new' });
    assert.equal(recovered.status, 201);
    assert.equal(walletRateLimit.walletRateLimitKeyCount(), 2);
  });

  test('wallet capacity reserves both keys without evicting or partially admitting a client', (t) => {
    let now = 10_000;
    t.mock.method(Date, 'now', () => now);
    const limiter = walletRateLimit({
      scope: 'capacity-pair', windowMs: 60_000, maxPerActor: 2, maxPerClient: 10, maxKeys: 3,
    });
    assert.equal(invokeLimiter(limiter, '192.0.2.1', 'wallet_one').status, 200);

    for (let i = 2; i < 22; i += 1) {
      const rejected = invokeLimiter(limiter, `192.0.2.${i}`, `wallet_new_${i}`);
      assert.equal(rejected.status, 429);
      assert.equal(rejected.headers['X-RateLimit-Remaining'], 0);
      assert.equal(rejected.headers['Retry-After'], 60);
      assert.equal(walletRateLimit.walletRateLimitKeyCount(), 2);
    }
    assert.equal(invokeLimiter(limiter, '192.0.2.1', 'wallet_one').status, 200);
    assert.equal(invokeLimiter(limiter, '192.0.2.1', 'wallet_one').status, 429);

    now += 60_000;
    assert.equal(invokeLimiter(limiter, '192.0.2.2', 'wallet_two').status, 200);
    assert.equal(walletRateLimit.walletRateLimitKeyCount(), 2);
  });

  test('rejected actor admission preserves an existing client budget', async (t) => {
    t.mock.method(Date, 'now', () => 10_000);
    config.walletRateLimit.maxKeys = 3;
    config.walletRateLimit.maxPerActor = 3;
    config.walletRateLimit.maxPerClient = 3;
    const statuses = [];
    for (const user of ['wallet_one', 'wallet_two', 'wallet_new', 'wallet_one', 'wallet_one']) {
      statuses.push((await deposit(depositBody(user), { 'X-Wallet-Address': user })).status);
    }
    assert.deepEqual(statuses, [201, 201, 429, 201, 429]);
    assert.equal(walletRateLimit.walletRateLimitKeyCount(), 3);
  });

  test('global capacity preserves exhausted clients and reopens after expiry', (t) => {
    let now = 10_000;
    t.mock.method(Date, 'now', () => now);
    const limiter = rateLimit({ windowMs: 60_000, max: 1, maxKeys: 2 });
    assert.equal(invokeLimiter(limiter, '192.0.2.1').status, 200);
    assert.equal(invokeLimiter(limiter, '192.0.2.1').status, 429);
    now += 10_000;
    assert.equal(invokeLimiter(limiter, '192.0.2.2').status, 200);
    const rejected = invokeLimiter(limiter, '192.0.2.3');
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers['X-RateLimit-Remaining'], 0);
    assert.equal(rejected.headers['Retry-After'], 50);
    assert.equal(rejected.headers['X-RateLimit-Reset'], 50);
    assert.equal(invokeLimiter(limiter, '192.0.2.1').status, 429);

    now += 50_000;
    assert.equal(invokeLimiter(limiter, '192.0.2.3').status, 200);
    assert.equal(invokeLimiter(limiter, '192.0.2.3').status, 429);
    const retained = invokeLimiter(limiter, '192.0.2.2');
    assert.equal(retained.status, 429);
    assert.equal(retained.headers['Retry-After'], 10);
  });

  test('a smaller runtime wallet cap preserves tracked identities until expiry', (t) => {
    let now = 10_000;
    t.mock.method(Date, 'now', () => now);
    config.walletRateLimit.maxKeys = 3;
    const limiter = walletRateLimit({ scope: 'capacity-reduced' });
    assert.equal(invokeLimiter(limiter, '192.0.2.1', 'wallet_one').status, 200);
    assert.equal(invokeLimiter(limiter, '192.0.2.1', 'wallet_two').status, 200);

    config.walletRateLimit.maxKeys = 2;
    assert.equal(invokeLimiter(limiter, '192.0.2.1', 'wallet_one').status, 200);
    assert.equal(invokeLimiter(limiter, '192.0.2.1', 'wallet_new').status, 429);
    assert.equal(walletRateLimit.walletRateLimitKeyCount(), 3);

    now += 60_000;
    assert.equal(invokeLimiter(limiter, '192.0.2.1', 'wallet_new').status, 200);
    assert.equal(walletRateLimit.walletRateLimitKeyCount(), 2);
  });

  test('an empty wallet store with fewer than two slots returns finite retry metadata', (t) => {
    t.mock.method(Date, 'now', () => 10_000);
    const limiter = walletRateLimit({ scope: 'capacity-too-small', maxKeys: 1, windowMs: 60_000 });
    const rejected = invokeLimiter(limiter, '192.0.2.1');
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers['X-RateLimit-Remaining'], 0);
    assert.equal(rejected.headers['Retry-After'], 60);
    assert.equal(walletRateLimit.walletRateLimitKeyCount(), 0);
  });

  test('bounded storage: abusive unique-key floods stay within maxKeys', async () => {
    config.walletRateLimit.maxKeys = 30;
    config.walletRateLimit.maxPerActor = 1000;
    config.walletRateLimit.maxPerClient = 1000;
    walletRateLimit.resetWalletRateLimitStores();

    const limiter = walletRateLimit({ scope: 'bound-test' });
    let nextCalls = 0;
    const next = () => {
      nextCalls += 1;
    };

    for (let i = 0; i < 200; i += 1) {
      const req = {
        get: (name) => (name === 'X-Wallet-Address' ? `wallet_flood_${i}` : undefined),
        body: { user: `wallet_flood_${i}` },
        socket: { remoteAddress: `203.0.113.${i % 250}` },
        ip: undefined,
      };
      const res = { setHeader() {} };
      limiter(req, res, next);
    }

    const keys = walletRateLimit.walletRateLimitKeyCount();
    assert.ok(keys <= 30, `expected <=30 keys, got ${keys}`);
    assert.ok(nextCalls > 0);
  });

  test('load burst: abusive deposit flood yields 429s and bounded key growth', async () => {
    config.walletRateLimit.maxPerActor = 3;
    config.walletRateLimit.maxPerClient = 5;
    config.walletRateLimit.maxKeys = 50;
    walletRateLimit.resetWalletRateLimitStores();

    const statuses = [];
    for (let i = 0; i < 40; i += 1) {
      const user = i % 2 === 0 ? 'wallet_load_a' : 'wallet_load_b';
      const res = await deposit(depositBody(user, 1), { 'X-Wallet-Address': user });
      statuses.push(res.status);
    }

    const ok = statuses.filter((s) => s === 201).length;
    const limited = statuses.filter((s) => s === 429).length;
    assert.ok(limited >= 20, `expected many 429s in burst, got ok=${ok} limited=${limited}`);
    assert.ok(
      walletRateLimit.walletRateLimitKeyCount() <= 50,
      'key count must remain bounded during burst'
    );
  });
});
