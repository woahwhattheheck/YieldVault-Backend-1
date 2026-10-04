'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderedIndex } = require('../src/utils/orderedIndex');

function walk(index, group = null) {
  const ids = [];
  let afterSeq = null;
  for (;;) {
    const page = index.scan({ afterSeq, group, order: 'asc', limit: 1, maxScan: 2 });
    ids.push(...page.items.map((item) => item.id));
    if (!page.hasMore) return ids;
    assert.ok(page.last, 'a continuation needs a frontier');
    assert.notEqual(page.last.seq, afterSeq, 'a continuation must advance');
    afterSeq = page.last.seq;
  }
}

function row(id) {
  return { id, timestamp: '2026-10-04T12:00:00.000Z', vault: { id: 'vault-a' } };
}

test('failed sort extraction preserves dense sequence and later cursor pages', () => {
  const index = new OrderedIndex({ sortKeyOf: (item) => item.timestamp });
  index.append(row('a'));
  assert.throws(() => index.append(null), TypeError);
  index.append(row('b'));
  index.append(row('c'));

  assert.equal(index.nextSeq, 3);
  assert.equal(index.size, 3);
  assert.deepEqual([0, 1, 2].map((seq) => index.recordAt(seq).item.id), ['a', 'b', 'c']);
  assert.deepEqual(walk(index), ['a', 'b', 'c']);
});

test('failed group extraction leaves no record in global or grouped history', () => {
  const index = new OrderedIndex({
    sortKeyOf: (item) => item.timestamp,
    groupKeysOf: (item) => [item.vault.id, item.vault.id],
  });
  index.append(row('a'));
  assert.throws(() => index.append({ ...row('rejected'), vault: null }), TypeError);
  index.append(row('b'));

  assert.equal(index.nextSeq, 2);
  assert.equal(index.size, 2);
  assert.deepEqual(walk(index), ['a', 'b']);
  assert.deepEqual(walk(index, 'vault-a'), ['a', 'b']);
});
