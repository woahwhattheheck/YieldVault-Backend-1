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
  it('bounds an implicit default by the configured ceiling', () => {
    for (const query of [{}, { limit: '' }]) {
      const parsed = parseHistoryPagination(query, { defaultLimit: 50, maxLimit: 2 });
      assert.equal(parsed.limit, 2);
    }
    assert.equal(
      parseHistoryPagination({}, { defaultLimit: 1, maxLimit: 2 }).limit,
      1
    );
  });

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

  it('starts cursor pagination without requiring a resume token', () => {
    const parsed = parseHistoryPagination({ limit: '25' });
    assert.equal(parsed.limit, 25);
    assert.equal(parsed.order, 'desc');
    assert.equal(parsed.mode, 'cursor');
    assert.equal(parsed.cursor, null);
  });

  it('retains legacy offset mode when offset zero is explicitly requested', () => {
    const parsed = parseHistoryPagination({ limit: '25', offset: '0' });
    assert.equal(parsed.mode, 'offset');
    assert.equal(parsed.offset, 0);
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
  for (const suffix of ['', '?limit=', '?offset=0']) {
    it(`bounds the default page when the ceiling is lowered: ${suffix || 'no query'}`, async () => {
      seedDeposits(5);
      const original = { ...config.analyticsPagination };
      config.analyticsPagination.defaultLimit = 50;
      config.analyticsPagination.maxLimit = 2;
      try {
        const res = await httpGet(`/api/analytics/history${suffix}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.count, 2);
        assert.equal(res.body.pagination.limit, 2);
        assert.equal(res.body.pagination.maxLimit, 2);
        assert.equal(res.body.pagination.pageInfo.hasMore, true);
        if (suffix === '?offset=0') {
          assert.equal(res.body.pagination.total, 5);
          assert.equal(res.body.pagination.offset, 0);
        } else {
          assert.equal(res.body.pagination.strategy, 'cursor');
          assert.equal('total' in res.body.pagination, false);
        }
      } finally {
        Object.assign(config.analyticsPagination, original);
      }
    });
  }

  it('keeps omitted-limit cursor continuations within the lowered ceiling', async () => {
    seedDeposits(5);
    const original = { ...config.analyticsPagination };
    config.analyticsPagination.defaultLimit = 50;
    config.analyticsPagination.maxLimit = 2;
    try {
      const first = await httpGet('/api/analytics/history?limit=2');
      const second = await httpGet(
        `/api/analytics/history?cursor=${encodeURIComponent(first.body.pagination.pageInfo.nextCursor)}`
      );
      assert.equal(second.status, 200);
      assert.equal(second.body.count, 2);
      assert.equal(second.body.pagination.limit, 2);
      const third = await httpGet(
        `/api/analytics/history?cursor=${encodeURIComponent(second.body.pagination.pageInfo.nextCursor)}`
      );
      assert.equal(third.status, 200);
      assert.equal(third.body.count, 1);
      assert.equal(third.body.pagination.pageInfo.hasMore, false);
      const hashes = [...first.body.events, ...second.body.events, ...third.body.events]
        .map(event => event.txHash);
      assert.equal(new Set(hashes).size, 5);
    } finally {
      Object.assign(config.analyticsPagination, original);
    }
  });

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
    assert.equal(ok.body.pagination.strategy, 'cursor');
    assert.equal('total' in ok.body.pagination, false);
    assert.equal('offset' in ok.body.pagination, false);
    assert.equal(ok.body.pagination.pageInfo.hasMore, true);
    assert.ok(ok.body.pagination.pageInfo.nextCursor);
  });

  it('retains total and offset metadata for explicit legacy requests', async () => {
    seedDeposits(5);

    const res = await httpGet('/api/analytics/history?vaultId=vault_a&limit=2&offset=0');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 2);
    assert.equal(res.body.pagination.strategy, 'offset');
    assert.equal(res.body.pagination.total, 5);
    assert.equal(res.body.pagination.offset, 0);
  });

  for (const order of ['asc', 'desc']) {
    it(`rejects a filtered ${order} offset that exceeds the scan budget and recovers with cursors`, async () => {
      const expected = [];
      for (let i = 0; i < 10; i += 1) {
        const [tx] = seedDeposits(1);
        tx.timestamp = i % 2 === 0 ? '2026-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z';
        if (i % 2 === 0) expected.push(tx.txHash);
      }
      analyticsHistoryService.rebuildIndex();
      if (order === 'desc') expected.reverse();

      let reads = 0;
      for (const tx of store.transactions.values()) {
        const timestamp = tx.timestamp;
        Object.defineProperty(tx, 'timestamp', {
          enumerable: true,
          get() {
            reads += 1;
            return timestamp;
          },
        });
      }

      const previousMaxScan = config.analyticsPagination.maxScan;
      config.analyticsPagination.maxScan = 3;
      try {
        const qs = new URLSearchParams({
          vaultId: 'vault_a', to: '2026-01-01T00:00:00.000Z', order, offset: '3', limit: '1',
        });
        const rejected = await httpGet(`/api/analytics/history?${qs}`);
        assert.equal(rejected.status, 400);
        assert.equal(rejected.body.error.details.code, 'OFFSET_TOO_DEEP');
        assert.equal(rejected.body.error.details.maxScan, 3);
        assert.equal(reads, 3, 'rejected offset must not run the full filtered count');
        assert.equal('pagination' in rejected.body, false);

        // Restarting without an offset must walk the entire filtered ledger,
        // including short pages, without dropping the outstanding skip into a
        // cursor and accidentally returning part of the skipped prefix.
        qs.delete('offset');
        const seen = [];
        let pages = 0;
        for (;;) {
          const res = await httpGet(`/api/analytics/history?${qs}`);
          assert.equal(res.status, 200);
          assert.equal(res.body.pagination.strategy, 'cursor');
          assert.equal('total' in res.body.pagination, false);
          assert.ok(res.body.pagination.pageInfo.scanned <= 3);
          seen.push(...res.body.events.map((tx) => tx.txHash));
          pages += 1;
          assert.ok(pages <= 10, 'cursor walk must terminate');
          if (!res.body.pagination.pageInfo.hasMore) break;
          assert.ok(res.body.pagination.pageInfo.nextCursor);
          qs.set('cursor', res.body.pagination.pageInfo.nextCursor);
        }
        assert.deepEqual(seen, expected);
      } finally {
        config.analyticsPagination.maxScan = previousMaxScan;
      }
    });

    it(`keeps the ${order} offset reached exactly at the scan budget resumable`, async () => {
      const matching = [];
      for (let i = 0; i < 11; i += 1) {
        const [tx] = seedDeposits(1);
        tx.timestamp = i % 2 === 0 ? '2026-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z';
        if (i % 2 === 0) matching.push(tx.txHash);
      }
      analyticsHistoryService.rebuildIndex();
      if (order === 'desc') matching.reverse();

      const previousMaxScan = config.analyticsPagination.maxScan;
      config.analyticsPagination.maxScan = 3;
      try {
        const qs = new URLSearchParams({
          vaultId: 'vault_a', to: '2026-01-01T00:00:00.000Z', order, offset: '2', limit: '1',
        });
        const first = await httpGet(`/api/analytics/history?${qs}`);
        assert.equal(first.status, 200);
        assert.deepEqual(first.body.events, []);
        assert.equal(first.body.pagination.offset, 2);
        assert.equal(first.body.pagination.total, 6);
        assert.equal(first.body.pagination.pageInfo.scanned, 3);
        assert.equal(first.body.pagination.pageInfo.scanTruncated, true);
        assert.ok(first.body.pagination.pageInfo.nextCursor);

        qs.delete('offset');
        qs.set('cursor', first.body.pagination.pageInfo.nextCursor);
        const resumed = await httpGet(`/api/analytics/history?${qs}`);
        assert.equal(resumed.status, 200);
        assert.deepEqual(resumed.body.events.map((tx) => tx.txHash), [matching[2]]);
      } finally {
        config.analyticsPagination.maxScan = previousMaxScan;
      }
    });
  }

  it('keeps an offset beyond the filtered collection empty when the scan reaches the end', async () => {
    seedDeposits(1, { user: 'alice' });
    seedDeposits(1, { user: 'bob' });
    seedDeposits(1, { user: 'alice' });
    const previousMaxScan = config.analyticsPagination.maxScan;
    config.analyticsPagination.maxScan = 3;
    try {
      const res = await httpGet(
        '/api/analytics/history?vaultId=vault_a&actor=alice&order=asc&offset=3&limit=1'
      );
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.events, []);
      assert.equal(res.body.pagination.total, 2);
      assert.equal(res.body.pagination.offset, 3);
      assert.equal(res.body.pagination.pageInfo.hasMore, false);
      assert.equal(res.body.pagination.pageInfo.nextCursor, null);
      assert.equal(res.body.pagination.pageInfo.scanTruncated, false);
    } finally {
      config.analyticsPagination.maxScan = previousMaxScan;
    }
  });

  it('bounds predicate work on an initial page with a selective filter', () => {
    seedDeposits(25);
    let reads = 0;
    for (const tx of store.transactions.values()) {
      const timestamp = tx.timestamp;
      Object.defineProperty(tx, 'timestamp', {
        enumerable: true,
        get() {
          reads += 1;
          return timestamp;
        },
      });
    }

    const previousMaxScan = config.analyticsPagination.maxScan;
    config.analyticsPagination.maxScan = 5;
    try {
      const result = analyticsHistoryService.listHistory({
        query: { from: '2100-01-01T00:00:00.000Z', limit: '2' },
        headers: {},
      });
      assert.equal(result.events.length, 0);
      assert.equal(result.pagination.strategy, 'cursor');
      assert.equal(result.pagination.pageInfo.scanTruncated, true);
      assert.equal(result.pagination.pageInfo.hasMore, true);
      assert.ok(result.pagination.pageInfo.nextCursor);
      assert.ok(reads <= config.analyticsPagination.maxScan);
    } finally {
      config.analyticsPagination.maxScan = previousMaxScan;
    }
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
