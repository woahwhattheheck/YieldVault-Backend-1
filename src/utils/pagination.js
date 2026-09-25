'use strict';

const { badRequest } = require('./errors');
const config = require('../config');

/**
 * Pagination helpers for list endpoints.
 *
 * Parses `limit` and `offset` query parameters into safe, bounded numbers and
 * applies them to an array, returning the page alongside metadata clients need
 * to render paging controls.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Coerce raw query values into a clean { limit, offset } pair. Invalid or
 * out-of-range inputs fall back to safe defaults rather than erroring.
 */
function parseParams(query = {}) {
  let limit = parseInt(query.limit, 10);
  if (!Number.isInteger(limit) || limit <= 0) {
    limit = DEFAULT_LIMIT;
  }
  limit = Math.min(limit, MAX_LIMIT);

  let offset = parseInt(query.offset, 10);
  if (!Number.isInteger(offset) || offset < 0) {
    offset = 0;
  }

  return { limit, offset };
}

/**
 * Slice an array into a page and attach pagination metadata.
 */
function paginate(items, query = {}) {
  const { limit, offset } = parseParams(query);
  const data = items.slice(offset, offset + limit);
  return {
    data,
    pagination: {
      total: items.length,
      limit,
      offset,
      hasMore: offset + limit < items.length,
    },
  };
}

/**
 * Strict pagination parser for analytics / history collections.
 *
 * Unlike {@link parseParams} this rejects out-of-range input instead of
 * quietly correcting it: a client that asks for 10 000 rows and receives 100
 * has no way to tell it did not receive everything, which is exactly the class
 * of bug an unbounded history query causes downstream.
 *
 * @param {object} query
 * @param {object} [options]
 * @param {'asc'|'desc'} [options.defaultOrder]
 * @param {number} [options.defaultLimit]
 * @param {number} [options.maxLimit]
 * @returns {{ mode: 'cursor'|'offset', limit: number, order: 'asc'|'desc', cursor: string|null, offset: number }}
 */
function parseHistoryPagination(query = {}, options = {}) {
  const {
    defaultOrder = 'desc',
    defaultLimit = config.analyticsPagination.defaultLimit,
    maxLimit = config.analyticsPagination.maxLimit,
  } = options;

  const limit = parseHistoryLimit(query.limit, defaultLimit, maxLimit);
  const order = parseHistoryOrder(query.order, defaultOrder);
  const cursor = query.cursor == null || query.cursor === '' ? null : String(query.cursor);
  const offset = parseHistoryOffset(query.offset);

  if (cursor !== null && offset > 0) {
    throw badRequest('Provide either cursor or offset, not both', {
      code: 'CONFLICTING_PAGINATION',
    });
  }

  return {
    mode: cursor !== null ? 'cursor' : 'offset',
    limit,
    order,
    cursor,
    offset,
  };
}

function parseHistoryLimit(raw, defaultLimit, maxLimit) {
  if (raw == null || raw === '') return defaultLimit;
  const limit = toStrictInteger(raw);
  if (limit === null || limit < 1) {
    throw badRequest('limit must be a positive integer', {
      code: 'INVALID_LIMIT',
      maxLimit,
    });
  }
  if (limit > maxLimit) {
    throw badRequest(`limit may not exceed ${maxLimit}`, {
      code: 'LIMIT_TOO_LARGE',
      maxLimit,
    });
  }
  return limit;
}

function parseHistoryOffset(raw) {
  if (raw == null || raw === '') return 0;
  const offset = toStrictInteger(raw);
  if (offset === null || offset < 0) {
    throw badRequest('offset must be a non-negative integer', {
      code: 'INVALID_OFFSET',
    });
  }
  return offset;
}

function parseHistoryOrder(raw, defaultOrder) {
  if (raw == null || raw === '') return defaultOrder;
  if (raw !== 'asc' && raw !== 'desc') {
    throw badRequest('order must be "asc" or "desc"', {
      code: 'INVALID_ORDER',
      allowed: ['asc', 'desc'],
    });
  }
  return raw;
}

/**
 * Strict integer parse: rejects "12abc", "1.5", "1e3" and other values that
 * parseInt would happily truncate.
 */
function toStrictInteger(raw) {
  const text = String(raw).trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parseParams,
  paginate,
  parseHistoryPagination,
};

