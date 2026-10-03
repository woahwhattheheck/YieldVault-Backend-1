'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash, randomBytes } = require('node:crypto');

const readerTokens = Object.fromEntries(
  ['admin', 'auditor', 'viewer'].map((role) => [role, randomBytes(32).toString('base64url')])
);
const readerCredentials = Object.entries(readerTokens).map(([role, token]) => ({
  subject: `test-${role}`,
  role,
  tokenSha256: createHash('sha256').update(token).digest('hex'),
}));
process.env.AUDIT_READER_CREDENTIALS = JSON.stringify(readerCredentials);

const createApp = require('../src/app');
const store = require('../src/store');
const positionService = require('../src/services/positionService');
const auditService = require('../src/services/auditService');
const reconciliationService = require('../src/services/reconciliationService');
const { CODES } = reconciliationService;

function resetStore() {
  store.vaults.clear();
  store.positions.clear();
  store.transactions.clear();
  store.transactionStates.clear();
  if (store.auditEvents) store.auditEvents.clear();
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

function httpGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createApp());
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.request(
        { hostname: '127.0.0.1', port, path, method: 'GET', headers },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => {
            server.close();
            let body = raw;
            try {
              body = raw ? JSON.parse(raw) : {};
            } catch {
              // keep raw string
            }
            resolve({ status: res.statusCode, body, headers: res.headers });
          });
        }
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

beforeEach(resetStore);

test('clean ledger reports ok with zero findings', () => {
  const report = reconciliationService.generateReport();
  assert.equal(report.status, 'ok');
  assert.equal(report.repaired, false);
  assert.equal(report.findings.length, 0);
  assert.equal(report.pagination.total, 0);
});

test('detects seeded share overallocation and missing vault refs without repairing', () => {
  store.positions.set('p_over', {
    id: 'p_over',
    user: 'alice',
    vaultId: 'vault_test',
    shares: 1500,
    principal: 1500,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.positions.set('p_orphan', {
    id: 'p_orphan',
    user: 'bob',
    vaultId: 'vault_gone',
    shares: 10,
    principal: 10,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const report = reconciliationService.generateReport();
  assert.equal(report.status, 'mismatches_found');
  assert.equal(report.repaired, false);
  const codes = report.findings.map((f) => f.code).sort();
  assert.deepEqual(
    codes,
    [CODES.POSITION_VAULT_MISSING, CODES.SHARES_OVERALLOCATED].sort()
  );

  // Never repairs.
  assert.equal(store.positions.get('p_over').shares, 1500);
  assert.ok(store.positions.has('p_orphan'));
});

test('detects negative balances and fee range violations', () => {
  const vault = store.vaults.get('vault_test');
  vault.totalAssets = -5;
  vault.managementFeeBps = 20000;
  store.positions.set('p_neg', {
    id: 'p_neg',
    user: 'alice',
    vaultId: 'vault_test',
    shares: -1,
    principal: -2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const codes = new Set(reconciliationService.collectFindings().map((f) => f.code));
  assert.ok(codes.has(CODES.NEGATIVE_VAULT_ASSETS));
  assert.ok(codes.has(CODES.NEGATIVE_POSITION_SHARES));
  assert.ok(codes.has(CODES.NEGATIVE_POSITION_PRINCIPAL));
  assert.ok(codes.has(CODES.INVALID_FEE_BPS));
});

test('detects ledger/lifecycle status mismatches', () => {
  store.transactions.set('tx_1', {
    txHash: 'tx_1',
    user: 'alice',
    vaultId: 'vault_test',
    status: 'SUCCESS',
    amount: 10,
  });
  store.transactionStates.set('tx_1', {
    txHash: 'tx_1',
    vaultId: 'vault_test',
    status: 'failed',
  });

  const findings = reconciliationService.collectFindings();
  assert.ok(findings.some((f) => f.code === CODES.TX_LIFECYCLE_STATUS_MISMATCH));
});

test('bounds the report page and never sets repaired', () => {
  for (let i = 0; i < 5; i += 1) {
    store.positions.set(`p_${i}`, {
      id: `p_${i}`,
      user: `u${i}`,
      vaultId: 'missing',
      shares: 1,
      principal: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  const page = reconciliationService.generateReport({ limit: 2, offset: 0 });
  assert.equal(page.findings.length, 2);
  assert.equal(page.pagination.total, 5);
  assert.equal(page.pagination.hasMore, true);
  assert.equal(page.repaired, false);

  const next = reconciliationService.generateReport({ limit: 2, offset: 2 });
  assert.equal(next.findings.length, 2);
  assert.equal(next.pagination.hasMore, true);
});

test('rolls back partial deposit mutations when a later step throws', () => {
  const vaultBefore = { ...store.vaults.get('vault_test') };
  const originalRecord = auditService.record;
  auditService.record = () => {
    throw new Error('injected audit failure');
  };
  try {
    assert.throws(
      () =>
        positionService.deposit({
          user: 'alice',
          vaultId: 'vault_test',
          amount: 100,
          correlationId: 'corr-fail',
        }),
      /injected audit failure/
    );
  } finally {
    auditService.record = originalRecord;
  }

  const vaultAfter = store.vaults.get('vault_test');
  assert.equal(vaultAfter.totalAssets, vaultBefore.totalAssets);
  assert.equal(vaultAfter.totalShares, vaultBefore.totalShares);
  assert.equal(store.positions.size, 0);
  assert.equal(store.transactions.size, 0);
  assert.equal(store.transactionStates.size, 0);
});

test('successful deposit leaves invariants clean', () => {
  positionService.deposit({
    user: 'alice',
    vaultId: 'vault_test',
    amount: 100,
    correlationId: 'corr-ok',
  });
  const report = reconciliationService.generateReport();
  assert.equal(report.status, 'ok', JSON.stringify(report.findings, null, 2));
});

test('GET /api/reconciliation requires an authenticated audit reader', async () => {
  const denied = await httpGet('/api/reconciliation');
  assert.equal(denied.status, 401);

  const ok = await httpGet('/api/reconciliation', { Authorization: `Bearer ${readerTokens.auditor}` });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.repaired, false);
  assert.ok(['ok', 'mismatches_found'].includes(ok.body.status));
});

test('GET /api/reconciliation never mutates seeded corruption', async () => {
  store.positions.set('p_bad', {
    id: 'p_bad',
    user: 'alice',
    vaultId: 'vault_gone',
    shares: 9,
    principal: 9,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const res = await httpGet('/api/reconciliation?limit=10', {
    Authorization: `Bearer ${readerTokens.admin}`,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.repaired, false);
  assert.ok(res.body.findings.some((f) => f.code === CODES.POSITION_VAULT_MISSING));
  assert.ok(store.positions.has('p_bad'));
  assert.equal(store.positions.get('p_bad').shares, 9);
});

test('both report endpoints reject forged authority and enforce server-assigned reader roles', async () => {
  store.positions.set('synthetic-private-position', {
    id: 'synthetic-private-position', user: 'synthetic-private-actor',
    vaultId: 'missing', shares: 1, principal: 1,
  });
  auditService.record({ actor: 'synthetic-private-actor', action: 'synthetic-test', target: 'missing' });
  const cases = [
    { name: 'no credential', headers: {}, status: 401 },
    { name: 'forged admin role', headers: { 'X-Audit-Role': 'admin' }, status: 401 },
    { name: 'forged auditor role', headers: { 'X-Audit-Role': 'auditor' }, status: 401 },
    { name: 'malformed bearer', headers: { Authorization: 'Bearer short' }, status: 401 },
    { name: 'unknown bearer', headers: { Authorization: `Bearer ${randomBytes(32).toString('base64url')}` }, status: 401 },
    { name: 'digest is not credential', headers: { Authorization: `Bearer ${readerCredentials[0].tokenSha256}` }, status: 401 },
    { name: 'valid admin', headers: { Authorization: `Bearer ${readerTokens.admin}` }, status: 200 },
    { name: 'valid auditor', headers: { Authorization: `Bearer ${readerTokens.auditor}` }, status: 200 },
    { name: 'server-assigned viewer', headers: { Authorization: `Bearer ${readerTokens.viewer}` }, status: 403 },
    { name: 'viewer forging admin', headers: { Authorization: `Bearer ${readerTokens.viewer}`, 'X-Audit-Role': 'admin' }, status: 403 },
  ];
  for (const path of ['/api/reconciliation', '/api/audit']) {
    for (const entry of cases) {
      const response = await httpGet(path, entry.headers);
      assert.equal(response.status, entry.status, `${path}: ${entry.name}`);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      if (entry.status === 401) assert.match(response.headers['www-authenticate'], /^Bearer /);
      assert.equal(JSON.stringify(response.body).includes('synthetic-private-actor'), entry.status === 200);
    }
  }
  assert.equal(store.positions.get('synthetic-private-position').shares, 1);
  assert.equal(store.auditEvents.size, 1);
});
