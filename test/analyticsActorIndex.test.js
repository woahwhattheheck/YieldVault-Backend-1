'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const config = require('../src/config');
const history = require('../src/services/analyticsHistoryService');
const { OrderedIndex } = require('../src/utils/orderedIndex');
const { encodeCursor, fingerprint, actorFingerprint } = require('../src/utils/cursor');

const timestamp = '2026-01-01T00:00:00.000Z';
let previousMaxScan;

beforeEach(() => {
  previousMaxScan = config.analyticsPagination.maxScan;
  config.analyticsPagination.maxScan = 3;
  store.transactions.clear();
  history.rebuildIndex();
});
afterEach(() => { config.analyticsPagination.maxScan = previousMaxScan; });

function append(txHash, user = 'alice', vaultId = 'vault_a') {
  const tx = { txHash, user, vaultId, timestamp };
  store.transactions.set(txHash, tx);
  history.recordTransaction(tx);
  return tx;
}

function page(query, headers = {}) {
  return history.listHistory({ query, headers });
}

function hashes(result) { return result.events.map(tx => tx.txHash); }

test('secondary buckets share global records, deduplicate keys, and reset together', () => {
  const index = new OrderedIndex({ sortKeyOf: tx => tx.timestamp, groupKeysOf: () => ['a', 'b', 'a'] });
  const record = index.append({ timestamp });
  assert.equal(index.recordsFor('a').length, 1);
  assert.strictEqual(index.recordsFor('a')[0], record);
  assert.strictEqual(index.recordsFor('b')[0], index.recordAt(0));
  index.reset();
  assert.equal(index.size, 0);
  assert.equal(index.recordsFor('a').length, 0);
  assert.equal(index.recordsFor('b').length, 0);
});

test('sparse actor and combined filters skip unrelated rows and preserve legacy totals', () => {
  for (let i = 0; i < 100; i += 1) {
    append(`tx-${i}`, i % 20 === 0 ? 'alice' : 'bob', i % 40 === 0 ? 'vault_b' : 'vault_a');
  }
  const actor = page({ actor: 'alice', order: 'asc', limit: '2' });
  assert.deepEqual(hashes(actor), ['tx-0', 'tx-20']);
  assert.equal(actor.pagination.pageInfo.scanned, 3);
  const combined = page({ vaultId: 'vault_a', actor: 'alice', order: 'asc', limit: '2' });
  assert.deepEqual(hashes(combined), ['tx-20', 'tx-60']);
  assert.equal(combined.pagination.pageInfo.scanned, 2);
  assert.equal(combined.pagination.pageInfo.hasMore, false);
  const legacy = page({ vaultId: 'vault_a', actor: 'alice', order: 'asc', limit: '1', offset: '1' });
  assert.deepEqual(hashes(legacy), ['tx-60']);
  assert.equal(legacy.pagination.total, 2);
  assert.equal(legacy.pagination.offset, 1);
});

test('an absent actor terminates without walking the unrelated ledger', () => {
  for (let i = 0; i < 20; i += 1) append(`tx-${i}`);
  for (const query of [{ actor: 'absent' }, { actor: 'absent', vaultId: 'vault_a' }]) {
    const result = page(query);
    assert.deepEqual(hashes(result), []);
    assert.equal(result.pagination.pageInfo.scanned, 0);
    assert.equal(result.pagination.pageInfo.hasMore, false);
    assert.equal(result.pagination.pageInfo.nextCursor, null);
  }
});

test('typed bucket keys cannot mix actor, vault or ambiguous composite values', () => {
  append('tuple-one', 'b:c', 'a');
  append('tuple-two', 'c', 'a:b');
  append('vault-lookalike', 'other', JSON.stringify(['actor', 'b:c']));
  append('actor-lookalike', JSON.stringify(['vault', 'a']), 'other');
  assert.deepEqual(hashes(page({ actor: 'b:c', vaultId: 'a' })), ['tuple-one']);
  assert.deepEqual(hashes(page({ actor: 'c', vaultId: 'a:b' })), ['tuple-two']);
  assert.deepEqual(hashes(page({ actor: 'b:c' })), ['tuple-one']);
  assert.deepEqual(hashes(page({ vaultId: 'a' })), ['tuple-one']);
});

for (const order of ['asc', 'desc']) {
  test(`legacy ${order} cursors resume from another actor's frontier`, () => {
    for (let i = 0; i < 5; i += 1) append(`tx-${i}`, i % 2 === 0 ? 'alice' : 'bob');
    const seq = order === 'asc' ? 1 : 3;
    const headers = { 'x-wallet-address': 'reader' };
    for (const filters of [{ actor: 'alice' }, { vaultId: 'vault_a', actor: 'alice' }]) {
      const cursor = encodeCursor({
        order, key: timestamp, seq,
        filter: fingerprint(['analytics.vaultHistory', filters]),
        actor: actorFingerprint({ headers }),
      });
      const query = { ...filters, order, cursor, limit: '1' };
      // The user alias has the same canonical filter as actor.
      delete query.actor;
      query.user = 'alice';
      const first = page(query, headers);
      assert.deepEqual(hashes(first), ['tx-2']);
      query.cursor = first.pagination.pageInfo.nextCursor;
      const second = page(query, headers);
      assert.deepEqual(hashes(second), [order === 'asc' ? 'tx-4' : 'tx-0']);
      assert.equal(second.pagination.pageInfo.hasMore, false);
    }
  });

  test(`${order} actor pages retain insertion order under timestamp ties and concurrent appends`, () => {
    for (let i = 0; i < 5; i += 1) append(`tx-${i}`, i % 2 === 0 ? 'alice' : 'bob');
    const query = { actor: 'alice', vaultId: 'vault_a', order, limit: '1' };
    const seen = [];
    for (let calls = 0; ; calls += 1) {
      assert.ok(calls < 6, 'cursor walk must terminate');
      const result = page(query);
      seen.push(...hashes(result));
      if (calls === 0) {
        append('live-bob', 'bob');
        append('live-alice');
      }
      if (!result.pagination.pageInfo.hasMore) break;
      query.cursor = result.pagination.pageInfo.nextCursor;
    }
    assert.deepEqual(seen, order === 'asc' ? ['tx-0', 'tx-2', 'tx-4', 'live-alice'] : ['tx-4', 'tx-2', 'tx-0']);
    assert.equal(new Set(seen).size, seen.length);
  });
}

test('rebuild replaces actor buckets without retaining the previous ledger', () => {
  append('before-reset');
  store.transactions.clear();
  store.transactions.set('after-reset', { txHash: 'after-reset', user: 'bob', vaultId: 'vault_a', timestamp });
  history.rebuildIndex();
  assert.deepEqual(hashes(page({ actor: 'alice' })), []);
  assert.deepEqual(hashes(page({ actor: 'bob' })), ['after-reset']);
  assert.equal(history.getIndexSize(), 1);
});
