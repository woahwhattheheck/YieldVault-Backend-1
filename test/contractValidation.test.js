'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { createHash, randomBytes } = require('node:crypto');
const path = require('node:path');

const { definitions } = require('../src/contracts/definitions');
const { inspectResponse, listContracts, validateFixtureSet, validateResponse } = require('../src/services/contractValidationService');
const contractFacade = require('../src/contracts');
const { validate } = require('../src/contracts/schema');
const createApp = require('../src/app');
const config = require('../src/config');
const store = require('../src/store');
const seed = require('../src/store/seed');
const positionService = require('../src/services/positionService');
const transactionService = require('../src/services/transactionService');

const fixtureDirectory = path.join(__dirname, '..', 'src', 'contracts', 'fixtures');
const fixtures = fs.readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => [name, JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), 'utf8'))]);

test('the v1 registry exposes every consumer-facing response contract', () => {
  assert.deepEqual(listContracts().map((item) => item.name), [
    'vaultList', 'positionList', 'depositSuccess', 'withdrawSuccess', 'transactionPage', 'errorResponse',
  ]);
  assert.equal(listContracts().every((item) => item.version === 'v1'), true);
});

test('the public facade validates and freezes the contract registry', () => {
  assert.deepEqual(contractFacade.names(), listContracts().map((item) => item.name));
  assert.equal(Object.isFrozen(contractFacade.names()), true);
  const fixture = fixtures.find(([name]) => name === 'vault-list.json')[1];
  assert.equal(contractFacade.check('vaultList', fixture).valid, true);
  assert.doesNotThrow(() => contractFacade.enforce('vaultList', fixture));
  assert.throws(() => contractFacade.check('missing', {}), /Unknown v1 contract/);
});

test('success and failure fixtures are valid and deterministic', () => {
  validateResponse('vaultList', fixtures.find(([name]) => name === 'vault-list.json')[1]);
  validateResponse('positionList', fixtures.find(([name]) => name === 'position-list.json')[1]);
  validateResponse('depositSuccess', fixtures.find(([name]) => name === 'deposit-success.json')[1]);
  validateResponse('withdrawSuccess', fixtures.find(([name]) => name === 'withdraw-pending.json')[1]);
  for (const name of ['authorization-error.json', 'provider-failure.json', 'validation-error.json']) {
    validateResponse('errorResponse', fixtures.find(([fixture]) => fixture === name)[1]);
  }
  validateResponse('transactionPage', fixtures.find(([name]) => name === 'transactions-page.json')[1]);
});

test('fixture-set validation reports each named contract independently', () => {
  const result = validateFixtureSet({
    vaultList: fixtures.find(([name]) => name === 'vault-list.json')[1],
    positionList: fixtures.find(([name]) => name === 'position-list.json')[1],
  });
  assert.deepEqual(result.map((item) => item.name), ['vaultList', 'positionList']);
  assert.equal(result.every((item) => item.valid), true);
});

test('missing required fields produce actionable paths', () => {
  const result = inspectResponse('transactionPage', { count: 1, pagination: {} });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '$.transactions'));
  assert.ok(result.errors.some((error) => error.path === '$.pagination.total'));
});

test('status, operation, pagination, and precision constraints are enforced', () => {
  const fixture = fixtures.find(([name]) => name === 'transactions-page.json')[1];
  const invalid = structuredClone(fixture);
  invalid.transactions[0].status = 'settled';
  invalid.transactions[0].amount = 1.1234567;
  invalid.pagination.limit = 0;
  const result = inspectResponse('transactionPage', invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '$.transactions[0].status'));
  assert.ok(result.errors.some((error) => error.path === '$.transactions[0].amount'));
  assert.ok(result.errors.some((error) => error.path === '$.pagination.limit'));
});

test('unknown response contracts fail closed', () => {
  assert.throws(() => validateResponse('not-a-contract', {}), /Unknown response contract/);
  assert.deepEqual(inspectResponse('not-a-contract', {}), {
    valid: false,
    errors: [{ path: '$', message: 'unknown contract' }],
  });
});

test('schemas reject undocumented response fields', () => {
  const fixture = fixtures.find(([name]) => name === 'transactions-page.json')[1];
  const result = validate({ ...fixture, debug: true }, definitions.transactionPage);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '$.debug'));
});

test('assertion preserves the machine-readable validation code', () => {
  assert.throws(
    () => validateResponse('errorResponse', { error: { status: 700 } }),
    (error) => error.code === 'CONTRACT_VALIDATION_FAILED' && Array.isArray(error.details)
  );
});

async function openApi(t) {
  const previousCredentials = config.positionCredentials;
  const token = randomBytes(32).toString('base64url');
  config.positionCredentials = Object.freeze([Object.freeze({
    subject: 'alice', role: 'user',
    tokenSha256: createHash('sha256').update(token).digest('hex'),
  })]);
  t.after(() => { config.positionCredentials = previousCredentials; });
  for (const collection of Object.values(store)) {
    if (collection instanceof Map) collection.clear();
  }
  seed();
  const server = http.createServer(createApp());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    vaultId: [...store.vaults.keys()][0],
    async request(route, payload) {
      const response = await fetch(origin + route, {
        method: payload ? 'POST' : 'GET',
        signal: AbortSignal.timeout(5000),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload && { 'Content-Type': 'application/json' }),
        },
        ...(payload && { body: JSON.stringify(payload) }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

function assertProviderReceiptPreserved(tx) {
  const stored = store.transactions.get(tx.txHash);
  assert.equal(stored.status, 'SUCCESS');
  assert.equal(typeof stored.network, 'string');
  assert.equal(Number.isInteger(stored.ledger), true);
  assert.equal(transactionService.getTransactionStatus(tx.txHash).status, 'confirmed');
  assert.equal(tx.status, 'confirmed');
  assert.equal(Object.hasOwn(tx, 'network'), false);
  assert.equal(Object.hasOwn(tx, 'ledger'), false);
}

test('HTTP deposit returns a v1 receipt without changing stored provider evidence', async (t) => {
  const api = await openApi(t);
  const response = await api.request('/api/positions/deposit', {
    user: 'alice', vaultId: api.vaultId, amount: 10, idempotencyKey: 'contract-deposit',
  });
  assert.equal(response.status, 201);
  validateResponse('depositSuccess', response.body);
  assert.equal(response.body.position.principal, 10);
  assert.equal(store.transactions.size, 1);
  assertProviderReceiptPreserved(response.body.tx);
});

test('HTTP partial withdrawal returns a v1 receipt and the remaining position', async (t) => {
  const api = await openApi(t);
  positionService.deposit({ user: 'alice', vaultId: api.vaultId, amount: 10 });
  const response = await api.request('/api/positions/withdraw', {
    user: 'alice', vaultId: api.vaultId, shares: 2, idempotencyKey: 'contract-partial',
  });
  assert.equal(response.status, 200);
  validateResponse('withdrawSuccess', response.body);
  assert.ok(response.body.position.shares > 0);
  assert.equal(store.transactions.size, 2);
  assertProviderReceiptPreserved(response.body.tx);
});

test('HTTP full withdrawal returns a v1 receipt with a null position', async (t) => {
  const api = await openApi(t);
  const deposit = positionService.deposit({ user: 'alice', vaultId: api.vaultId, amount: 10 });
  const response = await api.request('/api/positions/withdraw', {
    user: 'alice', vaultId: api.vaultId, shares: deposit.position.shares,
    idempotencyKey: 'contract-full-withdraw',
  });
  assert.equal(response.status, 200);
  validateResponse('withdrawSuccess', response.body);
  assert.equal(response.body.position, null);
  assert.equal(store.positions.size, 0);
  assertProviderReceiptPreserved(response.body.tx);
});

test('HTTP transaction pages serialize real deposit and withdrawal receipts', async (t) => {
  const api = await openApi(t);
  positionService.deposit({ user: 'alice', vaultId: api.vaultId, amount: 10 });
  positionService.withdraw({ user: 'alice', vaultId: api.vaultId, shares: 2 });
  const storedBefore = structuredClone([...store.transactions.values()]);
  const seen = [];
  for (const offset of [0, 1]) {
    const response = await api.request(`/api/transactions?user=alice&limit=1&offset=${offset}`);
    assert.equal(response.status, 200);
    validateResponse('transactionPage', response.body);
    assert.equal(response.body.count, 1);
    assert.deepEqual(response.body.pagination, { total: 2, limit: 1, offset, hasMore: offset === 0 });
    const tx = response.body.transactions[0];
    assertProviderReceiptPreserved(tx);
    const stored = store.transactions.get(tx.txHash);
    assert.equal(tx.user, stored.user);
    assert.equal(tx.vaultId, stored.vaultId);
    assert.equal(tx.amount, stored.amount);
    assert.equal(tx.shares, stored.shares);
    assert.equal(tx.assets, stored.assets);
    seen.push(tx.txHash);
  }
  assert.equal(new Set(seen).size, 2);
  assert.deepEqual([...store.transactions.values()], storedBefore);
});

test('HTTP history preserves every canonical v1 transaction state', async (t) => {
  const api = await openApi(t);
  const fixture = fixtures.find(([name]) => name === 'transactions-page.json')[1];
  for (const status of ['pending', 'submitted', 'confirmed', 'failed']) {
    store.transactions.clear();
    const tx = { ...fixture.transactions[0], status };
    store.transactions.set(tx.txHash, tx);
    const response = await api.request('/api/transactions?limit=1');
    assert.equal(response.status, 200);
    validateResponse('transactionPage', response.body);
    assert.deepEqual(response.body.transactions, [tx]);
  }
});

test('HTTP receipt serialization still rejects undocumented fields', async (t) => {
  const api = await openApi(t);
  const { tx } = positionService.deposit({ user: 'alice', vaultId: api.vaultId, amount: 10 });
  store.transactions.get(tx.txHash).debug = 'unexpected provider field';
  const response = await api.request('/api/transactions');
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: { message: 'Internal server error', status: 500 } });
  assert.equal(store.transactions.get(tx.txHash).debug, 'unexpected provider field');
});

test('HTTP receipt serialization does not promote unsupported statuses to success', async (t) => {
  const api = await openApi(t);
  const { tx } = positionService.deposit({ user: 'alice', vaultId: api.vaultId, amount: 10 });
  store.transactions.get(tx.txHash).status = 'settled';
  const response = await api.request('/api/transactions');
  assert.equal(response.status, 500);
  assert.equal(store.transactions.get(tx.txHash).status, 'settled');
});

test('HTTP receipt serialization preserves precision and required-field failures', async (t) => {
  const api = await openApi(t);
  const { tx } = positionService.deposit({ user: 'alice', vaultId: api.vaultId, amount: 10 });
  const stored = store.transactions.get(tx.txHash);
  stored.amount = 1.1234567;
  assert.equal((await api.request('/api/transactions')).status, 500);
  stored.amount = 10;
  delete stored.timestamp;
  assert.equal((await api.request('/api/transactions')).status, 500);
  assert.equal(Object.hasOwn(stored, 'timestamp'), false);
});
