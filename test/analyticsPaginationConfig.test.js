'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { OrderedIndex } = require('../src/utils/orderedIndex');
const errors = require('../src/utils/errors');

// Isolate environment parsing from the developer's .env file and module cache.
// The real config and pagination source run unchanged; only dotenv I/O is omitted.
function loadPagination(env = {}) {
  const configModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/config/index.js'), 'utf8'), {
    module: configModule,
    process: { env },
    require: (name) => {
      assert.equal(name, 'dotenv');
      return { config() {} };
    },
  });
  const paginationModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/utils/pagination.js'), 'utf8'), {
    module: paginationModule,
    require: (name) => {
      if (name === '../config') return configModule.exports;
      assert.equal(name, './errors');
      return errors;
    },
  });
  return { ...paginationModule.exports, config: configModule.exports.analyticsPagination };
}

function indexOfSize(size) {
  const index = new OrderedIndex({ sortKeyOf: (item) => item.timestamp });
  for (let id = 0; id < size; id += 1) index.append({ id, timestamp: String(id) });
  return index;
}

test('valid pagination settings preserve defaults, explicit values and lowered page ceilings', () => {
  assert.deepEqual({ ...loadPagination().config }, { defaultLimit: 50, maxLimit: 100, maxScan: 10000 });
  const { config, parseHistoryPagination } = loadPagination({
    ANALYTICS_PAGE_DEFAULT_LIMIT: ' +7 ', ANALYTICS_PAGE_MAX_LIMIT: '2', ANALYTICS_PAGE_MAX_SCAN: '3',
  });
  assert.deepEqual({ ...config }, { defaultLimit: 7, maxLimit: 2, maxScan: 3 });
  assert.equal(parseHistoryPagination({}).limit, 2);
  assert.throws(() => parseHistoryPagination({ limit: '3' }), (error) => error.details.code === 'LIMIT_TOO_LARGE');
});

test('malformed, nonpositive and unsafe pagination settings use finite positive defaults', () => {
  for (const raw of ['', ' ', '0', '-1', '2.5', '12rows', '1e3', '9007199254740992', '9'.repeat(400)]) {
    const { config } = loadPagination({
      ANALYTICS_PAGE_DEFAULT_LIMIT: raw, ANALYTICS_PAGE_MAX_LIMIT: raw, ANALYTICS_PAGE_MAX_SCAN: raw,
    });
    assert.deepEqual({ ...config }, { defaultLimit: 50, maxLimit: 100, maxScan: 10000 }, raw);
  }
});

test('a negative scan setting cannot produce a non-advancing first page', () => {
  const { config, parseHistoryPagination } = loadPagination({ ANALYTICS_PAGE_MAX_SCAN: '-1' });
  const page = indexOfSize(2).scan({ ...parseHistoryPagination({}), maxScan: config.maxScan });
  assert.equal(page.items.length, 2);
  assert.equal(page.hasMore, false);
  assert.notEqual(page.last, null);
});

test('overflow settings cannot disable the page ceiling or the selective scan budget', () => {
  const { config, parseHistoryPagination } = loadPagination({
    ANALYTICS_PAGE_MAX_LIMIT: '9'.repeat(400), ANALYTICS_PAGE_MAX_SCAN: '9'.repeat(400),
  });
  assert.throws(() => parseHistoryPagination({ limit: '101' }), (error) => error.details.code === 'LIMIT_TOO_LARGE');
  const index = indexOfSize(10001);
  const first = index.scan({ limit: 50, maxScan: config.maxScan, order: 'asc', match: () => false });
  assert.equal(first.scanned, 10000);
  assert.equal(first.hasMore, true);
  assert.equal(first.last.seq, 9999);
  const last = index.scan({ limit: 50, maxScan: config.maxScan, order: 'asc', afterSeq: first.last.seq });
  assert.deepEqual(last.items.map((item) => item.id), [10000]);
  assert.equal(last.hasMore, false);
});
