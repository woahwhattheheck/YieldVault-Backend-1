'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash, randomBytes } = require('node:crypto');

const config = require('../src/config');
const store = require('../src/store');
const positionService = require('../src/services/positionService');
const {
  assertPositionAccess,
  resolveActingUser,
  resolveListScope,
  POSITION_NOT_FOUND,
} = require('../src/auth/positionAccess');
const { AppError } = require('../src/utils/errors');
const createApp = require('../src/app');

const originalCredentials = config.positionCredentials;
const tokens = Object.fromEntries(
  ['owner', 'other', 'admin', 'auditor'].map((name) => [name, randomBytes(32).toString('base64url')])
);
const credentials = Object.freeze([
  ['owner', 'wallet_owner', 'user'], ['other', 'wallet_other', 'user'],
  ['admin', 'ops_admin', 'admin'], ['auditor', 'ops_auditor', 'auditor'],
].map(([name, subject, role]) => Object.freeze({
  subject, role, tokenSha256: createHash('sha256').update(tokens[name]).digest('hex'),
})));

function authHeaders(name, headers = {}) {
  return { Authorization: `Bearer ${tokens[name]}`, ...headers };
}

function snapshotStore() {
  return structuredClone(Object.fromEntries(
    Object.entries(store).filter(([, value]) => value instanceof Map)
      .map(([name, value]) => [name, [...value.entries()]])
  ));
}

function resetStore() {
  store.vaults.clear();
  store.positions.clear();
  store.transactions.clear();
  store.transactionStates.clear();
  if (store.auditEvents) store.auditEvents.clear();
  store.vaults.set('vault_alpha', {
    id: 'vault_alpha',
    name: 'Alpha',
    asset: 'USDC',
    apy: 0.05,
    totalAssets: 10_000,
    totalShares: 10_000,
    createdAt: Date.now(),
    lastAccruedAt: Date.now(),
  });
}

function seedPositions() {
  const now = Date.now();
  store.positions.set('pos_owner', {
    id: 'pos_owner',
    user: 'wallet_owner',
    vaultId: 'vault_alpha',
    shares: 100,
    principal: 100,
    createdAt: now,
    updatedAt: now,
  });
  store.positions.set('pos_other', {
    id: 'pos_other',
    user: 'wallet_other',
    vaultId: 'vault_alpha',
    shares: 50,
    principal: 50,
    createdAt: now,
    updatedAt: now,
  });
}

function request(app, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const raw = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = raw ? JSON.parse(raw) : null;
            } catch {
              json = raw;
            }
            resolve({ status: res.statusCode, body: json, headers: res.headers });
          });
        }
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe('position ownership policy (#65)', () => {
  beforeEach(() => {
    resetStore();
    seedPositions();
  });

  it('resolveActingUser prefers the authenticated actor over a spoofed body user', () => {
    assert.equal(
      resolveActingUser({ user: 'wallet_owner', actor: 'wallet_owner' }),
      'wallet_owner'
    );
    assert.throws(
      () => resolveActingUser({ user: 'wallet_other', actor: 'wallet_owner' }),
      (err) => err instanceof AppError && err.statusCode === 403
    );
    assert.equal(
      resolveActingUser({ user: 'wallet_other', actor: 'ops_admin', isOperator: true }),
      'wallet_other'
    );
  });

  it('assertPositionAccess returns identical 404 for missing and cross-wallet ids', () => {
    const owned = store.positions.get('pos_owner');
    assert.equal(
      assertPositionAccess(owned, { actor: 'wallet_owner' }).id,
      'pos_owner'
    );

    let missingErr;
    let foreignErr;
    try {
      assertPositionAccess(null, { actor: 'wallet_owner' });
    } catch (err) {
      missingErr = err;
    }
    try {
      assertPositionAccess(store.positions.get('pos_other'), { actor: 'wallet_owner' });
    } catch (err) {
      foreignErr = err;
    }
    assert.equal(missingErr.statusCode, 404);
    assert.equal(foreignErr.statusCode, 404);
    assert.equal(missingErr.message, foreignErr.message);
    assert.equal(missingErr.message, POSITION_NOT_FOUND);
  });

  it('operators may inspect any position while unprivileged callers cannot', () => {
    const foreign = store.positions.get('pos_other');
    assert.equal(
      assertPositionAccess(foreign, { actor: 'ops_admin', isOperator: true }).id,
      'pos_other'
    );
    assert.throws(
      () => assertPositionAccess(foreign, { actor: 'wallet_owner' }),
      (err) => err.statusCode === 404
    );
  });

  it('resolveListScope scopes non-operators to themselves and empties cross-wallet filters', () => {
    assert.deepEqual(resolveListScope(undefined, { actor: 'wallet_owner' }), {
      filter: 'wallet_owner',
      empty: false,
    });
    assert.deepEqual(resolveListScope('wallet_other', { actor: 'wallet_owner' }), {
      filter: 'wallet_owner',
      empty: true,
    });
    assert.deepEqual(resolveListScope('wallet_other', { actor: 'ops', isOperator: true }), {
      filter: 'wallet_other',
      empty: false,
    });
  });

  it('getPosition enforces ownership at the service boundary', () => {
    const own = positionService.getPosition('pos_owner', { actor: 'wallet_owner' });
    assert.equal(own.user, 'wallet_owner');

    assert.throws(
      () => positionService.getPosition('pos_other', { actor: 'wallet_owner' }),
      (err) => err.statusCode === 404 && err.message === POSITION_NOT_FOUND
    );
    assert.throws(
      () => positionService.getPosition('pos_missing', { actor: 'wallet_owner' }),
      (err) => err.statusCode === 404 && err.message === POSITION_NOT_FOUND
    );

    const asOps = positionService.getPosition('pos_other', {
      actor: 'ops_admin',
      isOperator: true,
    });
    assert.equal(asOps.user, 'wallet_other');
  });

  it('listPositions never returns another wallet\'s rows for a non-operator', () => {
    const mine = positionService.listPositions(undefined, { actor: 'wallet_owner' });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].user, 'wallet_owner');

    const spoofed = positionService.listPositions('wallet_other', { actor: 'wallet_owner' });
    assert.deepEqual(spoofed, []);

    const asOps = positionService.listPositions(undefined, {
      actor: 'ops_admin',
      isOperator: true,
    });
    assert.equal(asOps.length, 2);
  });

  it('listByVault hides foreign positions unless the caller is an operator', () => {
    const mine = positionService.listByVault('vault_alpha', { actor: 'wallet_owner' });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].id, 'pos_owner');

    const asOps = positionService.listByVault('vault_alpha', {
      actor: 'ops_admin',
      isOperator: true,
    });
    assert.equal(asOps.length, 2);
  });

  it('deposit and withdraw refuse body.user spoofing for non-operators', () => {
    assert.throws(
      () =>
        positionService.deposit({
          user: 'wallet_other',
          vaultId: 'vault_alpha',
          amount: 10,
          actor: 'wallet_owner',
        }),
      (err) => err.statusCode === 403
    );

    const ok = positionService.deposit({
      user: 'wallet_owner',
      vaultId: 'vault_alpha',
      amount: 10,
      actor: 'wallet_owner',
      correlationId: 'c-dep',
    });
    assert.equal(ok.position.user, 'wallet_owner');

    assert.throws(
      () =>
        positionService.withdraw({
          user: 'wallet_other',
          vaultId: 'vault_alpha',
          shares: 1,
          actor: 'wallet_owner',
        }),
      (err) => err.statusCode === 403
    );
  });

  it('malformed position ids fail closed as not found', () => {
    for (const id of ['', '@@@', 'pos_owner/../x', 'a'.repeat(200)]) {
      assert.throws(
        () => positionService.getPosition(id, { actor: 'wallet_owner' }),
        (err) => err.statusCode === 404
      );
    }
  });
});

describe('position ownership HTTP surface (#65)', () => {
  beforeEach(() => {
    config.positionCredentials = credentials;
    resetStore();
    seedPositions();
  });

  afterEach(() => {
    config.positionCredentials = originalCredentials;
  });

  it('rejects position reads without a server-provisioned credential', async () => {
    const app = createApp();
    const res = await request(app, { path: '/api/positions/pos_owner' });
    assert.equal(res.status, 401);
    assert.equal(res.headers['www-authenticate'], 'Bearer realm="yieldvault-positions"');
    assert.equal(res.headers['cache-control'], 'private, no-store');
  });

  it('owner can read their position; stranger gets identical 404', async () => {
    const app = createApp();
    const own = await request(app, {
      path: '/api/positions/pos_owner',
      headers: authHeaders('owner'),
    });
    assert.equal(own.status, 200);
    assert.equal(own.body.position.user, 'wallet_owner');

    const strangerMissing = await request(app, {
      path: '/api/positions/pos_missing',
      headers: authHeaders('owner'),
    });
    const strangerForeign = await request(app, {
      path: '/api/positions/pos_other',
      headers: authHeaders('owner'),
    });
    assert.equal(strangerMissing.status, 404);
    assert.equal(strangerForeign.status, 404);
    assert.equal(strangerMissing.body.error.message, strangerForeign.body.error.message);
  });

  it('list endpoint scopes to the authenticated wallet', async () => {
    const app = createApp();
    const res = await request(app, {
      path: '/api/positions?user=wallet_other',
      headers: authHeaders('owner'),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 0);
    assert.deepEqual(res.body.positions, []);

    const mine = await request(app, {
      path: '/api/positions',
      headers: authHeaders('owner'),
    });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.count, 1);
    assert.equal(mine.body.positions[0].user, 'wallet_owner');
  });

  it('server-provisioned operators may read any position', async () => {
    const app = createApp();
    const res = await request(app, {
      path: '/api/positions/pos_other',
      headers: authHeaders('admin'),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.position.user, 'wallet_other');
  });

  it('deposit body user spoofing is rejected over HTTP', async () => {
    const app = createApp();
    const res = await request(app, {
      method: 'POST',
      path: '/api/positions/deposit',
      headers: authHeaders('owner'),
      body: {
        user: 'wallet_other',
        vaultId: 'vault_alpha',
        amount: 25,
        idempotencyKey: 'idem-spoof-001',
      },
    });
    assert.equal(res.status, 403);
  });

  it('vault position listing is scoped to the caller unless operator', async () => {
    const app = createApp();
    const scoped = await request(app, {
      path: '/api/vaults/vault_alpha/positions',
      headers: authHeaders('owner'),
    });
    assert.equal(scoped.status, 200);
    assert.equal(scoped.body.count, 1);
    assert.equal(scoped.body.positions[0].user, 'wallet_owner');

    const asOps = await request(app, {
      path: '/api/vaults/vault_alpha/positions',
      headers: authHeaders('auditor'),
    });
    assert.equal(asOps.status, 200);
    assert.equal(asOps.body.count, 2);
  });

  it('caller-selected wallet and operator headers cannot authenticate any position read', async () => {
    const app = createApp();
    const before = snapshotStore();
    for (const headers of [
      { 'X-Wallet-Address': 'wallet_other' },
      { 'X-Wallet-Address': 'wallet_owner', 'X-Audit-Role': 'admin' },
    ]) {
      for (const path of [
        '/api/positions', '/api/positions/pos_other', '/api/positions/pos_missing',
        '/api/positions/summary?user=wallet_other', '/api/vaults/vault_alpha/positions',
      ]) {
        const res = await request(app, { path, headers });
        assert.equal(res.status, 401, path);
        assert.equal(res.body.error.message, 'Authentication is required to access positions');
        assert.equal(res.headers['www-authenticate'], 'Bearer realm="yieldvault-positions"');
        assert.equal(res.headers['cache-control'], 'private, no-store');
      }
    }
    assert.deepEqual(snapshotStore(), before);
  });

  it('unverified wallet or operator headers cannot reach either mutation service', async () => {
    const app = createApp();
    const before = snapshotStore();
    for (const headers of [
      { 'X-Wallet-Address': 'wallet_other' },
      { 'X-Wallet-Address': 'wallet_owner', 'X-Audit-Role': 'admin' },
    ]) {
      for (const [operation, amount] of [['deposit', { amount: 25 }], ['withdraw', { shares: 1 }]]) {
        const res = await request(app, {
          method: 'POST', path: `/api/positions/${operation}`, headers,
          body: { user: 'wallet_other', vaultId: 'vault_alpha', ...amount,
            idempotencyKey: `unverified-${operation}` },
        });
        assert.equal(res.status, 401, operation);
        assert.deepEqual(snapshotStore(), before);
      }
    }
  });

  it('invalid credentials cannot fall back to caller-selected headers', async () => {
    const app = createApp();
    const before = snapshotStore();
    for (const authorization of [
      'Bearer short', `Basic ${tokens.admin}`, `Bearer ${'X'.repeat(43)}`,
      `Bearer ${tokens.admin}, Bearer ${tokens.owner}`,
    ]) {
      const res = await request(app, {
        path: '/api/positions/pos_other',
        headers: { Authorization: authorization, 'X-Wallet-Address': 'wallet_other',
          'X-Audit-Role': 'admin' },
      });
      assert.equal(res.status, 401);
      assert.equal(res.headers['cache-control'], 'private, no-store');
    }
    assert.deepEqual(snapshotStore(), before);
  });

  it('verified identity and role win over spoofed headers on every read path', async () => {
    const app = createApp();
    const headers = authHeaders('owner', {
      'X-Wallet-Address': 'wallet_other', 'X-Audit-Role': 'admin',
    });
    const own = await request(app, { path: '/api/positions/pos_owner', headers });
    assert.equal(own.status, 200);
    assert.equal(own.body.position.user, 'wallet_owner');
    const foreign = await request(app, { path: '/api/positions/pos_other', headers });
    const missing = await request(app, { path: '/api/positions/pos_missing', headers });
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, missing.body);
    const list = await request(app, { path: '/api/positions', headers });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.positions.map((p) => p.user), ['wallet_owner']);
    const summary = await request(app, { path: '/api/positions/summary?user=wallet_other', headers });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.summary.positionCount, 0);
    const vault = await request(app, { path: '/api/vaults/vault_alpha/positions', headers });
    assert.equal(vault.status, 200);
    assert.deepEqual(vault.body.positions.map((p) => p.user), ['wallet_owner']);
    for (const res of [own, foreign, missing, list, summary, vault]) {
      assert.equal(res.headers['cache-control'], 'private, no-store');
    }
  });

  it('verified ordinary users cannot elevate mutations through wallet or role headers', async () => {
    const app = createApp();
    const before = snapshotStore();
    for (const [operation, amount] of [['deposit', { amount: 25 }], ['withdraw', { shares: 1 }]]) {
      const res = await request(app, {
        method: 'POST', path: `/api/positions/${operation}`,
        headers: authHeaders('owner', { 'X-Wallet-Address': 'wallet_other', 'X-Audit-Role': 'admin' }),
        body: { user: 'wallet_other', vaultId: 'vault_alpha', ...amount,
          idempotencyKey: `verified-spoof-${operation}` },
      });
      assert.equal(res.status, 403);
      assert.deepEqual(snapshotStore(), before);
    }
  });

  it('an empty credential registry denies even known tokens before body validation', async () => {
    config.positionCredentials = Object.freeze([]);
    const app = createApp();
    const before = snapshotStore();
    for (const name of ['owner', 'admin']) {
      const res = await request(app, {
        method: 'POST', path: '/api/positions/withdraw', headers: authHeaders(name), body: {},
      });
      assert.equal(res.status, 401);
      assert.equal(res.headers['www-authenticate'], 'Bearer realm="yieldvault-positions"');
    }
    assert.deepEqual(snapshotStore(), before);
    const publicVaults = await request(app, { path: '/api/vaults' });
    assert.equal(publicVaults.status, 200);
  });
});
