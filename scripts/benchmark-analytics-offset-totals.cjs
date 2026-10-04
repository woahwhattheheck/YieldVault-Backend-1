'use strict';

// Compare real service roots; fixture setup and assertions are outside timing.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

process.env.NODE_ENV = 'test';
process.env.ANALYTICS_CURSOR_SECRET = 'synthetic-offset-benchmark-only';
process.env.ANALYTICS_PAGE_MAX_LIMIT = '100';
process.env.ANALYTICS_PAGE_MAX_SCAN = '10000';

const roots = process.argv.slice(2);
if (roots.length === 0) roots.push(path.join(__dirname, '..'));
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sources = roots.map((root, index) => {
  root = path.resolve(root);
  const servicePath = path.join(root, 'src/services/analyticsHistoryService.js');
  const service = require(servicePath);
  return {
    label: `source-${index + 1}`,
    service,
    store: require(path.join(root, 'src/store')),
    serviceSha256: hash(fs.readFileSync(servicePath)),
  };
});
const rounds = 7;
const requestsPerSample = 20;
const results = [];
const timestamp = (i) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

for (const size of [1000, 100000]) {
  const rows = Array.from({ length: size }, (_, i) => ({
    txHash: `tx-${i}`, timestamp: timestamp(i),
    user: ['alice', 'bob', 'carol', 'dave'][i % 4],
    vaultId: ['vault_a', 'vault_b', 'vault_c'][i % 3], amount: i + 1,
  }));
  for (const source of sources) {
    source.store.transactions.clear();
    for (const row of rows) source.store.transactions.set(row.txHash, { ...row });
    source.service.rebuildIndex();
  }
  const cases = [
    ['legacy-global', {}],
    ['legacy-vault', { vaultId: 'vault_a' }],
    ['legacy-actor', { actor: 'alice' }],
    ['legacy-vault-actor', { vaultId: 'vault_a', actor: 'alice' }],
    ['legacy-actor-time-control', {
      actor: 'alice', from: timestamp(size / 4), to: timestamp(3 * size / 4),
    }],
    ['cursor-vault-actor-control', { vaultId: 'vault_a', actor: 'alice' }],
  ];
  const observations = [];
  for (const [name, filters] of cases) {
    const legacy = name.startsWith('legacy');
    const req = {
      query: { order: 'asc', limit: '50', ...(legacy ? { offset: '0' } : {}), ...filters },
      headers: { 'x-wallet-address': 'synthetic-benchmark-reader' },
    };
    const expected = rows.filter((row) =>
      (!filters.vaultId || row.vaultId === filters.vaultId)
      && (!filters.actor || row.user === filters.actor)
      && (!filters.from || row.timestamp >= filters.from)
      && (!filters.to || row.timestamp <= filters.to));
    const reference = sources[0].service.listHistory(req);
    assert.deepEqual(reference.events, expected.slice(0, 50));
    if (legacy) assert.equal(reference.pagination.total, expected.length);
    else assert.equal(Object.hasOwn(reference.pagination, 'total'), false);
    const measurements = sources.map((source) => {
      const warmup = source.service.listHistory(req);
      assert.deepEqual(warmup, reference);
      return { source: source.label, samplesMs: [], resultSha256: hash(JSON.stringify(warmup)) };
    });
    for (let round = 0; round < rounds; round += 1) {
      const order = sources.map((_, i) => i);
      if (round % 2) order.reverse();
      for (const index of order) {
        let result;
        const start = performance.now();
        for (let request = 0; request < requestsPerSample; request += 1) {
          result = sources[index].service.listHistory(req);
        }
        measurements[index].samplesMs.push((performance.now() - start) / requestsPerSample);
        assert.deepEqual(result, reference);
      }
    }
    const observation = { size, name, returned: reference.events.length,
      total: reference.pagination.total ?? null, scanned: reference.pagination.pageInfo.scanned,
      measurements };
    observations.push({ req, reference, observation });
    results.push(observation);
  }
  // Count record payload reads in separate untimed calls. Restore descriptors
  // before the next size; instrumentation is never present during timing.
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    let reads = 0;
    const records = source.service._historyIndex.records;
    const descriptors = records.map((record) => Object.getOwnPropertyDescriptor(record, 'item'));
    records.forEach((record, i) => Object.defineProperty(record, 'item', {
      configurable: true, enumerable: true,
      get() { reads += 1; return descriptors[i].value; },
    }));
    for (const { req, reference, observation } of observations) {
      reads = 0;
      const result = source.service.listHistory(req);
      const measurement = observation.measurements[index];
      measurement.itemReads = reads;
      measurement.medianMs = median(measurement.samplesMs);
      assert.deepEqual(result, reference);
    }
    records.forEach((record, i) => Object.defineProperty(record, 'item', descriptors[i]));
  }
}

console.log(JSON.stringify({
  schemaVersion: 1, recordedAt: new Date().toISOString(), node: process.version,
  platform: process.platform, architecture: process.arch,
  rounds, requestsPerSample, sources: sources.map(({ label, serviceSha256 }) => ({ label, serviceSha256 })),
  measurement: 'In-process listHistory call, milliseconds per request; setup, rebuild, comparison and read instrumentation excluded.',
  results,
}, null, 2));
