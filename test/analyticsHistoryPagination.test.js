'use strict';

process.env.NODE_ENV = 'test';
process.env.ANALYTICS_CURSOR_SECRET = 'unit-test-analytics-cursor-secret';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const createApp = require('../src/app');
const store = require('../src/store');
const positionService = require('../src/services/positionService');
const analyticsHistoryService = require('../src/services/analyticsHistoryService');
const { OrderedIndex } = require('../src/utils/orderedIndex');
const {
  encodeCursor,
  decodeCursor,
  fingerprint,
  actorFingerprint,
} = require('../src/utils/cursor');
const { parseHistoryPagination } = require('../src/utils/pagination');
const { AppError } = require('../src/utils/errors');
const config = require('../src/config');

function resetStore() {
  store.vaults.clear();
  store.positions.clear();
  store.transactions.clear();
  store.transactionStates.clear();
  if (store.auditEvents) store.auditEvents.clear();
  store.vaults.set('vault_a', {
    id: 'vault_a',
    name: 'Vault A',
    asset: 'USDC',
    apy: 0.05,
    totalAssets: 1_000_000,
    totalShares: 1_000_000,
    createdAt: Date.now(),
    lastAccruedAt: Date.now(),
  });
  store.vaults.set('vault_b', {
    id: 'vault_b',
    name: 'Vault B',
    asset: 'XLM',
    apy: 0.08,
    totalAssets: 500_000,
    totalShares: 500_000,
    createdAt: Date.now(),
    lastAccruedAt: Date.now(),
  });
  analyticsHistoryService.rebuildIndex();
}

function seedDeposits(count, { user = 'alice', vaultId = 'vault_a', amount = 10 } = {}) {
  const txs = [];
  for (let i = 0; i < count; i += 1) {
    const result = positionService.deposit({ user, vaultId, amount });
    txs.push(result.tx);
  }
  return txs;
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
              // keep raw
            }
            resolve({ status: res.statusCode, body });
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

describe('parseHistoryPagination', () => {
  it('rejects limits above the configured ceiling instead of clamping', () => {
    assert.throws(
      () => parseHistoryPagination({ limit: String(config.analyticsPagination.maxLimit + 1) }),
      (err) => err instanceof AppError && err.statusCode === 400 && err.details.code === 'LIMIT_TOO_LARGE'
    );
  });

  it('rejects cursor combined with a non-zero offset', () => {
    assert.throws(
      () => parseHistoryPagination({ cursor: 'abc', offset: '1' }),
      (err) => err instanceof AppError && err.details.code === 'CONFLICTING_PAGINATION'
    );
  });

  it('accepts a valid limit and defaults order to desc', () => {
    const parsed = parseHistoryPagination({ limit: '25' });
    assert.equal(parsed.limit, 25);
    assert.equal(parsed.order, 'desc');
    assert.equal(parsed.mode, 'offset');
  });
});

describe('OrderedIndex cursor stability', () => {
  it('pages without duplicates or gaps under concurrent inserts', () => {
    const index = new OrderedIndex({
      sortKeyOf: (item) => item.timestamp,
      groupKeyOf: (item) => item.vaultId,
    });

    for (let i = 0; i < 20; i += 1) {
      index.append({
        id: `seed-${i}`,
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        vaultId: 'vault_a',
      });
    }

    const seen = new Set();
    let cursorSeq = null;
    let pages = 0;

    while (pages < 20) {
      const page = index.scan({
        afterSeq: cursorSeq,
        order: 'asc',
        group: 'vault_a',
        limit: 5,
        maxScan: 1000,
      });

      // Concurrent insert between pages — must not appear inside an already
      // emitted window when reading ascending from a prior cursor.
      index.append({
        id: `live-${pages}`,
        timestamp: `2026-02-01T00:00:${String(pages).padStart(2, '0')}.000Z`,
        vaultId: 'vault_a',
      });

      for (const item of page.items) {
        assert.equal(seen.has(item.id), false, `duplicate ${item.id}`);
        seen.add(item.id);
      }

      pages += 1;
      if (!page.hasMore) break;
      assert.ok(page.last);
      cursorSeq = page.last.seq;
    }

    // All 20 seed rows must appear exactly once. Live inserts land after the
    // seed window in ascending order, so they are not required on this walk.
    for (let i = 0; i < 20; i += 1) {
      assert.equal(seen.has(`seed-${i}`), true, `missing seed-${i}`);
    }
  });
});

describe('GET /api/analytics/history', () => {
  it('returns cursor metadata and rejects oversized limits', async () => {
    seedDeposits(5);

    const over = await httpGet(
      `/api/analytics/history?vaultId=vault_a&limit=${config.analyticsPagination.maxLimit + 1}`
    );
    assert.equal(over.status, 400);
    assert.equal(over.body.error.details.code, 'LIMIT_TOO_LARGE');

    const ok = await httpGet('/api/analytics/history?vaultId=vault_a&limit=2');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.count, 2);
    assert.equal(ok.body.events.length, 2);
    assert.equal(ok.body.pagination.pageInfo.hasMore, true);
    assert.ok(ok.body.pagination.pageInfo.nextCursor);
  });

  it('walks every event exactly once across cursor pages', async () => {
    seedDeposits(12, { user: 'alice', vaultId: 'vault_a' });
    seedDeposits(3, { user: 'bob', vaultId: 'vault_b' });

    const seen = new Set();
    let cursor = null;
    let guard = 0;

    for (;;) {
      const qs = new URLSearchParams({ vaultId: 'vault_a', limit: '5', order: 'desc' });
      if (cursor) qs.set('cursor', cursor);
      const res = await httpGet(`/api/analytics/history?${qs}`, {
        'X-Wallet-Address': 'alice',
      });
      assert.equal(res.status, 200);
      for (const event of res.body.events) {
        assert.equal(event.vaultId, 'vault_a');
        assert.equal(seen.has(event.txHash), false);
        seen.add(event.txHash);
      }
      if (!res.body.pagination.pageInfo.hasMore) break;
      cursor = res.body.pagination.pageInfo.nextCursor;
      guard += 1;
      assert.ok(guard < 20);
    }

    assert.equal(seen.size, 12);
  });

  it('filters by actor and time range', async () => {
    seedDeposits(3, { user: 'alice', vaultId: 'vault_a' });
    seedDeposits(2, { user: 'bob', vaultId: 'vault_a' });

    const res = await httpGet('/api/analytics/history?vaultId=vault_a&actor=bob&limit=10');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 2);
    assert.ok(res.body.events.every((e) => e.user === 'bob'));
  });

  it('rejects a cursor minted for a different wallet', async () => {
    seedDeposits(4);
    const first = await httpGet('/api/analytics/history?vaultId=vault_a&limit=2', {
      'X-Wallet-Address': 'alice',
    });
    assert.equal(first.status, 200);
    const cursor = first.body.pagination.pageInfo.nextCursor;
    assert.ok(cursor);

    const replay = await httpGet(
      `/api/analytics/history?vaultId=vault_a&limit=2&cursor=${encodeURIComponent(cursor)}`,
      { 'X-Wallet-Address': 'eve' }
    );
    assert.equal(replay.status, 403);
    assert.equal(replay.body.error.details.code, 'CURSOR_ACTOR_MISMATCH');
  });

  it('stays bounded on a large fixture', async () => {
    seedDeposits(250, { user: 'alice', vaultId: 'vault_a' });

    const started = process.hrtime.bigint();
    const res = await httpGet('/api/analytics/history?vaultId=vault_a&limit=50&order=desc');
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(res.status, 200);
    assert.equal(res.body.events.length, 50);
    assert.ok(res.body.pagination.pageInfo.scanned <= config.analyticsPagination.maxScan);
    // A 250-row in-memory scan should be well under a second on CI.
    assert.ok(elapsedMs < 1000, `scan took ${elapsedMs}ms`);
  });
});

describe('cursor codec', () => {
  it('round-trips and rejects tampering', () => {
    const req = { headers: { 'x-wallet-address': 'alice' } };
    const actor = actorFingerprint(req);
    const filter = fingerprint(['analytics.vaultHistory', { vaultId: 'vault_a' }]);
    const cursor = encodeCursor({
      order: 'desc',
      key: '2026-01-01T00:00:00.000Z',
      seq: 7,
      filter,
      actor,
    });
    const decoded = decodeCursor(cursor, { order: 'desc', filter, actor });
    assert.equal(decoded.seq, 7);

    assert.throws(
      () => decodeCursor(`${cursor}x`, { order: 'desc', filter, actor }),
      (err) => err instanceof AppError && err.statusCode === 400
    );
  });
});
