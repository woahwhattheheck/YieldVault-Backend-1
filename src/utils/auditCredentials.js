'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');

const CONFIG_NAME = 'AUDIT_READER_CREDENTIALS';
const MAX_READERS = 100;

/** Compile a server-owned credential registry without retaining raw tokens. */
function parseAuditReaderCredentials(raw) {
  if (raw === undefined || raw === '') return Object.freeze([]);
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    // JSON.parse errors can quote their input, which may contain credentials.
    throw new Error(`${CONFIG_NAME} must be a valid JSON array`);
  }
  if (!Array.isArray(entries) || entries.length > MAX_READERS) {
    throw new Error(`${CONFIG_NAME} must contain at most ${MAX_READERS} entries`);
  }

  const seen = new Set();
  const readers = entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).length !== 3 ||
        typeof entry.subject !== 'string' || entry.subject.length < 1 || entry.subject.length > 128 ||
        entry.subject.trim() !== entry.subject || /[\u0000-\u001f\u007f]/.test(entry.subject) ||
        typeof entry.role !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(entry.role) ||
        typeof entry.tokenSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.tokenSha256)) {
      throw new Error(`${CONFIG_NAME} entries require subject, role, and a SHA-256 token digest`);
    }
    const tokenSha256 = entry.tokenSha256.toLowerCase();
    if (seen.has(tokenSha256)) {
      throw new Error(`${CONFIG_NAME} contains a duplicate token digest`);
    }
    seen.add(tokenSha256);
    // The same subject may have two credentials during an explicit rotation.
    return Object.freeze({ subject: entry.subject, role: entry.role, tokenSha256 });
  });
  return Object.freeze(readers);
}

/** Authenticate a bounded opaque token; identity and role come only from config. */
function authenticateAuditReader(authorization, readers) {
  if (typeof authorization !== 'string' || authorization.length > 256) return null;
  const match = /^Bearer +([A-Za-z0-9_-]{43,128})$/i.exec(authorization);
  if (!match) return null;

  const presented = createHash('sha256').update(match[1]).digest();
  let principal = null;
  for (const reader of readers) {
    const expected = Buffer.from(reader.tokenSha256, 'hex');
    if (timingSafeEqual(presented, expected)) {
      principal = Object.freeze({ subject: reader.subject, role: reader.role });
    }
  }
  return principal;
}

module.exports = { parseAuditReaderCredentials, authenticateAuditReader };
