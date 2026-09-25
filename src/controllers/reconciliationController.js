'use strict';

const reconciliationService = require('../services/reconciliationService');

/**
 * Authenticated, read-only reconciliation report. Never mutates state.
 */
function getReport(req, res) {
  const report = reconciliationService.generateReport({
    limit: req.query.limit,
    offset: req.query.offset,
    vaultId: req.query.vaultId,
  });
  res.json(report);
}

module.exports = { getReport };
