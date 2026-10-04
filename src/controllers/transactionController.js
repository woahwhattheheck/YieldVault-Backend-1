'use strict';

const transactionService = require('../services/transactionService');
const { paginate } = require('../utils/pagination');
const { validateResponse } = require('../services/contractValidationService');

/**
 * Transaction controller: lists mock transaction history.
 */
function listTransactions(req, res) {
  const transactions = transactionService.listTransactions(req.query.user);
  const { data, pagination } = paginate(transactions, req.query);
  const response = {
    count: data.length,
    pagination,
    transactions: data.map(transactionService.serializeTransaction),
  };
  validateResponse('transactionPage', response);
  res.json(response);
}

function getTransactionStatus(req, res) {
  res.json({ transaction: transactionService.getTransactionStatus(req.params.txHash) });
}

module.exports = { getTransactionStatus, listTransactions };
