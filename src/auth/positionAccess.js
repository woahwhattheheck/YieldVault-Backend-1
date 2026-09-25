'use strict';

const { notFound, forbidden, badRequest } = require('../utils/errors');

/**
 * Shared position ownership policy (#65).
 *
 * Every position read and mutation goes through these helpers so route handlers
 * cannot accidentally expose another wallet's position by id or filter.
 *
 * Design choices:
 * - Missing and cross-wallet access both surface as an identical 404 for
 *   unprivileged callers. That prevents id enumeration while still matching
 *   the "indistinguishable not-found or forbidden" acceptance criterion.
 * - Privileged operators (`admin` / `auditor`) may inspect any position and
 *   may act on behalf of another wallet when an explicit target user is set.
 * - The binding always prefers the authenticated actor over a client-supplied
 *   `user` field so body/query spoofing cannot escalate.
 */

const OPERATOR_ROLES = new Set(['admin', 'auditor']);

const POSITION_NOT_FOUND = 'Position not found';

function isOperatorRole(role) {
  return typeof role === 'string' && OPERATOR_ROLES.has(role.trim().toLowerCase());
}

/**
 * Resolve the wallet that owns the resulting position mutation.
 *
 * @param {{ user?: string, actor?: string, isOperator?: boolean }} input
 * @returns {string}
 */
function resolveActingUser({ user, actor, isOperator = false } = {}) {
  const requested = typeof user === 'string' ? user.trim() : '';
  const bound = typeof actor === 'string' ? actor.trim() : '';

  if (bound) {
    if (isOperator && requested && requested !== bound) {
      return requested;
    }
    if (requested && requested !== bound) {
      throw forbidden('Not authorized to act for the requested user', {
        resource: 'position',
        action: 'write',
      });
    }
    return bound;
  }

  if (!requested) {
    throw badRequest('user is required');
  }
  return requested;
}

/**
 * Authorize a loaded position for the caller.
 * Unprivileged callers receive the same not-found error used for missing ids.
 *
 * @param {object|null|undefined} position
 * @param {{ actor?: string, isOperator?: boolean }} access
 * @param {{ action?: string }} [options]
 * @returns {object} the same position when authorized
 */
function assertPositionAccess(position, access = {}, options = {}) {
  const action = options.action || 'read';
  if (!position) {
    throw notFound(POSITION_NOT_FOUND);
  }

  const actor = typeof access.actor === 'string' ? access.actor.trim() : '';
  const operator = Boolean(access.isOperator);

  if (operator) {
    return position;
  }

  if (!actor) {
    throw forbidden('Not authorized to inspect this position', {
      resource: 'position',
      action,
    });
  }

  if (position.user !== actor) {
    throw notFound(POSITION_NOT_FOUND);
  }

  return position;
}

/**
 * Decide which user filter applies to list/summary queries.
 * Non-operators are always scoped to themselves; asking for another wallet
 * yields an empty result set rather than a 403 that confirms the wallet.
 *
 * @param {string|undefined} requestedUser
 * @param {{ actor?: string, isOperator?: boolean }} access
 * @returns {{ filter: string|null, empty: boolean }}
 */
function resolveListScope(requestedUser, access = {}) {
  const requested = typeof requestedUser === 'string' ? requestedUser.trim() : '';
  const actor = typeof access.actor === 'string' ? access.actor.trim() : '';
  const operator = Boolean(access.isOperator);

  if (operator) {
    return { filter: requested || null, empty: false };
  }

  if (!actor) {
    // Direct service/test callers may omit an HTTP actor and pass an explicit
    // user filter. An unscoped dump (no actor, no filter) is never allowed.
    if (requested) {
      return { filter: requested, empty: false };
    }
    throw forbidden('Not authorized to list positions', {
      resource: 'position',
      action: 'list',
    });
  }

  if (requested && requested !== actor) {
    return { filter: actor, empty: true };
  }

  return { filter: actor, empty: false };
}

module.exports = {
  OPERATOR_ROLES,
  POSITION_NOT_FOUND,
  isOperatorRole,
  resolveActingUser,
  assertPositionAccess,
  resolveListScope,
};
