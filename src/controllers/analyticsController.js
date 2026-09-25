'use strict';

const analyticsService = require('../services/analyticsService');
const analyticsHistoryService = require('../services/analyticsHistoryService');

/**
 * Analytics controller: aggregate protocol metrics.
 */
function getAnalytics(req, res) {
  const analytics = analyticsService.getAnalytics();
  res.json({ analytics });
}

function getTvlHistory(req, res) {
  const days = parseInt(req.query.days, 10) || 30;
  const history = analyticsService.getTvlHistory(days);
  res.json({ count: history.length, history });
}

function listHistory(req, res) {
  const result = analyticsHistoryService.listHistory(req);
  res.json({
    count: result.events.length,
    events: result.events,
    pagination: result.pagination,
  });
}

module.exports = { getAnalytics, getTvlHistory, listHistory };

