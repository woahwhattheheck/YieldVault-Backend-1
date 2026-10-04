'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const store = require('../src/store');
const service = require('../src/services/reconciliationService');
const { getReport } = require('../src/controllers/reconciliationController');
const { BoundedFindingPage, MAX_REPORT_WINDOW } = require('../src/services/reconciliationPage');
const collections = ['vaults', 'positions', 'transactions', 'transactionStates', 'auditEvents'];

beforeEach(() => { for (const name of collections) store[name].clear(); });

function seed() {
  store.vaults.set('v', { id: 'v', totalShares: 100, totalAssets: NaN });
  for (let i = 0; i < 211; i += 1) {
    const id = `p_${String((i * 37) % 211).padStart(3, '0')}`;
    store.positions.set(id, {
      id, user: `u_${i}`, vaultId: i % 2 ? 'v' : 'missing', shares: -1, principal: -2,
    });
  }
  // Equal code/entity sort keys must preserve source order and distinct details.
  store.positions.set('alias1', { id: 'same', user: 'first', vaultId: 'missing', shares: 1, principal: 1 });
  store.positions.set('alias2', { id: 'same', user: 'second', vaultId: 'missing', shares: 1, principal: 1 });
  store.transactions.set('t', { txHash: 't', vaultId: 'v', status: 'confirmed' });
  store.transactionStates.set('orphan', { txHash: 'orphan', vaultId: 'v', status: 'failed' });
}

test('bounded selection matches stable sorting while never retaining more than capacity', () => {
  const compare = (a, b) => a.key - b.key;
  const values = Array.from({ length: 3000 }, (_, i) => ({ key: (i * 73) % 97, ordinal: i }));
  for (const capacity of [1, 20, 101, MAX_REPORT_WINDOW]) {
    const selected = new BoundedFindingPage(capacity, compare);
    for (const value of values) {
      selected.push(value);
      assert.ok(selected.entries.length <= capacity);
    }
    assert.equal(selected.total, values.length);
    assert.deepEqual(selected.page(0, capacity), values.slice().sort(compare).slice(0, capacity));
    assert.deepEqual(selected.page(3, 7), values.slice().sort(compare).slice(0, capacity).slice(3, 10));
  }
});

test('report pages exactly match the existing full collector and do not mutate accounting', () => {
  seed();
  const before = structuredClone(collections.map((name) => store[name]));
  for (const vaultId of [undefined, 'v', 'missing', 'absent']) {
    const all = service.collectFindings({ vaultId });
    for (const limit of [1, 7, 100]) {
      for (const offset of [0, 3, 30, all.length, all.length + 7]) {
        const report = service.generateReport({ vaultId, limit, offset });
        assert.deepEqual(report.findings, all.slice(offset, offset + limit));
        assert.deepEqual(report.pagination, { total: all.length, limit, offset, hasMore: offset + limit < all.length });
        assert.equal(report.status, all.length ? 'mismatches_found' : 'ok');
        assert.equal(report.repaired, false);
        assert.equal(report.filters.vaultId, vaultId || null);
      }
    }
  }
  assert.deepEqual(collections.map((name) => store[name]), before);
});

test('oversized or unsafe page windows are rejected before any store iteration', () => {
  const originals = collections.map((name) => store[name].values);
  try {
    for (const name of collections) store[name].values = () => { throw new Error('unexpected store scan'); };
    for (const query of [
      { offset: MAX_REPORT_WINDOW },
      { offset: MAX_REPORT_WINDOW - 99, limit: 100 },
      { offset: '9007199254740992', limit: 1 },
      { offset: Number.MAX_SAFE_INTEGER, limit: 1 },
    ]) {
      assert.throws(() => service.generateReport(query), (error) =>
        error.statusCode === 400 && error.details.code === 'REPORT_WINDOW_TOO_LARGE' &&
        error.details.maxWindow === MAX_REPORT_WINDOW);
    }
  } finally {
    collections.forEach((name, i) => { store[name].values = originals[i]; });
  }
});

test('controller preserves normal page output, defaults and the exact window boundary', () => {
  seed();
  let body;
  getReport({ query: { limit: '500', offset: String(MAX_REPORT_WINDOW - 100) } }, { json(value) { body = value; } });
  assert.equal(body.pagination.limit, 100);
  assert.equal(body.pagination.offset, 9900);
  assert.equal(body.pagination.total, service.collectFindings().length);
  assert.deepEqual(body.findings, []);
  assert.equal(body.status, 'mismatches_found');
  const defaults = service.generateReport({ limit: 'invalid', offset: '-5' });
  assert.equal(defaults.pagination.limit, 20);
  assert.equal(defaults.pagination.offset, 0);
  assert.equal(defaults.findings.length, 20);
});

test('invalid internal selection capacities cannot exceed the report bound', () => {
  for (const capacity of [0, -1, 1.5, Infinity, NaN, MAX_REPORT_WINDOW + 1]) {
    assert.throws(() => new BoundedFindingPage(capacity, () => 0), RangeError);
  }
});

// Optional explicit before/after measurement, never run by a normal npm test.
if (process.env.RECONCILIATION_BASELINE_DIR) {
  test('matched large-fixture report comparison', () => {
    const benchmark = path.resolve(__dirname, '../scripts/benchmark-reconciliation-page.js');
    const roots = [path.resolve(process.env.RECONCILIATION_BASELINE_DIR), path.resolve(__dirname, '..')];
    const results = roots.map((root) => JSON.parse(execFileSync(process.execPath,
      ['--expose-gc', benchmark, root, '100000'], { encoding: 'utf8', timeout: 30000 })));
    assert.equal(results[0].responseSha256, results[1].responseSha256);
    assert.equal(results[0].totalFindings, 300000);
    assert.equal(results[1].returnedFindings, 20);
    console.log('RECONCILIATION_COMPARISON=' + JSON.stringify({ baseline: results[0], bounded: results[1] }));
  });
}
