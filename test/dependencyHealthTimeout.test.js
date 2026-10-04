'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const config = require('../src/config');
const health = require('../src/services/dependencyHealthService');

test('readiness normalizes configured and explicit budgets to supported timers', async () => {
  const originalTimeout = config.health.checkTimeoutMs;
  try {
    for (const name of health.DEPENDENCIES) {
      health.setProbeForTests(name, async () => ({ ok: true }));
    }
    const invalid = [Infinity, -Infinity, 2147483648, NaN, 0, -1, undefined, 'invalid'];
    for (const value of invalid) {
      config.health.checkTimeoutMs = value;
      assert.equal(health.checkTimeoutMs(), 1000, `config ${String(value)}`);
      const readiness = await health.evaluateReadiness();
      assert.equal(readiness.timeoutMs, 1000);
      assert.equal(readiness.ready, true);
    }

    config.health.checkTimeoutMs = 200;
    for (const value of invalid) {
      const readiness = await health.evaluateReadiness({ timeoutMs: value });
      assert.equal(readiness.timeoutMs, 200, `override ${String(value)}`);
    }
    for (const [value, expected] of [[1, 1], ['37', 37], [37.9, 37], [0.5, 1], [2147483647, 2147483647]]) {
      config.health.checkTimeoutMs = value;
      assert.equal(health.checkTimeoutMs(), expected);
      assert.equal((await health.evaluateReadiness()).timeoutMs, expected);
      assert.equal((await health.evaluateReadiness({ timeoutMs: value })).timeoutMs, expected);
    }

    // Node converts Infinity and overflowing delays to 1ms. A healthy probe
    // completing after that point must receive the configured fallback budget.
    config.health.checkTimeoutMs = 200;
    health.setProbeForTests('chain', () => new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true }), 20);
    }));
    for (const value of [Infinity, 2147483648, NaN]) {
      assert.equal((await health.evaluateReadiness({ timeoutMs: value })).ready, true);
      assert.equal((await health.runCheck('chain', value)).status, 'ok');
    }

    // A valid short deadline still expires; the completed probe is not cached.
    assert.equal((await health.runCheck('chain', 1)).reason, 'CHAIN_TIMEOUT');
    assert.equal((await health.runCheck('chain', 200)).status, 'ok');
  } finally {
    config.health.checkTimeoutMs = originalTimeout;
    health.resetForTests();
  }
});
