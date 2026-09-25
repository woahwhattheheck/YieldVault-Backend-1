'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

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

function resetStore() {
  store.vaults.clear();
  store.positions.clear();
  store.transactions.clear();
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
    resetStore();
    seedPositions();
  });

  it('rejects position reads without X-Wallet-Address', async () => {
    const app = createApp();
    const res = await request(app, { path: '/api/positions/pos_owner' });
    assert.equal(res.status, 400);
  });

  it('owner can read their position; stranger gets identical 404', async () => {
    const app = createApp();
    const own = await request(app, {
      path: '/api/positions/pos_owner',
      headers: { 'X-Wallet-Address': 'wallet_owner' },
    });
    assert.equal(own.status, 200);
    assert.equal(own.body.position.user, 'wallet_owner');

    const strangerMissing = await request(app, {
      path: '/api/positions/pos_missing',
      headers: { 'X-Wallet-Address': 'wallet_owner' },
    });
    const strangerForeign = await request(app, {
      path: '/api/positions/pos_other',
      headers: { 'X-Wallet-Address': 'wallet_owner' },
    });
    assert.equal(strangerMissing.status, 404);
    assert.equal(strangerForeign.status, 404);
    assert.equal(strangerMissing.body.error.message, strangerForeign.body.error.message);
  });

  it('list endpoint scopes to the authenticated wallet', async () => {
    const app = createApp();
    const res = await request(app, {
      path: '/api/positions?user=wallet_other',
      headers: { 'X-Wallet-Address': 'wallet_owner' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 0);
    assert.deepEqual(res.body.positions, []);

    const mine = await request(app, {
      path: '/api/positions',
      headers: { 'X-Wallet-Address': 'wallet_owner' },
    });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.count, 1);
    assert.equal(mine.body.positions[0].user, 'wallet_owner');
  });

  it('operators may read any position via X-Audit-Role', async () => {
    const app = createApp();
    const res = await request(app, {
      path: '/api/positions/pos_other',
      headers: {
        'X-Wallet-Address': 'ops_admin',
        'X-Audit-Role': 'admin',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.position.user, 'wallet_other');
  });

  it('deposit body user spoofing is rejected over HTTP', async () => {
    const app = createApp();
    const res = await request(app, {
      method: 'POST',
      path: '/api/positions/deposit',
      headers: { 'X-Wallet-Address': 'wallet_owner' },
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
      headers: { 'X-Wallet-Address': 'wallet_owner' },
    });
    assert.equal(scoped.status, 200);
    assert.equal(scoped.body.count, 1);
    assert.equal(scoped.body.positions[0].user, 'wallet_owner');

    const asOps = await request(app, {
      path: '/api/vaults/vault_alpha/positions',
      headers: {
        'X-Wallet-Address': 'ops_admin',
        'X-Audit-Role': 'auditor',
      },
    });
    assert.equal(asOps.status, 200);
    assert.equal(asOps.body.count, 2);
  });
});
