'use strict';

const { AppError } = require('../utils/errors');
const config = require('../config');
const { authenticateAuditReader } = require('../utils/auditCredentials');

module.exports = function requireAuditRole(req, res, next) {
  res.setHeader('Cache-Control', 'private, no-store');
  const principal = authenticateAuditReader(req.get('Authorization'), config.auditReaderCredentials);
  if (!principal) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="yieldvault-audit"');
    return next(new AppError('Authentication is required to read audit reports', 401));
  }
  if (principal.role !== 'admin' && principal.role !== 'auditor') {
    return next(new AppError('An admin or auditor role is required to read audit reports', 403));
  }
  req.auditPrincipal = principal;
  return next();
};
