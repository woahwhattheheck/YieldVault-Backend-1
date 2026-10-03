'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');

const readerTokens = Object.fromEntries(
  ['admin', 'auditor', 'viewer'].map((role) => [role, randomBytes(32).toString('base64url')])
);
process.env.AUDIT_READER_CREDENTIALS = JSON.stringify(Object.entries(readerTokens).map(([role, token]) => ({
  subject: `test-${role}`,
  role,
  tokenSha256: createHash('sha256').update(token).digest('hex'),
})));

const store = require('../src/store');
const positionService = require('../src/services/positionService');
const auditService = require('../src/services/auditService');
const requireAuditRole = require('../src/middleware/requireAuditRole');

function seedVault() {
  store.vaults.clear();
  store.positions.clear();
  store.transactions.clear();
  store.auditEvents.clear();
  store.vaults.set('vault_test', {
    id: 'vault_test',
    name: 'Test Vault',
    asset: 'USDC',
    apy: 0,
    totalAssets: 1000,
    totalShares: 1000,
    createdAt: Date.now(),
    lastAccruedAt: Date.now(),
  });
}

function nextCapture() {
  let error;
  const next = (value) => { error = value; };
  next.error = () => error;
  return next;
}

function authResponse() {
  return { setHeader() {} };
}

test.beforeEach(seedVault);

test('deposit emits exactly one event after the position and vault transition', () => {
  const result = positionService.deposit({
    user: 'operator_a',
    vaultId: 'vault_test',
    amount: 100,
    correlationId: 'req-deposit-1',
  });
  assert.equal(result.position.shares, 100);
  assert.equal(store.auditEvents.size, 1);
  const event = Array.from(store.auditEvents.values())[0];
  assert.equal(event.action, 'vault.deposit');
  assert.equal(event.actor, 'operator_a');
  assert.equal(event.target, 'vault_test');
  assert.equal(event.correlationId, 'req-deposit-1');
  assert.equal(event.outcome, 'success');
  assert.equal(event.before.totalAssets, 1000);
  assert.equal(event.after.totalAssets, 1100);
  assert.equal(event.after.totalShares, 1100);
});

test('partial withdrawal emits one event with before and after share totals', () => {
  positionService.deposit({ user: 'operator_a', vaultId: 'vault_test', amount: 100, correlationId: 'req-1' });
  store.auditEvents.clear();
  const result = positionService.withdraw({
    user: 'operator_a',
    vaultId: 'vault_test',
    shares: 40,
    correlationId: 'req-withdraw-1',
  });
  assert.equal(result.position.shares, 60);
  assert.equal(store.auditEvents.size, 1);
  const event = Array.from(store.auditEvents.values())[0];
  assert.equal(event.action, 'vault.withdraw');
  assert.equal(event.before.shares, 100);
  assert.equal(event.after.shares, 60);
  assert.equal(event.after.assets, 40);
});

test('full withdrawal emits one event and removes the position', () => {
  positionService.deposit({ user: 'operator_a', vaultId: 'vault_test', amount: 100, correlationId: 'req-1' });
  store.auditEvents.clear();
  const result = positionService.withdraw({
    user: 'operator_a',
    vaultId: 'vault_test',
    shares: 100,
    correlationId: 'req-withdraw-full',
  });
  assert.equal(result.position, null);
  assert.equal(store.positions.size, 0);
  assert.equal(store.auditEvents.size, 1);
  assert.equal(Array.from(store.auditEvents.values())[0].after.shares, 0);
});

test('failed withdrawals do not emit a misleading success event', () => {
  assert.throws(() => positionService.withdraw({
    user: 'missing',
    vaultId: 'vault_test',
    shares: 1,
    correlationId: 'req-failed',
  }), /No position found/);
  assert.equal(store.auditEvents.size, 0);
});

test('audit listing applies all filters and bounded pagination', () => {
  auditService.record({ actor: 'a', action: 'one', target: 'vault_test', correlationId: 'r1' });
  auditService.record({ actor: 'a', action: 'two', target: 'vault_other', correlationId: 'r2' });
  auditService.record({ actor: 'b', action: 'three', target: 'vault_test', correlationId: 'r3' });
  const result = auditService.list({ actor: 'a', target: 'vault_test', correlationId: 'r1', limit: 1, offset: 0 });
  assert.equal(result.data.length, 1);
  assert.equal(result.pagination.total, 1);
  assert.equal(result.pagination.hasMore, false);
});

test('audit list caps abusive page sizes', () => {
  const result = auditService.list({ limit: 100000, offset: -10 });
  assert.equal(result.pagination.limit, 100);
  assert.equal(result.pagination.offset, 0);
});

test('audit redaction protects nested credential fields and bounds text', () => {
  const event = auditService.record({
    actor: 'a',
    action: 'vault.configure',
    target: 'vault_test',
    correlationId: 'r',
    before: { apiToken: 'secret' },
    after: { nested: { password: 'secret' }, note: 'x'.repeat(400) },
  });
  assert.equal(event.after.nested.password, '[REDACTED]');
  assert.equal(event.after.note.length, 256);
});

test('audit role middleware denies unauthenticated reads', () => {
  const req = { get: (name) => name === 'X-Audit-Role' ? 'admin' : undefined };
  const next = nextCapture();
  requireAuditRole(req, authResponse(), next);
  assert.equal(next.error().statusCode, 401);
  assert.equal(req.auditPrincipal, undefined);
});

test('audit role middleware takes reader identity and role only from verified credentials', () => {
  for (const role of ['admin', 'auditor']) {
    const req = {
      get: (name) => name === 'Authorization' ? `Bearer ${readerTokens[role]}` : 'forged-subject',
    };
    const next = nextCapture();
    requireAuditRole(req, authResponse(), next);
    assert.equal(next.error(), undefined);
    assert.deepEqual(req.auditPrincipal, { subject: `test-${role}`, role });
    assert.equal(Object.isFrozen(req.auditPrincipal), true);
  }
  const next = nextCapture();
  const viewer = {
    get: (name) => name === 'Authorization' ? `Bearer ${readerTokens.viewer}` : 'admin',
  };
  requireAuditRole(viewer, authResponse(), next);
  assert.equal(next.error().statusCode, 403);
  assert.equal(viewer.auditPrincipal, undefined);
});

test('audit events preserve schema version across different actions', () => {
  for (const action of ['vault.deposit', 'vault.withdraw', 'vault.configure', 'vault.pause']) {
    auditService.record({ actor: 'a', action, target: 'vault_test', correlationId: action });
  }
  assert.deepEqual(
    Array.from(store.auditEvents.values()).map((event) => event.version),
    [1, 1, 1, 1]
  );
});
