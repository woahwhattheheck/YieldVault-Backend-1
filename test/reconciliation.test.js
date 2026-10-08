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

test('vault-filtered checked counts match the filtered scan scope', () => {
  store.vaults.set('vault_other', {
    id: 'vault_other', totalAssets: 10, totalShares: 10,
  });
  store.positions.set('p_test', {
    id: 'p_test', user: 'alice', vaultId: 'vault_test', shares: 1, principal: 1,
  });
  store.positions.set('p_other', {
    id: 'p_other', user: 'bob', vaultId: 'vault_other', shares: 1, principal: 1,
  });
  store.transactions.set('tx_test', {
    txHash: 'tx_test', vaultId: 'vault_test', status: 'confirmed',
  });
  store.transactionStates.set('tx_test', {
    txHash: 'tx_test', vaultId: 'vault_test', status: 'confirmed',
  });
  store.transactions.set('tx_other', {
    txHash: 'tx_other', vaultId: 'vault_other', status: 'confirmed',
  });
  store.transactionStates.set('tx_other', {
    txHash: 'tx_other', vaultId: 'vault_other', status: 'confirmed',
  });

  const report = reconciliationService.generateReport({ vaultId: 'vault_other' });
  assert.deepEqual(report.checked, {
    vaults: 1,
    positions: 1,
    transactions: 1,
    transactionStates: 1,
  });
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

for (const [collection, entityType, field, code] of [
  ['vaults', 'vault', 'totalAssets', 'INVALID_VAULT_ASSETS'],
  ['vaults', 'vault', 'totalShares', 'INVALID_VAULT_SHARES'],
  ['positions', 'position', 'shares', 'INVALID_POSITION_SHARES'],
  ['positions', 'position', 'principal', 'INVALID_POSITION_PRINCIPAL'],
]) {
  test(`HTTP reconciliation identifies invalid ${entityType}.${field} without repair`, async () => {
    const id = entityType === 'vault' ? 'vault_test' : 'position_test';
    for (const value of [NaN, Infinity, -Infinity, undefined, null, '10', true]) {
      resetStore();
      store.positions.set('position_test', {
        id: 'position_test', user: 'alice', vaultId: 'vault_test', shares: 10, principal: 10,
      });
      const entity = store[collection].get(id);
      entity[field] = value;

      const response = await httpGet('/api/reconciliation', {
        Authorization: `Bearer ${readerTokens.auditor}`,
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'mismatches_found');
      assert.equal(response.body.repaired, false);
      const invalid = response.body.findings.find((entry) => entry.code === code);
      assert.ok(invalid, `${field}: missing ${code} for ${String(value)}`);
      assert.equal(invalid.id, `${code}:${entityType}:${id}`);
      assert.equal(invalid.severity, 'error');
      assert.match(invalid.detail, new RegExp(field));
      assert.equal(response.body.findings.some((entry) => entry.code === CODES.SHARES_OVERALLOCATED), false);
      assert.ok(Object.is(entity[field], value), 'reconciliation must preserve the invalid stored value');
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
  });
}

test('invalid share inputs do not hide independent overallocation findings', () => {
  store.positions.set('p_invalid', {
    id: 'p_invalid', user: 'alice', vaultId: 'vault_test', shares: NaN, principal: 10,
  });
  store.positions.set('p_partial', {
    id: 'p_partial', user: 'alice', vaultId: 'vault_test', shares: 2000, principal: 10,
  });
  store.vaults.set('vault_other', { id: 'vault_other', totalAssets: 10, totalShares: 10 });
  store.positions.set('p_other', {
    id: 'p_other', user: 'bob', vaultId: 'vault_other', shares: 11, principal: 11,
  });

  const findings = reconciliationService.collectFindings();
  assert.ok(findings.some((entry) => entry.code === 'INVALID_POSITION_SHARES' && entry.entityId === 'p_invalid'));
  assert.deepEqual(
    findings.filter((entry) => entry.code === CODES.SHARES_OVERALLOCATED).map((entry) => entry.entityId),
    ['vault_other']
  );
  const filtered = reconciliationService.generateReport({ vaultId: 'vault_other' });
  assert.equal(filtered.findings.length, 1);
  assert.equal(filtered.findings[0].code, CODES.SHARES_OVERALLOCATED);
});

test('invalid numeric findings retain bounded stable pagination', async () => {
  const vault = store.vaults.get('vault_test');
  vault.totalAssets = NaN;
  vault.totalShares = Infinity;
  store.positions.set('p_invalid', {
    id: 'p_invalid', user: 'alice', vaultId: 'vault_test', shares: null, principal: 'invalid',
  });
  const pages = [];
  for (const offset of [0, 2]) {
    const response = await httpGet(`/api/reconciliation?limit=2&offset=${offset}`, {
      Authorization: `Bearer ${readerTokens.admin}`,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.repaired, false);
    assert.equal(response.body.findings.length, 2);
    assert.equal(response.body.pagination.total, 4);
    assert.equal(response.body.pagination.hasMore, offset === 0);
    pages.push(...response.body.findings.map((entry) => entry.id));
  }
  assert.equal(new Set(pages).size, 4);
  assert.ok(Number.isNaN(vault.totalAssets));
  assert.equal(vault.totalShares, Infinity);
});

test('finite zero and fractional balances remain valid and negatives keep their existing codes', () => {
  const vault = store.vaults.get('vault_test');
  const position = { id: 'p_valid', user: 'alice', vaultId: 'vault_test', shares: 0, principal: 0 };
  store.positions.set(position.id, position);
  for (const amount of [0, 0.125]) {
    vault.totalAssets = amount;
    vault.totalShares = amount;
    position.shares = amount;
    position.principal = amount;
    assert.equal(reconciliationService.generateReport().status, 'ok');
  }
  vault.totalAssets = -1;
  vault.totalShares = -1;
  position.shares = -1;
  position.principal = -1;
  assert.deepEqual(new Set(reconciliationService.collectFindings().map((entry) => entry.code)), new Set([
    CODES.NEGATIVE_VAULT_ASSETS, CODES.NEGATIVE_VAULT_SHARES,
    CODES.NEGATIVE_POSITION_SHARES, CODES.NEGATIVE_POSITION_PRINCIPAL,
  ]));
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

test('uses store keys as actionable vault and position identities when embedded ids drift', () => {
  const vault = store.vaults.get('vault_test');
  vault.id = 'vault_embedded_wrong';
  vault.totalAssets = NaN;
  store.positions.set('position_store_key', {
    id: 'position_embedded_wrong',
    user: 'alice',
    vaultId: 'vault_test',
    shares: NaN,
    principal: 1,
  });

  const report = reconciliationService.generateReport({ vaultId: 'vault_test' });

  assert.ok(report.findings.some((entry) =>
    entry.code === CODES.INVALID_VAULT_IDENTITY &&
    entry.entityId === 'vault_test' &&
    entry.related.storedId === 'vault_embedded_wrong'
  ));
  assert.ok(report.findings.some((entry) =>
    entry.code === CODES.INVALID_POSITION_IDENTITY &&
    entry.entityId === 'position_store_key' &&
    entry.related.storedId === 'position_embedded_wrong'
  ));
  assert.ok(report.findings.some((entry) =>
    entry.code === CODES.INVALID_VAULT_ASSETS &&
    entry.entityId === 'vault_test'
  ));
  assert.ok(report.findings.some((entry) =>
    entry.code === CODES.INVALID_POSITION_SHARES &&
    entry.entityId === 'position_store_key'
  ));
  assert.equal(report.checked.vaults, 1);
  assert.equal(
    report.findings.some((entry) => entry.entityId === undefined || entry.entityId === 'undefined'),
    false
  );
});

test('uses store keys as actionable transaction identities when embedded hashes drift', () => {
  store.transactions.set('tx_store_key', {
    txHash: 'tx_wrong',
    user: 'alice',
    vaultId: 'vault_test',
    status: 'SUCCESS',
    amount: 10,
  });
  store.transactionStates.set('tx_store_key', {
    txHash: 'tx_wrong_lifecycle',
    vaultId: 'vault_test',
    status: 'failed',
  });
  // A decoy lifecycle row keyed by the corrupt embedded transaction hash must
  // not hide the status mismatch for the actual stored transaction.
  store.transactionStates.set('tx_wrong', {
    txHash: 'tx_wrong',
    vaultId: 'vault_test',
    status: 'confirmed',
  });
  store.transactions.set('tx_missing_hash', {
    user: 'bob',
    vaultId: 'vault_test',
    status: 'SUCCESS',
    amount: 5,
  });
  store.transactionStates.set('tx_missing_hash', {
    txHash: 'tx_missing_hash',
    vaultId: 'vault_test',
    status: 'confirmed',
  });

  const findings = reconciliationService.collectFindings();

  assert.ok(findings.some((entry) =>
    entry.code === CODES.INVALID_TX_IDENTITY &&
    entry.entityId === 'tx_store_key' &&
    entry.related.storedTxHash === 'tx_wrong'
  ));
  assert.ok(findings.some((entry) =>
    entry.code === CODES.INVALID_LIFECYCLE_IDENTITY &&
    entry.entityId === 'tx_store_key' &&
    entry.related.storedTxHash === 'tx_wrong_lifecycle'
  ));
  assert.ok(findings.some((entry) =>
    entry.code === CODES.TX_LIFECYCLE_STATUS_MISMATCH &&
    entry.entityId === 'tx_store_key'
  ));
  assert.ok(findings.some((entry) =>
    entry.code === CODES.INVALID_TX_IDENTITY &&
    entry.entityId === 'tx_missing_hash' &&
    entry.related.storedTxHash === null
  ));
  assert.equal(findings.some((entry) => entry.entityId === undefined || entry.entityId === 'undefined'), false);
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

test('rolls back local accounting but preserves provider recovery evidence after a later failure', () => {
  const stellarService = require('../src/services/stellarService');
  const vaultBefore = { ...store.vaults.get('vault_test') };
  const originalRecord = auditService.record;
  const originalSubmit = stellarService.submitInvocation;
  let providerCalls = 0;
  stellarService.submitInvocation = (...args) => {
    providerCalls += 1;
    return originalSubmit(...args);
  };
  auditService.record = () => {
    throw new Error('injected audit failure');
  };
  const request = {
    user: 'alice',
    vaultId: 'vault_test',
    amount: 100,
    idempotencyKey: 'rollback-provider-deposit-001',
    correlationId: 'corr-fail',
  };

  try {
    assert.throws(() => positionService.deposit(request), /injected audit failure/);
  } finally {
    auditService.record = originalRecord;
  }

  const vaultAfter = store.vaults.get('vault_test');
  assert.equal(vaultAfter.totalAssets, vaultBefore.totalAssets);
  assert.equal(vaultAfter.totalShares, vaultBefore.totalShares);
  assert.equal(store.positions.size, 0);
  assert.equal(providerCalls, 1);

  assert.equal(store.transactions.size, 1);
  assert.equal(store.transactionStates.size, 1);
  const tx = [...store.transactions.values()][0];
  const lifecycle = store.transactionStates.get(tx.txHash);
  assert.equal(tx.accountingApplied, false);
  assert.equal(lifecycle.status, 'confirmed');
  assert.deepEqual(lifecycle.idempotencyRequest, {
    operation: 'deposit',
    user: request.user,
    vaultId: request.vaultId,
    amount: request.amount,
  });
  assert.equal(lifecycle.idempotencyResponse, undefined);

  const finding = reconciliationService.collectFindings().find(
    (entry) => entry.code === CODES.TX_ACCOUNTING_UNAPPLIED
  );
  assert.ok(finding);
  assert.equal(finding.entityId, tx.txHash);
  assert.equal(finding.related.operation, 'deposit');

  assert.throws(
    () => positionService.deposit({ ...request, correlationId: 'corr-retry' }),
    (error) => error.statusCode === 409 && /cannot be safely replayed/.test(error.message)
  );
  assert.equal(providerCalls, 1);
  stellarService.submitInvocation = originalSubmit;
});

test('withdraw rollback preserves provider evidence and blocks an idempotent resubmission', () => {
  positionService.deposit({
    user: 'alice',
    vaultId: 'vault_test',
    amount: 100,
    idempotencyKey: 'withdraw-setup-deposit',
  });
  const stellarService = require('../src/services/stellarService');
  const originalRecord = auditService.record;
  const originalSubmit = stellarService.submitInvocation;
  const vaultBefore = structuredClone(store.vaults.get('vault_test'));
  const positionBefore = structuredClone([...store.positions.values()][0]);
  let providerCalls = 0;
  stellarService.submitInvocation = (...args) => {
    providerCalls += 1;
    return originalSubmit(...args);
  };
  auditService.record = () => {
    throw new Error('injected withdraw audit failure');
  };
  const request = {
    user: 'alice',
    vaultId: 'vault_test',
    shares: 10,
    idempotencyKey: 'rollback-provider-withdraw-001',
    correlationId: 'corr-withdraw-fail',
  };

  try {
    assert.throws(() => positionService.withdraw(request), /injected withdraw audit failure/);
  } finally {
    auditService.record = originalRecord;
  }

  assert.deepEqual(store.vaults.get('vault_test'), vaultBefore);
  assert.deepEqual([...store.positions.values()][0], positionBefore);
  assert.equal(providerCalls, 1);

  const recoveryTx = [...store.transactions.values()].find(
    (entry) => entry.operation === 'withdraw' && entry.accountingApplied === false
  );
  assert.ok(recoveryTx);
  const recoveryState = store.transactionStates.get(recoveryTx.txHash);
  assert.equal(recoveryState.status, 'confirmed');
  assert.deepEqual(recoveryState.idempotencyRequest, {
    operation: 'withdraw',
    user: request.user,
    vaultId: request.vaultId,
    shares: request.shares,
  });
  assert.ok(
    reconciliationService.collectFindings().some(
      (entry) =>
        entry.code === CODES.TX_ACCOUNTING_UNAPPLIED &&
        entry.entityId === recoveryTx.txHash &&
        entry.related.operation === 'withdraw'
    )
  );

  assert.throws(
    () => positionService.withdraw({ ...request, correlationId: 'corr-withdraw-retry' }),
    (error) => error.statusCode === 409 && /cannot be safely replayed/.test(error.message)
  );
  assert.equal(providerCalls, 1);
  stellarService.submitInvocation = originalSubmit;
});

test('atomic rollback preserves stored values, collection identities and the original error', () => {
  const names = ['vaults', 'positions', 'transactions', 'transactionStates', 'auditEvents'];
  const expectedRecord = () => ({
    id: 'rollback_evidence',
    value: NaN,
    explicitUndefined: undefined,
    nested: { values: [Infinity, -Infinity, undefined, -0, 12.5] },
  });
  const maps = names.map((name) => store[name]);
  for (const map of maps) map.set('rollback_evidence', expectedRecord());
  const keys = maps.map((map) => [...map.keys()]);
  const failure = new Error('original downstream failure');

  assert.throws(() => store.runAtomic(() => {
    for (const map of maps) {
      const record = map.get('rollback_evidence');
      record.value = 100;
      record.nested.values[0] = 200;
      delete record.explicitUndefined;
      map.set('partial_write', { id: 'partial_write' });
    }
    throw failure;
  }), (error) => error === failure);

  for (const [index, name] of names.entries()) {
    assert.equal(store[name], maps[index]);
    assert.deepEqual([...store[name].keys()], keys[index]);
    assert.deepEqual(store[name].get('rollback_evidence'), expectedRecord());
  }
});

for (const operation of ['deposit', 'withdraw']) {
  test(`HTTP failed ${operation} preserves unrelated accounting values and reconciliation findings`, async () => {
    const server = http.createServer(createApp());
    server.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const readReport = async () => {
      const response = await fetch(`${base}/api/reconciliation`, {
        headers: { Authorization: `Bearer ${readerTokens.auditor}` },
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    try {
      for (const value of [NaN, Infinity, -Infinity, undefined, null, -0, 12.5]) {
        resetStore();
        store.vaults.set('vault_broken', {
          id: 'vault_broken', totalAssets: value, totalShares: 1000,
        });
        const healthyBefore = { ...store.vaults.get('vault_test') };
        const before = await readReport();
        const response = await fetch(`${base}/api/positions/${operation}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(operation === 'deposit'
            ? { user: 'local_user', vaultId: 'vault_missing', amount: 1 }
            : { user: 'local_user', vaultId: 'vault_test', shares: 1 }),
        });
        const refusal = await response.json();
        assert.equal(response.status, 404);
        assert.match(refusal.error.message, /not found|No position found/);
        const restored = store.vaults.get('vault_broken');
        assert.ok(Object.is(restored.totalAssets, value), `rollback changed ${String(value)}`);
        assert.ok(Object.hasOwn(restored, 'totalAssets'));
        assert.deepEqual(store.vaults.get('vault_test'), healthyBefore);
        assert.equal(store.vaults.size, 2);
        for (const name of ['positions', 'transactions', 'transactionStates', 'auditEvents']) {
          assert.equal(store[name].size, 0);
        }
        const after = await readReport();
        assert.deepEqual(after.findings, before.findings);
        assert.equal(after.status, before.status);
        assert.equal(after.repaired, false);
      }
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}

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

test('idempotency replays deposit and withdraw without repeating accounting or provider work', () => {
  const stellarService = require('../src/services/stellarService');
  const originalSubmit = stellarService.submitInvocation;
  let providerCalls = 0;
  stellarService.submitInvocation = (...args) => {
    providerCalls += 1;
    return originalSubmit(...args);
  };

  try {
    const depositRequest = {
      user: 'alice',
      vaultId: 'vault_test',
      amount: 100,
      idempotencyKey: 'deposit-replay-001',
      correlationId: 'corr-deposit-first',
    };
    const firstDeposit = positionService.deposit(depositRequest);
    assert.equal(providerCalls, 1);

    const depositState = {
      vault: structuredClone(store.vaults.get('vault_test')),
      positions: structuredClone([...store.positions.entries()]),
      transactions: structuredClone([...store.transactions.entries()]),
      transactionStates: structuredClone([...store.transactionStates.entries()]),
      auditEvents: structuredClone([...store.auditEvents.entries()]),
    };

    const replayDeposit = positionService.deposit({
      ...depositRequest,
      correlationId: 'corr-deposit-retry',
    });
    assert.deepEqual(replayDeposit, firstDeposit);
    assert.equal(providerCalls, 1);
    assert.deepEqual(store.vaults.get('vault_test'), depositState.vault);
    assert.deepEqual([...store.positions.entries()], depositState.positions);
    assert.deepEqual([...store.transactions.entries()], depositState.transactions);
    assert.deepEqual([...store.transactionStates.entries()], depositState.transactionStates);
    assert.deepEqual([...store.auditEvents.entries()], depositState.auditEvents);

    assert.throws(
      () => positionService.deposit({ ...depositRequest, amount: 101 }),
      (error) => error.statusCode === 409
    );
    assert.throws(
      () => positionService.withdraw({
        user: 'alice',
        vaultId: 'vault_test',
        shares: 10,
        idempotencyKey: depositRequest.idempotencyKey,
      }),
      (error) => error.statusCode === 409
    );
    assert.equal(providerCalls, 1);

    const withdrawRequest = {
      user: 'alice',
      vaultId: 'vault_test',
      shares: 10,
      idempotencyKey: 'withdraw-replay-001',
      correlationId: 'corr-withdraw-first',
    };
    const firstWithdraw = positionService.withdraw(withdrawRequest);
    assert.equal(providerCalls, 2);
    const withdrawState = {
      vault: structuredClone(store.vaults.get('vault_test')),
      positions: structuredClone([...store.positions.entries()]),
      transactions: structuredClone([...store.transactions.entries()]),
      transactionStates: structuredClone([...store.transactionStates.entries()]),
      auditEvents: structuredClone([...store.auditEvents.entries()]),
    };

    const replayWithdraw = positionService.withdraw({
      ...withdrawRequest,
      correlationId: 'corr-withdraw-retry',
    });
    assert.deepEqual(replayWithdraw, firstWithdraw);
    assert.equal(providerCalls, 2);
    assert.deepEqual(store.vaults.get('vault_test'), withdrawState.vault);
    assert.deepEqual([...store.positions.entries()], withdrawState.positions);
    assert.deepEqual([...store.transactions.entries()], withdrawState.transactions);
    assert.deepEqual([...store.transactionStates.entries()], withdrawState.transactionStates);
    assert.deepEqual([...store.auditEvents.entries()], withdrawState.auditEvents);
  } finally {
    stellarService.submitInvocation = originalSubmit;
  }
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
