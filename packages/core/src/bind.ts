/**
 * Payment binding: the client side of `exact` on Tachi.
 *
 * The signature covers the complete challenge (network, amount, payee,
 * resource, nonce, validity window), so a payment made for one request cannot
 * be presented for another.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import {
  BOUND_MESSAGE_TAG,
  X402_VERSION,
  type Authorization,
  type PaymentPayload,
  type PaymentRequirements,
  type ResourceInfo,
  type TachiSettlement,
} from './types.js';
import { buildBoundMessage } from './binding.js';
import type { SchnorrSigner } from './keys.js';

/** 32 random bytes as 64 lowercase hex (nonce). */
export function randomNonce(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface FormPaymentArgs {
  /** The requirement the client chose to pay. */
  accepted: PaymentRequirements;
  /** The resource being requested (its URL enters the bound message). */
  resource: ResourceInfo;
  /** Payer signer; its x-only public key becomes authorization.from. */
  signer: SchnorrSigner;
  /** Payer x-only owner key (64 lowercase hex). */
  from: string;
  /** Settlement proof: the tachi_tx hash the client broadcast. */
  settlement: TachiSettlement;
  /** Validity window, unix seconds. Defaults: now-60 .. now+3600. */
  validAfter?: number;
  validBefore?: number;
  nonce?: string;
  nowSeconds?: number;
}

function bytesToHex(u: Uint8Array): string {
  return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Form and sign a PaymentPayload for an already-broadcast settlement.
 * The client settles first (it signs and broadcasts its own tachi_tx), then
 * presents this payload on the paid retry.
 */
export function formPayment(args: FormPaymentArgs): PaymentPayload {
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const authorization: Authorization = {
    from: args.from,
    to: args.accepted.payTo,
    value: args.accepted.amount,
    validAfter: String(args.validAfter ?? now - 60),
    validBefore: String(args.validBefore ?? now + 3600),
    nonce: args.nonce ?? randomNonce(),
  };

  const message = buildBoundMessage(args.accepted, authorization, args.resource.url);
  const digest = sha256(new TextEncoder().encode(message));
  const signature = bytesToHex(args.signer.signSchnorr(digest));

  return {
    x402Version: X402_VERSION,
    resource: args.resource,
    accepted: args.accepted,
    payload: {
      signature,
      authorization,
      settlement: { ...args.settlement },
    },
  };
}
