'use strict';

const config = require('../config');
const { tooManyRequests } = require('../utils/errors');

/**
 * Route-specific rate limiter for wallet-sensitive mutation routes.
 *
 * Identity model
 * --------------
 * Each request is keyed by BOTH:
 *   - authenticated actor  (X-Wallet-Address, else validated body.user, else "anonymous")
 *   - trusted client id    (see resolveClientId)
 *
 * Applying both prevents one client from burning many actors' quotas and
 * prevents one actor from being amplified across forged client headers when
 * proxy trust is disabled.
 *
 * A separate client-only bucket also bounds anonymous / actor-spoofing bursts
 * against the same route scope.
 *
 * Storage is intentionally bounded (maxKeys + expiry eviction) so abusive
 * unique-key floods cannot grow memory without bound.
 *
 * Proxy / header trust
 * --------------------
 * X-Forwarded-For and similar hop headers are ONLY honoured when
 * config.trustProxy is enabled (TRUST_PROXY=true). Otherwise the client id is
 * taken from the direct socket remote address. Never treat an untrusted
 * X-Wallet-Address as proof of identity for authorization — here it is only
 * used as a rate-limit partition key, matching the mock auth header style
 * used elsewhere (X-Audit-Role).
 */

const stores = new Map(); // scope -> { hits: Map, meta }

function getStore(scope) {
  let store = stores.get(scope);
  if (!store) {
    store = { hits: new Map() };
    stores.set(scope, store);
  }
  return store;
}

function normalizeActor(raw) {
  if (typeof raw !== 'string') return 'anonymous';
  const trimmed = raw.trim();
  if (!trimmed) return 'anonymous';
  // Bound + shape-check so pathological headers cannot inflate key size.
  if (trimmed.length > 64 || !/^[A-Za-z0-9_:-]+$/.test(trimmed)) {
    return 'anonymous';
  }
  return trimmed.toLowerCase();
}

function resolveActor(req) {
  const header = req.get('X-Wallet-Address');
  if (header) return normalizeActor(header);
  if (req.body && typeof req.body.user === 'string') {
    return normalizeActor(req.body.user);
  }
  return 'anonymous';
}

/**
 * Resolve the trusted client identity.
 * When trustProxy is false, ignore forwarded headers entirely.
 */
function resolveClientId(req) {
  if (config.trustProxy) {
    // Prefer Express' computed req.ip when trust proxy is configured on the app.
    const ip = req.ip || firstForwarded(req) || socketAddress(req);
    return ip || 'unknown';
  }
  return socketAddress(req) || 'unknown';
}

function firstForwarded(req) {
  const raw = req.get('X-Forwarded-For');
  if (!raw || typeof raw !== 'string') return null;
  // Left-most hop is the original client when the immediate proxy is trusted.
  const first = raw.split(',')[0].trim();
  return first || null;
}

function socketAddress(req) {
  return (
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    null
  );
}

function evictExpired(hits, now) {
  for (const [key, entry] of hits) {
    if (now >= entry.resetAt) {
      hits.delete(key);
    }
  }
}

function nextResetAt(hits, windowMs, now) {
  let resetAt = now + windowMs;
  for (const entry of hits.values()) {
    resetAt = Math.min(resetAt, entry.resetAt);
  }
  return resetAt;
}

function touch(hits, key, windowMs, now) {
  let entry = hits.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
  }
  entry.count += 1;
  hits.set(key, entry);
  return entry;
}

function setRateHeaders(res, limit, entry, now) {
  const remaining = Math.max(0, limit - entry.count);
  const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset', resetSeconds);
  return resetSeconds;
}

function walletRateLimit(options = {}) {
  const scope = options.scope || 'wallet';

  function middleware(req, res, next) {
    // Resolve store + quotas per request so tests can reset safely and hot
    // config can tune limits without reloading the route module.
    const store = getStore(scope);
    const windowMs = options.windowMs || config.walletRateLimit.windowMs;
    const maxPerActor = options.maxPerActor || config.walletRateLimit.maxPerActor;
    const maxPerClient = options.maxPerClient || config.walletRateLimit.maxPerClient;
    const maxKeys = options.maxKeys || config.walletRateLimit.maxKeys;

    const now = Date.now();
    const actor = resolveActor(req);
    const clientId = resolveClientId(req);

    const clientKey = `client:${clientId}`;
    const actorKey = `actor:${actor}:client:${clientId}`;
    evictExpired(store.hits, now);

    // Reserve both keys before changing either counter. Live windows must not
    // be evicted: replacing them lets identity churn reset exhausted quotas.
    const missingKeys = Number(!store.hits.has(clientKey)) + Number(!store.hits.has(actorKey));
    if (missingKeys > 0 && store.hits.size + missingKeys > maxKeys) {
      const limit = Math.min(maxPerActor, maxPerClient);
      const retryAfter = setRateHeaders(res, limit, {
        count: limit,
        resetAt: nextResetAt(store.hits, windowMs, now),
      }, now);
      res.setHeader('Retry-After', retryAfter);
      return next(tooManyRequests('Too many requests', {
        retryAfter,
        code: 'RATE_LIMITED',
      }));
    }

    // Client-only budget bounds floods regardless of the claimed actor.
    const clientEntry = touch(store.hits, clientKey, windowMs, now);
    const actorEntry = touch(store.hits, actorKey, windowMs, now);

    // Surface the stricter remaining budget to the client.
    setRateHeaders(res, maxPerActor, actorEntry, now);
    const clientRemaining = Math.max(0, maxPerClient - clientEntry.count);
    const actorRemaining = Math.max(0, maxPerActor - actorEntry.count);
    if (clientRemaining < actorRemaining) {
      setRateHeaders(res, maxPerClient, clientEntry, now);
    }

    const clientExceeded = clientEntry.count > maxPerClient;
    const actorExceeded = actorEntry.count > maxPerActor;

    if (clientExceeded || actorExceeded) {
      // Both counters include this rejected request. A bucket exactly at its
      // limit also blocks the next attempt, so wait for every exhausted budget.
      const useClient = clientEntry.count >= maxPerClient
        && (actorEntry.count < maxPerActor || clientEntry.resetAt > actorEntry.resetAt);
      const retryAfter = setRateHeaders(
        res,
        useClient ? maxPerClient : maxPerActor,
        useClient ? clientEntry : actorEntry,
        now
      );
      res.setHeader('Retry-After', retryAfter);
      // Generic message: never echo actor/wallet or account existence.
      return next(
        tooManyRequests('Too many requests', {
          retryAfter,
          code: 'RATE_LIMITED',
        })
      );
    }

    // Stash resolved identity for downstream observability (not authorization).
    req.rateLimitIdentity = { scope, actor, clientId };
    return next();
  }

  middleware._scope = scope;
  return middleware;
}

/** Test helper: drop all in-memory counters without discarding store refs. */
function resetWalletRateLimitStores() {
  for (const store of stores.values()) {
    store.hits.clear();
  }
}

/** Test helper: current total tracked keys across scopes. */
function walletRateLimitKeyCount() {
  let total = 0;
  for (const store of stores.values()) {
    total += store.hits.size;
  }
  return total;
}

module.exports = walletRateLimit;
module.exports.resolveActor = resolveActor;
module.exports.resolveClientId = resolveClientId;
module.exports.resetWalletRateLimitStores = resetWalletRateLimitStores;
module.exports.walletRateLimitKeyCount = walletRateLimitKeyCount;
