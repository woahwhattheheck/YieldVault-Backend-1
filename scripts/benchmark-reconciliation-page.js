'use strict';

// Explicit local report benchmark. Run both revisions in separate fresh processes:
// node --expose-gc scripts/benchmark-reconciliation-page.js /path/to/revision 100000
// No backend, credentials, dependencies or HTTP server are used.
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const root = path.resolve(process.argv[2] || '.');
const count = Number(process.argv[3] || 100000);
if (!Number.isSafeInteger(count) || count < 1 || count > 1000000) throw new RangeError('rows must be 1..1000000');
if (!global.gc) throw new Error('Run with --expose-gc');
const store = require(path.join(root, 'src/store'));
const { generateReport } = require(path.join(root, 'src/services/reconciliationService'));
for (const name of ['vaults', 'positions', 'transactions', 'transactionStates', 'auditEvents']) store[name].clear();
for (let i = 0; i < count; i += 1) {
  const id = `position_${String((i * 7919) % 1000003).padStart(7, '0')}`;
  store.positions.set(id, { id, user: 'synthetic-user', vaultId: 'missing', shares: -1, principal: -2 });
}
global.gc();
const heapBefore = process.memoryUsage().heapUsed;
let peakHeap = heapBefore;
const originalValues = store.positions.values;
store.positions.values = function* sampledValues() {
  let visited = 0;
  for (const value of originalValues.call(this)) {
    if ((visited++ % 1024) === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    yield value;
  }
};
const started = performance.now();
const report = generateReport({ limit: 20, offset: 40 });
const elapsedMs = performance.now() - started;
peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
delete report.generatedAt;
console.log(JSON.stringify({
  node: process.version, rows: count, totalFindings: report.pagination.total,
  returnedFindings: report.findings.length, elapsedMs,
  sampledPeakHeapIncreaseBytes: peakHeap - heapBefore,
  maxRssKiB: process.resourceUsage().maxRSS,
  responseSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'),
}));
