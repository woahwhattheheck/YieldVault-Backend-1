'use strict';

const store = require('../store');
const lifecycle = require('./transactionLifecycleService');

/**
 * Transaction service: read access to the mock transaction history recorded by
 * deposit/withdraw flows.
 */
function listTransactions(user) {
  return Array.from(store.transactions.values())
    .filter((tx) => !user || tx.user === user)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

/**
 * Present legacy provider receipts through the v1 HTTP contract without
 * changing stored evidence. Leave other fields intact so the response
 * validator still rejects undocumented fields and unsupported values.
 */
function serializeTransaction(tx) {
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return tx;
  const response = { ...tx };
  delete response.network;
  delete response.ledger;
  if (response.status === 'SUCCESS') response.status = 'confirmed';
  return response;
}

function getTransactionStatus(txHash) {
  return lifecycle.publicStatus(txHash);
}

module.exports = {
  listTransactions,
  serializeTransaction,
  getTransactionStatus,
};
