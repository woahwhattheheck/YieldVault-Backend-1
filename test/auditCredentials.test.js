'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { parseAuditReaderCredentials, authenticateAuditReader } = require('../src/utils/auditCredentials');

function credential(token, subject = 'report-reader', role = 'auditor') {
  return { subject, role, tokenSha256: createHash('sha256').update(token).digest('hex') };
}

test('opaque credentials resolve to immutable server-owned identities and support rotation', () => {
  const oldToken = randomBytes(32).toString('base64url');
  const newToken = randomBytes(32).toString('base64url');
  const readers = parseAuditReaderCredentials(JSON.stringify([
    credential(oldToken), credential(newToken),
  ]));
  assert.ok(Object.isFrozen(readers));
  assert.ok(readers.every(Object.isFrozen));
  for (const token of [oldToken, newToken]) {
    const principal = authenticateAuditReader(`Bearer ${token}`, readers);
    assert.deepEqual(principal, { subject: 'report-reader', role: 'auditor' });
    assert.ok(Object.isFrozen(principal));
    assert.equal(JSON.stringify(readers).includes(token), false);
  }

  const rotated = parseAuditReaderCredentials(JSON.stringify([credential(newToken)]));
  assert.equal(authenticateAuditReader(`Bearer ${oldToken}`, rotated), null);
  assert.deepEqual(authenticateAuditReader(`bEaReR ${newToken}`, rotated), {
    subject: 'report-reader', role: 'auditor',
  });
});

test('missing registries and invalid credentials fail closed', () => {
  const token = randomBytes(32).toString('base64url');
  const entry = credential(token);
  const readers = parseAuditReaderCredentials(JSON.stringify([entry]));
  for (const raw of [undefined, '', '[]']) {
    assert.equal(authenticateAuditReader(`Bearer ${token}`, parseAuditReaderCredentials(raw)), null);
  }
  for (const authorization of [
    undefined, null, ['Bearer', token], token, `Basic ${token}`, 'Bearer short',
    `Bearer ${token}=`, `Bearer ${token}, Bearer ${token}`, `Bearer ${'x'.repeat(300)}`,
    `Bearer ${entry.tokenSha256}`, `Bearer ${randomBytes(32).toString('base64url')}`,
  ]) {
    assert.equal(authenticateAuditReader(authorization, readers), null);
  }
});

test('malformed, ambiguous and oversized credential registries reject without echoing input', () => {
  const secretMarker = randomBytes(32).toString('base64url');
  const entry = credential(secretMarker);
  const invalid = [
    secretMarker, '{}', 'null', '[null]',
    JSON.stringify([{ ...entry, subject: '' }]),
    JSON.stringify([{ ...entry, subject: ' reader ' }]),
    JSON.stringify([{ ...entry, subject: 'reader\nadmin' }]),
    JSON.stringify([{ ...entry, role: 'admin,auditor' }]),
    JSON.stringify([{ ...entry, tokenSha256: secretMarker }]),
    JSON.stringify([{ ...entry, token: secretMarker }]),
    JSON.stringify([entry, { ...entry, subject: 'another-reader' }]),
    JSON.stringify(Array.from({ length: 101 }, () => entry)),
  ];
  for (const raw of invalid) {
    assert.throws(() => parseAuditReaderCredentials(raw), (error) => {
      assert.match(error.message, /^AUDIT_READER_CREDENTIALS /);
      assert.equal(error.message.includes(secretMarker), false);
      assert.equal(error.message.includes(entry.tokenSha256), false);
      return true;
    });
  }
});

test('malformed credential configuration stops server startup without exposing its contents', () => {
  const secretMarker = randomBytes(32).toString('base64url');
  const result = spawnSync(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AUDIT_READER_CREDENTIALS: secretMarker },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AUDIT_READER_CREDENTIALS must be a valid JSON array/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secretMarker), false);
  assert.equal(result.stdout.includes('backend listening'), false);
});

test('real report requests deny an empty registry and never log Authorization credentials', () => {
  const token = randomBytes(32).toString('base64url');
  const entry = credential(token);
  const script = `
    const http = require('node:http');
    const server = http.createServer(require('./src/app')());
    server.listen(0, '127.0.0.1', async () => {
      try {
        const receipts = [];
        for (const route of ['/api/audit', '/api/reconciliation']) {
          for (const suffix of ['', 'invalid']) {
            const response = await fetch('http://127.0.0.1:' + server.address().port + route, {
              headers: { Authorization: 'Bearer ' + process.env.SYNTHETIC_AUDIT_TOKEN + suffix, 'X-Audit-Role': 'admin' },
            });
            await response.text();
            receipts.push({ status: response.status, cache: response.headers.get('cache-control') });
          }
        }
        console.log('AUTH_HTTP_RECEIPT ' + JSON.stringify(receipts));
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });
  `;
  for (const configured of [false, true]) {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'debug',
        AUDIT_READER_CREDENTIALS: JSON.stringify(configured ? [entry] : []),
        SYNTHETIC_AUDIT_TOKEN: token,
      },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(output.includes(token), false);
    assert.equal(output.includes(entry.tokenSha256), false);
    assert.match(output, /GET \/api\/audit/);
    assert.match(output, /GET \/api\/reconciliation/);
    const receipt = result.stdout.split('\n').find((line) => line.startsWith('AUTH_HTTP_RECEIPT '));
    assert.ok(receipt);
    const responses = JSON.parse(receipt.slice('AUTH_HTTP_RECEIPT '.length));
    assert.deepEqual(responses.map((response) => response.status), configured ? [200, 401, 200, 401] : [401, 401, 401, 401]);
    assert.ok(responses.every((response) => response.cache === 'private, no-store'));
  }
});
