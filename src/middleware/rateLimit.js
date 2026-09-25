'use strict';

const config = require('../config');
const { tooManyRequests } = require('../utils/errors');

/**
 * Minimal in-memory rate limiter using a fixed-window counter per client IP.
 * Avoids external dependencies, which suits the in-memory, single-process mock
 * backend. For multi-instance deployments a shared store would be required.
 *
 * Storage is bounded: expired windows are pruned and the oldest windows are
 * evicted once `maxKeys` is reached so abusive unique-IP floods cannot grow
 * memory without bound.
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

  function evict(now) {
    for (const [key, entry] of hits) {
      if (now >= entry.resetAt) hits.delete(key);
    }
    if (hits.size <= maxKeys) return;
    const ordered = Array.from(hits.entries()).sort(
      (a, b) => a[1].resetAt - b[1].resetAt
    );
    const overflow = hits.size - maxKeys;
    for (let i = 0; i < overflow; i += 1) {
      hits.delete(ordered[i][0]);
    }
  }

  return function rateLimitMiddleware(req, res, next) {
    const key = clientKey(req);
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
    }

    entry.count += 1;
    hits.set(key, entry);
    evict(now);

    const remaining = Math.max(0, max - entry.count);
    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetSeconds);

    if (entry.count > max) {
      res.setHeader('Retry-After', resetSeconds);
      return next(
        tooManyRequests('Rate limit exceeded, slow down', { retryAfter: resetSeconds })
      );
    }

    next();
  };
}

module.exports = rateLimit;
