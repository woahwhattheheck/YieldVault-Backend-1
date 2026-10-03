'use strict';

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config');
const routes = require('./routes');
const healthController = require('./controllers/healthController');
const asyncHandler = require('./utils/asyncHandler');
const securityHeaders = require('./middleware/securityHeaders');
const requestTimeout = require('./middleware/requestTimeout');
const requestId = require('./middleware/requestId');
const requestLogger = require('./middleware/requestLogger');
const rateLimit = require('./middleware/rateLimit');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

/**
 * Build and configure the Express application. Kept separate from server.js so
 * the app can be imported for testing without binding a port.
 */
function createApp() {
  const app = express();

  // Core middleware. CORS is restricted to the configured origin allowlist
  // unless it contains '*', in which case any origin is permitted.
  const allowAnyOrigin = config.corsOrigins.includes('*');
  app.use(
    cors({
      origin: allowAnyOrigin ? true : config.corsOrigins,
    })
  );
  app.use(securityHeaders);
  app.use(requestTimeout());
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(morgan(config.env === 'development' ? 'dev' : 'combined'));
  app.use(requestId);
  app.use(requestLogger);

  // Process liveness must stay available when traffic or failed readiness
  // probes exhaust the API quota. GET also handles HEAD through Express.
  app.get('/api/health/live', asyncHandler(healthController.getLiveness));

  // API routes (rate limited).
  app.use('/api', rateLimit());
  app.use('/api', routes);

  // Root welcome message.
  app.get('/', (req, res) => {
    res.json({
      service: 'yieldvault-backend',
      message: 'YieldVault API. See /api/health',
    });
  });

  // 404 and error handling (must come last).
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
