'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const { newTxId } = require('../utils/ids');

/**
 * Mock Stellar / Soroban service.
 *
 * In a real deployment this module would build, sign and submit transactions to
 * a Soroban smart contract. Here everything is simulated in-process so the rest
 * of the backend can be developed and demoed without a live network.
 */

function isValidAddress(address) {
  // Stellar public keys start with 'G' and are 56 chars long. We keep the check
  // loose because mock users may supply simplified identifiers.
  return typeof address === 'string' && address.length >= 5;
}

/**
 * Simulate submitting a contract invocation. Always succeeds after a notional
 * "confirmation" and returns a fake transaction hash.
 */
function submitInvocation(operation, params = {}) {
  const txId = newTxId();
  logger.debug(
    `[stellar:${config.stellar.network}] submit ${operation}`,
    JSON.stringify(params)
  );
  return {
    txHash: txId,
    network: config.stellar.network,
    operation,
    status: 'SUCCESS',
    ledger: Math.floor(Date.now() / 5000),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Cheap readiness probe for the chain provider dependency. Confirms the
 * network is configured without performing an RPC round-trip (the mock has
 * no live client). Throws with a redacted reasonCode on misconfiguration.
 * @returns {{ ok: true, network: string }}
 */
function ping() {
  const network = config.stellar && config.stellar.network;
  if (typeof network !== 'string' || network.trim() === '') {
    const err = new Error('stellar network not configured');
    err.reasonCode = 'CHAIN_UNAVAILABLE';
    throw err;
  }
  return { ok: true, network };
}

module.exports = {
  isValidAddress,
  submitInvocation,
  ping,
};
