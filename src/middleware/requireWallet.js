'use strict';

const { badRequest } = require('../utils/errors');
const { isOperatorRole } = require('../auth/positionAccess');

/**
 * Bind the caller to a wallet principal for position routes (#65).
 *
 * Identity is taken from `X-Wallet-Address` (mock auth, consistent with the
 * existing `X-Audit-Role` header pattern). Optional operator elevation uses
 * `X-Audit-Role: admin|auditor`.
 *
 * Controllers must use `req.wallet` / `req.isOperator` and must not trust a
 * client-supplied body/query `user` for authorization decisions.
 */
function requireWallet(req, _res, next) {
  const raw = req.get('X-Wallet-Address');
  if (typeof raw !== 'string' || !raw.trim()) {
    return next(
      badRequest('X-Wallet-Address header is required', {
        header: 'X-Wallet-Address',
      })
    );
  }

  const wallet = raw.trim();
  if (wallet.length < 3 || wallet.length > 128) {
    return next(
      badRequest('X-Wallet-Address has an invalid length', {
        header: 'X-Wallet-Address',
      })
    );
  }

  req.wallet = wallet;
  req.isOperator = isOperatorRole(req.get('X-Audit-Role'));
  return next();
}

module.exports = requireWallet;
