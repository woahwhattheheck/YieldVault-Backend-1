'use strict';

// Run this same script against two source roots to compare the real service.
// Fixture construction, index rebuild and result verification are outside timing.
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sourceRoots = process.argv.slice(2);
if (sourceRoots.length === 0) sourceRoots.push(path.join(__dirname, '..'));
const sources = sourceRoots.map(root => {
  const sourceRoot = path.resolve(root);
  const store = require(path.join(sourceRoot, 'src/store'));
  const history = require(path.join(sourceRoot, 'src/services/analyticsHistoryService'));
  const config = require(path.join(sourceRoot, 'src/config'));
  config.analyticsPagination.maxScan = 1000;
  return { sourceRoot, store, history };
});

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];

for (const rows of [1000, 10000, 50000]) {
  const fixtures = sources.map(({ store, history, sourceRoot }) => {
    store.transactions.clear();
    const expectedActor = [];
    const expectedCombined = [];
    const step = rows / 10;
    for (let i = 0; i < rows; i += 1) {
      const target = i % step === 0;
      const vaultId = target ? ((i / step) % 2 === 0 ? 'vault_a' : 'vault_b') : 'vault_a';
      const tx = {
        txHash: `tx-${i}`, user: target ? 'target' : 'other', vaultId,
        timestamp: '2026-01-01T00:00:00.000Z', type: 'deposit', amount: 1,
      };
      store.transactions.set(tx.txHash, tx);
      if (target) {
        expectedActor.unshift(tx);
        if (vaultId === 'vault_a') expectedCombined.unshift(tx);
      }
    }

    const rebuildStart = process.hrtime.bigint();
    history.rebuildIndex();
    const rebuildMs = Number(process.hrtime.bigint() - rebuildStart) / 1e6;
    const index = history._historyIndex;
    const indexReferences = index.records.length
      + [...index.groups.values()].reduce((sum, bucket) => sum + bucket.length, 0);

    return { sourceRoot, history, rebuildMs, indexReferences, expectedActor, expectedCombined };
  });

  function walk(history, query) {
    const events = [];
    let cursor;
    let pages = 0;
    let scanned = 0;
    do {
      const result = history.listHistory({
        query: { ...query, limit: '10', order: 'desc', ...(cursor ? { cursor } : {}) },
        headers: { 'x-wallet-address': 'benchmark-reader' },
      });
      events.push(...result.events);
      pages += 1;
      scanned += result.pagination.pageInfo.scanned;
      assert.ok(result.pagination.pageInfo.scanned <= 1000);
      assert.ok(pages <= rows + 1, 'cursor walk must terminate');
      cursor = result.pagination.pageInfo.nextCursor;
      if (!result.pagination.pageInfo.hasMore) break;
      assert.ok(cursor, 'nonterminal page must carry a cursor');
    } while (true);
    return { events, pages, scanned };
  }

  for (const [name, query, expectedKey] of [
    ['actor', { actor: 'target' }, 'expectedActor'],
    ['vaultActor', { vaultId: 'vault_a', actor: 'target' }, 'expectedCombined'],
    ['absentActor', { actor: 'absent' }, null],
  ]) {
    const measurements = fixtures.map(fixture => {
      const expected = expectedKey ? fixture[expectedKey] : [];
      assert.deepEqual(walk(fixture.history, query).events, expected); // warmup
      return { fixture, expected, samplesMs: [] };
    });
    for (let sample = 0; sample < 7; sample += 1) {
      // Interleave the same query on all sources and alternate execution order.
      const order = sample % 2 === 0 ? measurements : [...measurements].reverse();
      for (const measurement of order) {
        const started = process.hrtime.bigint();
        measurement.last = walk(measurement.fixture.history, query);
        measurement.samplesMs.push(Number(process.hrtime.bigint() - started) / 1e6);
        assert.deepEqual(measurement.last.events, measurement.expected);
      }
    }
    for (const { fixture, expected, samplesMs, last } of measurements) {
      results.push({
        sourceRoot: fixture.sourceRoot, rows, query: name, matches: expected.length,
        pages: last.pages, scanned: last.scanned, resultSha256: digest(last.events),
        samplesMs, medianMs: median(samplesMs), rebuildMs: fixture.rebuildMs,
        indexReferences: fixture.indexReferences,
      });
    }
  }
}

console.log(JSON.stringify({ node: process.version, maxScan: 1000, samples: 7, alternatingOrder: true, results }, null, 2));
