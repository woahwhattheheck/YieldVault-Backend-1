'use strict';

const config = require('../config');
const { tooManyRequests } = require('../utils/errors');

/**
 * Minimal in-memory rate limiter using a fixed-window counter per client IP.
 * Avoids external dependencies, which suits the in-memory, single-process mock
 * backend. For multi-instance deployments a shared store would be required.
 *
 * Storage is bounded: expired windows are pruned and new clients receive 429
 * when `maxKeys` is reached. Active counters are retained so identity churn
 * cannot reset an exhausted quota.
 *
 * Proxy trust: when `config.trustProxy` is false (default), the key is the
 * direct socket address and X-Forwarded-For is ignored. Enable TRUST_PROXY
 * only behind a trusted reverse proxy — see docs/RATE_LIMITS.md.
 */
function rateLimit(options = {}) {
  const windowMs = options.windowMs || config.rateLimit.windowMs;
  const max = options.max || config.rateLimit.max;
  const maxKeys = options.maxKeys || config.rateLimit.maxKeys;
  const hits = new Map();

  function clientKey(req) {
    if (config.trustProxy) {
      return req.ip || req.socket?.remoteAddress || 'unknown';
    }
    return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  }

  function pruneExpired(now) {
    let nextResetAt = now + windowMs;
    for (const [key, entry] of hits) {
      if (now >= entry.resetAt) {
        hits.delete(key);
      } else {
        nextResetAt = Math.min(nextResetAt, entry.resetAt);
      }
    }
    return nextResetAt;
  }

  return function rateLimitMiddleware(req, res, next) {
    const key = clientKey(req);
    const now = Date.now();
    const nextResetAt = pruneExpired(now);
    let entry = hits.get(key);
    const capacityExceeded = !entry && hits.size >= maxKeys;

    if (capacityExceeded) {
      // Response metadata only; never insert a rejected client's counter.
      entry = { count: max, resetAt: nextResetAt };
    } else {
      if (!entry) entry = { count: 0, resetAt: now + windowMs };
      entry.count += 1;
      hits.set(key, entry);
    }

    const remaining = Math.max(0, max - entry.count);
    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetSeconds);

    if (capacityExceeded || entry.count > max) {
      res.setHeader('Retry-After', resetSeconds);
      return next(
        tooManyRequests('Rate limit exceeded, slow down', { retryAfter: resetSeconds })
      );
    }

    next();
  };
}

module.exports = rateLimit;
