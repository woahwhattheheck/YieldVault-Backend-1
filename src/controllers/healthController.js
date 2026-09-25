'use strict';

const config = require('../config');
const store = require('../store');
const { SERVICE_NAME, API_VERSION } = require('../utils/constants');
const dependencyHealth = require('../services/dependencyHealthService');

/**
 * Health controller.
 *
 * Liveness answers "is the process up?" and must stay cheap and dependency-
 * free so orchestrators do not restart a process that is merely waiting on
 * a degraded dependency. Readiness answers "can this instance serve traffic?"
 * by running bounded, redacted dependency probes that recover automatically
 * once the dependency is healthy again.
 */

/**
 * GET /api/health
 * Full service health report (not a dependency gate).
 */
function getHealth(req, res) {
  res.json({
    status: 'ok',
    service: SERVICE_NAME,
    version: API_VERSION,
    env: config.env,
    network: config.stellar.network,
    uptime: process.uptime(),
    store: store.stats(),
    timestamp: new Date().toISOString(),
  });
}

/**
 * GET /api/health/live
 * Liveness probe: confirms the process is up and responding. Intentionally
 * ignores store / chain / queue state so outages do not flap restarts.
 */
function getLiveness(req, res) {
  res.json({ status: 'alive', uptime: process.uptime() });
}

/**
 * GET /api/health/ready
 * Readiness probe: bounded checks against store, chain, and queue.
 * Returns 200 when every dependency is healthy and 503 otherwise. Reason
 * codes are redacted; recovery is automatic on the next successful probe.
 */
async function getReadiness(req, res) {
  const result = await dependencyHealth.evaluateReadiness();
  const payload = {
    status: result.status,
    checks: result.checks,
    timeoutMs: result.timeoutMs,
    timestamp: new Date().toISOString(),
  };
  res.status(result.ready ? 200 : 503).json(payload);
}

module.exports = { getHealth, getLiveness, getReadiness };
