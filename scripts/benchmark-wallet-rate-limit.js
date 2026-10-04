'use strict';

// Compare the actual middleware against a retained source file in the same
// middleware directory, so its ordinary relative imports remain unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const config = require('../src/config');

if (!process.argv[2]) throw new Error('Pass the baseline middleware filename');
const files = {
  before: path.resolve(process.argv[2]),
  after: path.resolve(__dirname, '../src/middleware/walletRateLimit.js'),
};
const modules = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, require(p)]));
const originalNow = Date.now;
const originalTrust = config.trustProxy;
let now;
Date.now = () => now;
config.trustProxy = false;

const cases = [
  { name: 'live-5000', keys: 5000, calls: 10000 },
  { name: 'capacity-5000', keys: 5000, calls: 5000, capacity: true },
  { name: 'live-2', keys: 2, calls: 30000 },
  { name: 'partial-expiry-5000', keys: 5000, calls: 1, expiry: true },
];
function request(i) {
  return {
    get: (name) => name === 'X-Wallet-Address' ? `wallet_${i}` : undefined,
    socket: { remoteAddress: `2001:db8:${i.toString(16)}::1` },
  };
}
function sample(factory, workload) {
  factory.resetWalletRateLimitStores();
  now = 1_000_000;
  const limiter = factory({
    scope: 'benchmark', windowMs: 60000, maxKeys: 5000,
    maxPerActor: 1000000, maxPerClient: 1000000,
  });
  const headers = {};
  const res = { setHeader: (key, value) => { headers[key] = value; } };
  let error;
  const next = (value) => { error = value; };
  for (let i = 0; i < workload.keys / 2; i += 1) {
    if (workload.expiry && i === 1) now += 10000;
    limiter(request(i), res, next);
    assert.equal(error, undefined);
  }
  const req = request(workload.capacity ? 9999 : 0);
  for (let i = 0; i < 200; i += 1) limiter(req, res, next);
  if (workload.expiry) now = 1_060_000;
  let rejected = 0;
  let remaining = 0;
  let retry = 0;
  const start = performance.now();
  for (let i = 0; i < workload.calls; i += 1) {
    limiter(req, res, next);
    rejected += Number(Boolean(error));
    remaining += headers['X-RateLimit-Remaining'];
    retry += headers['Retry-After'] || 0;
  }
  const durationMs = performance.now() - start;
  return {
    duration_ms: durationMs,
    microseconds_per_call: durationMs * 1000 / workload.calls,
    outcome: {
      rejected, remaining, retry, headers: { ...headers },
      status: error?.statusCode || 200,
      details: error?.details || null,
      identity: req.rateLimitIdentity || null,
      keys: factory.walletRateLimitKeyCount(),
    },
  };
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  const results = [];
  for (const workload of cases) {
    const pairs = [];
    for (let i = 0; i < 9; i += 1) {
      const pair = {};
      for (const variant of i % 2 ? ['after', 'before'] : ['before', 'after']) {
        pair[variant] = sample(modules[variant], workload);
      }
      assert.deepEqual(pair.after.outcome, pair.before.outcome);
      pairs.push(pair);
    }
    const before = median(pairs.map((p) => p.before.microseconds_per_call));
    const after = median(pairs.map((p) => p.after.microseconds_per_call));
    results.push({ ...workload, before_median_us: before, after_median_us: after,
      ratio: before / after, pairs });
  }
  const blobs = Object.fromEntries(Object.entries(files).map(([key, file]) => {
    const bytes = fs.readFileSync(file);
    return [key, crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')];
  }));
  console.log(JSON.stringify({ node: process.version, v8: process.versions.v8,
    platform: process.platform, arch: process.arch, blobs, results }, null, 2));
} finally {
  Date.now = originalNow;
  config.trustProxy = originalTrust;
  for (const factory of Object.values(modules)) factory.resetWalletRateLimitStores();
}
