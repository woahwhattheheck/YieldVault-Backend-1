'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { parsePositionCredentials, authenticatePositionPrincipal } = require('../src/utils/positionCredentials');

function credential(token, subject = 'Demo Owner', role = 'user') {
  return { subject, role, tokenSha256: createHash('sha256').update(token).digest('hex') };
}

test('credentials resolve to immutable provisioned subjects and roles without retaining tokens', () => {
  const token = randomBytes(32).toString('base64url');
  const otherToken = randomBytes(32).toString('base64url');
  const registry = parsePositionCredentials(JSON.stringify([
    credential(token, 'Demo Owner', 'user'),
    credential(otherToken, 'demo owner', 'position_admin'),
  ]));

  assert.ok(Object.isFrozen(registry));
  assert.ok(registry.every(Object.isFrozen));
  const principal = authenticatePositionPrincipal('Bearer ' + token, registry);
  assert.deepEqual(principal, { subject: 'Demo Owner', role: 'user' });
  assert.ok(Object.isFrozen(principal));
  assert.deepEqual(authenticatePositionPrincipal('Bearer ' + otherToken, registry), {
    subject: 'demo owner', role: 'position_admin',
  });
  assert.throws(() => { registry[0].subject = 'another owner'; }, TypeError);
  assert.throws(() => { principal.role = 'admin'; }, TypeError);
  assert.throws(() => registry.push(credential(token)), TypeError);
  assert.equal(JSON.stringify(registry).includes(token), false);
  assert.equal(JSON.stringify(registry).includes(otherToken), false);
  assert.deepEqual(Object.keys(principal).sort(), ['role', 'subject']);
});

test('explicit credential rotation allows overlap and revokes a removed token', () => {
  const oldToken = randomBytes(32).toString('base64url');
  const newToken = randomBytes(32).toString('base64url');
  const overlapping = parsePositionCredentials(JSON.stringify([
    credential(oldToken), credential(newToken),
  ]));
  for (const token of [oldToken, newToken]) {
    assert.deepEqual(authenticatePositionPrincipal('Bearer ' + token, overlapping), {
      subject: 'Demo Owner', role: 'user',
    });
  }
  const rotated = parsePositionCredentials(JSON.stringify([credential(newToken)]));
  assert.equal(authenticatePositionPrincipal('Bearer ' + oldToken, rotated), null);
  assert.deepEqual(authenticatePositionPrincipal('bEaReR   ' + newToken, rotated), {
    subject: 'Demo Owner', role: 'user',
  });
});

test('valid boundary subjects, roles and opaque token lengths remain usable', () => {
  for (const [token, subject, role] of [
    ['a'.repeat(43), 'A', 'u'],
    ['Z_-9'.repeat(32), 'S'.repeat(128), 'r'.repeat(32)],
  ]) {
    const entry = credential(token, subject, role);
    const registry = parsePositionCredentials(JSON.stringify([
      { ...entry, tokenSha256: entry.tokenSha256.toUpperCase() },
    ]));
    assert.equal(registry[0].tokenSha256, entry.tokenSha256);
    assert.deepEqual(authenticatePositionPrincipal('Bearer ' + token, registry), { subject, role });
  }
});

test('empty registries and malformed or unknown authorization values deny access', () => {
  const token = randomBytes(32).toString('base64url');
  const entry = credential(token);
  const registry = parsePositionCredentials(JSON.stringify([entry]));
  for (const raw of [undefined, '', '[]']) {
    const empty = parsePositionCredentials(raw);
    assert.ok(Object.isFrozen(empty));
    assert.equal(authenticatePositionPrincipal('Bearer ' + token, empty), null);
  }
  for (const authorization of [
    undefined, null, 12, {}, ['Bearer', token], '', token, 'Basic ' + token,
    'Bearer', 'Bearer ' + 'a'.repeat(42), 'Bearer ' + 'a'.repeat(129),
    'Bearer ' + 'a'.repeat(300), 'Bearer ' + token + '=', 'Bearer /' + token,
    'Bearer +' + token, 'Bearer\t' + token, ' Bearer ' + token,
    'Bearer ' + token + ' ', 'Bearer ' + token + '\n',
    'Bearer ' + token + ', Bearer ' + token,
    'Bearer ' + entry.tokenSha256, 'Bearer ' + randomBytes(32).toString('base64url'),
  ]) {
    assert.equal(authenticatePositionPrincipal(authorization, registry), null);
  }
});

test('malformed registry entries fail without echoing credentials or digests', () => {
  const marker = randomBytes(32).toString('base64url');
  const entry = credential(marker);
  const invalidEntries = [
    null, [], 'entry', {},
    { ...entry, subject: '' },
    { ...entry, subject: 123 },
    { ...entry, subject: ' owner' },
    { ...entry, subject: 'owner ' },
    { ...entry, subject: 'S'.repeat(129) },
    ...['\0', '\t', '\n', '\r', '\u007f', '\u0080', '\u0085', '\u009f'].map(
      (control) => ({ ...entry, subject: 'own' + control + 'er' }),
    ),
    { ...entry, role: '' },
    { ...entry, role: 'User' },
    { ...entry, role: '1user' },
    { ...entry, role: 'user admin' },
    { ...entry, role: 'user,admin' },
    { ...entry, role: 'user\n' },
    { ...entry, role: 'r'.repeat(33) },
    { ...entry, role: null },
    { ...entry, tokenSha256: 'a'.repeat(63) },
    { ...entry, tokenSha256: 'g'.repeat(64) },
    { ...entry, tokenSha256: entry.tokenSha256 + '\n' },
    { ...entry, tokenSha256: marker },
    { ...entry, tokenSha256: null },
    { ...entry, token: marker },
    { subject: entry.subject, role: entry.role, token: marker },
  ];
  const invalid = [marker, '{', '{}', 'null', '1', JSON.stringify(marker),
    ...invalidEntries.map((value) => JSON.stringify([value]))];
  for (const raw of invalid) {
    assert.throws(() => parsePositionCredentials(raw), (error) => {
      assert.match(error.message, /^POSITION_CREDENTIALS /);
      assert.equal(error.message.includes(marker), false);
      assert.equal(error.message.includes(entry.tokenSha256), false);
      return true;
    });
  }
});

test('registry size is bounded and duplicate digests are rejected regardless of hex case', () => {
  const entries = Array.from({ length: 101 }, (_, i) => credential(
    'position-token-' + String(i).padStart(43, '0'), 'owner-' + i,
  ));
  assert.equal(parsePositionCredentials(JSON.stringify(entries.slice(0, 100))).length, 100);
  assert.throws(() => parsePositionCredentials(JSON.stringify(entries)), /at most 100 entries/);
  const first = entries[0];
  assert.throws(() => parsePositionCredentials(JSON.stringify([
    first,
    { ...first, subject: 'other-owner', role: 'admin', tokenSha256: first.tokenSha256.toUpperCase() },
  ])), /duplicate token digest/);
});

test('malformed position configuration stops startup without exposing its contents', () => {
  const marker = randomBytes(32).toString('base64url');
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', 'src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, POSITION_CREDENTIALS: '{' + marker },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /POSITION_CREDENTIALS must be a valid JSON array/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(marker), false);
  assert.equal(result.stdout.includes('backend listening'), false);
});

test('authentication compares every configured digest for first, last and missing credentials', () => {
  // Instrument only the crypto boundary in an isolated helper process; this
  // checks full traversal without a noisy or platform-dependent timing test.
  const script = [
    "const crypto = require('node:crypto');",
    'const compare = crypto.timingSafeEqual;',
    'let comparisons = 0;',
    'crypto.timingSafeEqual = (a, b) => { comparisons++; return compare(a, b); };',
    'const { parsePositionCredentials, authenticatePositionPrincipal } = require(' +
      JSON.stringify(require.resolve('../src/utils/positionCredentials')) + ');',
    "const tokens = Array.from({ length: 100 }, (_, i) => String(i).padStart(43, 'a'));",
    'const registry = parsePositionCredentials(JSON.stringify(tokens.map((token, i) => ({',
    "  subject: 'owner-' + i, role: 'user',",
    "  tokenSha256: crypto.createHash('sha256').update(token).digest('hex'),",
    '}))));',
    'const result = [];',
    "for (const authorization of ['Bearer ' + tokens[0], 'Bearer ' + tokens[99], 'Bearer ' + 'z'.repeat(43), 'Bearer short']) {",
    '  comparisons = 0;',
    '  const principal = authenticatePositionPrincipal(authorization, registry);',
    '  result.push({ comparisons, subject: principal?.subject ?? null });',
    '}',
    'console.log(JSON.stringify(result));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', script], {
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { comparisons: 100, subject: 'owner-0' },
    { comparisons: 100, subject: 'owner-99' },
    { comparisons: 100, subject: null },
    { comparisons: 0, subject: null },
  ]);
});
