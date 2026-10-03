/**
 * The bound message: the exact string a payment signature covers.
 * Pure construction only. No signing, no keys, no network.
 */
import {
  BOUND_MESSAGE_TAG,
  type Authorization,
  type PaymentRequirements,
} from './types.js';

/**
 * Canonical form of a resource URL for payment binding. Agent and service must
 * agree on the exact string even when hosts differ in case, default ports are
 * present or absent, or paths carry trailing slashes.
 */
export function normalizeResourceUrl(url: string): string {
  const u = new URL(url);
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
}

/**
 * The bound message, per scheme_exact_tachi.md:
 *
 *   sats402-exact-tachi:v1:nonce:<64 hex>:after:<unix>:before:<unix>:
 *   value:<sats>:to:<payee xonly>:network:<network>:resource:<url>
 *
 * The signature covers the complete challenge (network, amount, payee,
 * resource, nonce, validity window), so a payment made for one request cannot
 * be presented for another.
 */
export function buildBoundMessage(
  accepted: PaymentRequirements,
  authorization: Authorization,
  resourceUrl: string
): string {
  return [
    BOUND_MESSAGE_TAG,
    `nonce:${authorization.nonce}`,
    `after:${authorization.validAfter}`,
    `before:${authorization.validBefore}`,
    `value:${accepted.amount}`,
    `to:${accepted.payTo}`,
    `network:${accepted.network}`,
    `resource:${resourceUrl}`,
  ].join(':');
}
