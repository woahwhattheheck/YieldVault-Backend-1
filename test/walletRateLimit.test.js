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
