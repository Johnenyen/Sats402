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
