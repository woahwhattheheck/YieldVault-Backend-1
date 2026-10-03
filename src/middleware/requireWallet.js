'use strict';

const config = require('../config');
const { unauthorized } = require('../utils/errors');
const { isOperatorRole } = require('../auth/positionAccess');
const { authenticatePositionPrincipal } = require('../utils/positionCredentials');

/**
 * Bind the caller to a wallet principal for position routes (#65).
 *
 * Identity and role come only from a server-provisioned opaque credential.
 * Caller-selected wallet and role headers carry no authentication authority.
 *
 * Controllers must use `req.wallet` / `req.isOperator` and must not trust a
 * client-supplied body/query `user` for authorization decisions.
 */
function requireWallet(req, res, next) {
  res.setHeader('Cache-Control', 'private, no-store');
  const principal = authenticatePositionPrincipal(
    req.get('Authorization'), config.positionCredentials
  );
  if (!principal) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="yieldvault-positions"');
    return next(unauthorized('Authentication is required to access positions'));
  }

  req.positionPrincipal = principal;
  req.wallet = principal.subject;
  req.isOperator = isOperatorRole(principal.role);
  return next();
}

module.exports = requireWallet;
