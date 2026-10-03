'use strict';

require('dotenv').config();
const { parseAuditReaderCredentials } = require('../utils/auditCredentials');

/**
 * Centralised application configuration.
 * Values are read from environment variables with sensible defaults so the
 * server can boot even when no .env file is present.
 */
const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  stellar: {
    network: process.env.STELLAR_NETWORK || 'testnet',
    rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  },
  defaultApy: parseFloat(process.env.DEFAULT_APY) || 0.08,
  // Comma-separated allowlist of origins, or '*' to allow any (default).
  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 120,
  },
  // Maximum time a request may run before it is aborted with a 503.
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 15000,
  // Maximum accepted JSON request body size (passed to express.json).
  bodyLimit: process.env.BODY_LIMIT || '64kb',
  // Report-reader identities and roles are server-owned; an empty registry denies access.
  auditReaderCredentials: parseAuditReaderCredentials(process.env.AUDIT_READER_CREDENTIALS),
};

module.exports = config;
