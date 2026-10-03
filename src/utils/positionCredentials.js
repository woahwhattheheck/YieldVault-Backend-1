'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');

const CONFIG_NAME = 'POSITION_CREDENTIALS';
const MAX_PRINCIPALS = 100;

/** Compile server-provisioned demo identities without retaining raw tokens. */
function parsePositionCredentials(raw) {
  if (raw === undefined || raw === '') return Object.freeze([]);
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    // JSON.parse errors can quote their input, which may contain credentials.
    throw new Error(`${CONFIG_NAME} must be a valid JSON array`);
  }
  if (!Array.isArray(entries) || entries.length > MAX_PRINCIPALS) {
    throw new Error(`${CONFIG_NAME} must contain at most ${MAX_PRINCIPALS} entries`);
  }

  const seen = new Set();
  const principals = entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).length !== 3 ||
        typeof entry.subject !== 'string' || entry.subject.length < 1 || entry.subject.length > 128 ||
        entry.subject.trim() !== entry.subject || /[\u0000-\u001f\u007f-\u009f]/.test(entry.subject) ||
        typeof entry.role !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(entry.role) ||
        typeof entry.tokenSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.tokenSha256)) {
      throw new Error(`${CONFIG_NAME} entries require subject, role, and a SHA-256 token digest`);
    }
    const tokenSha256 = entry.tokenSha256.toLowerCase();
    if (seen.has(tokenSha256)) {
      throw new Error(`${CONFIG_NAME} contains a duplicate token digest`);
    }
    seen.add(tokenSha256);
    // Keep both credentials for the same subject during an explicit rotation.
    return Object.freeze({ subject: entry.subject, role: entry.role, tokenSha256 });
  });
  return Object.freeze(principals);
}

/** Authenticate a demo principal from config; this does not verify a wallet signature. */
function authenticatePositionPrincipal(authorization, principals) {
  if (typeof authorization !== 'string' || authorization.length > 256) return null;
  const match = /^Bearer +([A-Za-z0-9_-]{43,128})$/i.exec(authorization);
  if (!match) return null;

  const presented = createHash('sha256').update(match[1]).digest();
  let principal = null;
  for (const entry of principals) {
    const expected = Buffer.from(entry.tokenSha256, 'hex');
    if (timingSafeEqual(presented, expected)) {
      principal = Object.freeze({ subject: entry.subject, role: entry.role });
    }
  }
  return principal;
}

module.exports = { parsePositionCredentials, authenticatePositionPrincipal };
