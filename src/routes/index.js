'use strict';

const express = require('express');

const healthRoutes = require('./healthRoutes');
const versionRoutes = require('./versionRoutes');
const vaultRoutes = require('./vaultRoutes');
const positionRoutes = require('./positionRoutes');
const analyticsRoutes = require('./analyticsRoutes');
const transactionRoutes = require('./transactionRoutes');
const auditRoutes = require('./auditRoutes');
const reconciliationRoutes = require('./reconciliationRoutes');

const router = express.Router();

// GET /api - lists available API resources for discoverability.
router.get('/', (req, res) => {
  res.json({
    name: 'YieldVault API',
    resources: [
      '/api/health',
      '/api/version',
      '/api/vaults',
      '/api/positions',
      '/api/analytics',
      '/api/transactions',
      '/api/reconciliation',
    ],
  });
});

// Mount feature routers under the /api namespace.
router.use('/health', healthRoutes);
router.use('/version', versionRoutes);
router.use('/vaults', vaultRoutes);
router.use('/positions', positionRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/transactions', transactionRoutes);
router.use('/audit', auditRoutes);
router.use('/reconciliation', reconciliationRoutes);

module.exports = router;
