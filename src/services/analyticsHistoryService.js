'use strict';

const store = require('../store');
const config = require('../config');
const { OrderedIndex } = require('../utils/orderedIndex');
const { buildHistoryPage } = require('../utils/historyPage');
const { badRequest } = require('../utils/errors');

/**
 * Analytics vault-history index.
 *
 * Deposit/withdraw ledger rows are appended here in creation order so analytics
 * clients can page with a cursor that stays stable under concurrent inserts.
 * Vault, actor, and combined buckets avoid scanning unrelated ledger rows.
 * Buckets share records and global sequences, so existing cursors remain valid.
 */
const historyIndex = new OrderedIndex({
  sortKeyOf: (tx) => tx.timestamp,
  groupKeysOf: (tx) => {
    const keys = [];
    if (tx.vaultId) keys.push(JSON.stringify(['vault', tx.vaultId]));
    // Actor matching is strict string equality, just like buildMatch below.
    if (typeof tx.user === 'string' && tx.user) {
      keys.push(JSON.stringify(['actor', tx.user]));
      if (tx.vaultId) keys.push(JSON.stringify(['vaultActor', tx.vaultId, tx.user]));
    }
    return keys;
  },
});

let bootstrapped = false;

/**
 * Ensure the in-memory index mirrors store.transactions.
 * Idempotent; safe to call from tests after store resets.
 */
function ensureIndex() {
  // Cold start only. Size drift after boot is a bug (double-append / missed
  // write); tests should call rebuildIndex() explicitly after store resets.
  if (!bootstrapped) {
    rebuildIndex();
  }
}

function rebuildIndex() {
  historyIndex.reset();
  // Insertion order of a Map is deterministic; treat that as creation order.
  for (const tx of store.transactions.values()) {
    historyIndex.append(tx);
  }
  bootstrapped = true;
}

/**
 * Append a newly written ledger row. Called from position mutations AFTER the
 * row has been written to store.transactions.
 * @param {object} tx
 */
function recordTransaction(tx) {
  if (!bootstrapped) {
    // Rebuild includes the row already in the store; do not append again.
    rebuildIndex();
    return;
  }
  historyIndex.append(tx);
}

/**
 * Canonical filter set used both for querying and for cursor fingerprints.
 * Undefined / empty values are dropped so equivalent requests fingerprint alike.
 */
function normalizeFilters({ vaultId, actor, from, to } = {}) {
  const filters = {};
  if (vaultId) filters.vaultId = String(vaultId);
  if (actor) filters.actor = String(actor);
  if (from) filters.from = String(from);
  if (to) filters.to = String(to);
  return filters;
}

function parseTimeBound(raw, label) {
  if (raw == null || raw === '') return null;
  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) {
    throw badRequest(`${label} must be an ISO-8601 timestamp`, {
      code: 'INVALID_TIME_BOUND',
      field: label,
    });
  }
  return ms;
}

function buildMatch(filters) {
  const fromMs = parseTimeBound(filters.from, 'from');
  const toMs = parseTimeBound(filters.to, 'to');
  if (fromMs != null && toMs != null && fromMs > toMs) {
    throw badRequest('from must be <= to', { code: 'INVALID_TIME_RANGE' });
  }

  return (tx) => {
    if (filters.actor && tx.user !== filters.actor) return false;
    if (fromMs != null || toMs != null) {
      const ts = Date.parse(tx.timestamp);
      if (!Number.isFinite(ts)) return false;
      if (fromMs != null && ts < fromMs) return false;
      if (toMs != null && ts > toMs) return false;
    }
    return true;
  };
}

/**
 * Indexed scan used by {@link buildHistoryPage}.
 */
function historyGroup(filters) {
  if (filters.actor) {
    return JSON.stringify(filters.vaultId
      ? ['vaultActor', filters.vaultId, filters.actor]
      : ['actor', filters.actor]);
  }
  return filters.vaultId ? JSON.stringify(['vault', filters.vaultId]) : null;
}

function queryHistory({ order, limit, afterSeq, skip, maxScan, filters }) {
  ensureIndex();
  const match = buildMatch(filters);
  const group = historyGroup(filters);
  return historyIndex.scan({
    afterSeq,
    order,
    group,
    limit,
    maxScan,
    match,
    skip,
  });
}

function countMatching(filters) {
  ensureIndex();
  const match = buildMatch(filters);
  const records = historyIndex.recordsFor(historyGroup(filters));
  let total = 0;
  for (const record of records) {
    if (match(record.item)) total += 1;
  }
  return total;
}

function resolvePosition(seq) {
  ensureIndex();
  const record = historyIndex.recordAt(seq);
  return record ? record.key : null;
}

/**
 * Page analytics vault history for an HTTP request.
 *
 * @param {import('express').Request} req
 * @returns {{ events: object[], pagination: object }}
 */
function listHistory(req) {
  const filters = normalizeFilters({
    vaultId: req.query.vaultId,
    actor: req.query.actor || req.query.user,
    from: req.query.from,
    to: req.query.to,
  });

  const { items, envelope } = buildHistoryPage({
    req,
    collection: 'analytics.vaultHistory',
    filters,
    defaultOrder: 'desc',
    query: (args) => queryHistory({ ...args, filters }),
    countTotal: () => countMatching(filters),
    resolvePosition,
  });

  return {
    events: items,
    pagination: {
      ...envelope,
      strategy: envelope.pageInfo && envelope.offset === undefined
        ? 'cursor'
        : envelope.offset !== undefined
          ? 'offset'
          : 'cursor',
      filters,
      maxLimit: config.analyticsPagination.maxLimit,
    },
  };
}

/**
 * Test / diagnostics helpers.
 */
function getIndexSize() {
  ensureIndex();
  return historyIndex.size;
}

module.exports = {
  listHistory,
  recordTransaction,
  rebuildIndex,
  ensureIndex,
  getIndexSize,
  normalizeFilters,
  // Exposed for unit tests of the index contract.
  _historyIndex: historyIndex,
};
