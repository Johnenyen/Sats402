/**
 * Sats402 core types.
 *
 * Field names and shapes are taken from the x402 Protocol Specification v2
 * (PaymentRequired, PaymentRequirements, PaymentPayload, SettlementResponse)
 * and the Tachi network binding (specs/schemes/exact/scheme_exact_tachi.md).
 */

/** Protocol version. x402 v2 objects always carry 2. */
export const X402_VERSION = 2 as const;

/** The payment scheme this SDK implements on Tachi. */
export const SCHEME = 'exact' as const;

/** Canonical header names (x402 v2 HTTP transport). */
export const HEADER_PAYMENT_REQUIRED = 'PAYMENT-REQUIRED' as const;
export const HEADER_PAYMENT_SIGNATURE = 'PAYMENT-SIGNATURE' as const;
export const HEADER_PAYMENT_RESPONSE = 'PAYMENT-RESPONSE' as const;

/**
 * Network identifier for Tachi regtest: `tachi:` + the first 32 hex characters
 * of the underlying Bitcoin network's genesis block hash (BIP-122 convention),
 * as declared in scheme_exact_tachi.md. The regtest genesis prefix was read
 * live from the daemon (`getblockhash 0`) on 2026-10-03.
 */
export const NETWORK_TACHI_REGTEST =
  'tachi:0f9188f13cb7b2c71f2a335e3a4fc328' as const;

/** Domain-separation tag for the bound-message signature. */
export const BOUND_MESSAGE_TAG = 'sats402-exact-tachi:v2' as const;

/**
 * Tachi network name for a CAIP-2 network id (the TAURUS SDK network name).
 * Regtest is the build target; signet becomes a second mapping entry when
 * Tachi grants write access.
 */
export function tachiNetworkName(networkId: string): 'regtest' {
  if (networkId === NETWORK_TACHI_REGTEST) return 'regtest';
  throw new Error(`unsupported network id: ${networkId}`);
}

/** ResourceInfo object (x402 v2). */
export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

/** PaymentRequirements object (x402 v2), `exact` scheme on Tachi. */
export interface PaymentRequirements {
  scheme: typeof SCHEME;
  /** CAIP-2-style network id, e.g. `tachi:0f9188f13cb7b2c71f2a335e3a4fc328`. */
  network: string;
  /** Decimal sat string, exact match required. */
  amount: string;
  /** Asset identifier. On Tachi this is bitcoin: `BTC`. */
  asset: string;
  /** Payee x-only owner key: 64 lowercase hex characters. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/** PaymentRequired object (x402 v2), carried base64 in PAYMENT-REQUIRED. */
export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/**
 * Authorization fields. Mirrors the `exact` scheme's authorization shape
 * (from, to, value, validAfter, validBefore, nonce) with Bitcoin conventions:
 * unix seconds as decimal strings, nonce as 32 random bytes lowercase hex.
 */
export interface Authorization {
  /** Payer x-only owner key: 64 lowercase hex. */
  from: string;
  /** Payee x-only owner key; MUST equal accepted.payTo. */
  to: string;
  /** Decimal sat string; MUST equal accepted.amount. */
  value: string;
  /** Unix seconds, decimal string. */
  validAfter: string;
  /** Unix seconds, decimal string. */
  validBefore: string;
  /** 32 random bytes, 64 lowercase hex. */
  nonce: string;
}

/** Settlement proof: the tachi_tx the client broadcast (Tachi-specific). */
export interface TachiSettlement {
  /** Transaction hash, 64 lowercase hex. */
  txHash: string;
  /** Daemon-returned state at verification time, e.g. `committed`. */
  state?: string;
}

/** Scheme-specific payload for `exact` on Tachi. */
export interface TachiPayload {
  /** BIP-340 signature (128 hex) over the bound message by authorization.from. */
  signature: string;
  authorization: Authorization;
  settlement: TachiSettlement;
}

/** PaymentPayload object (x402 v2), carried base64 in PAYMENT-SIGNATURE. */
export interface PaymentPayload {
  x402Version: typeof X402_VERSION;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: TachiPayload;
  extensions?: Record<string, unknown>;
}

/** SettlementResponse object (x402 v2), carried base64 in PAYMENT-RESPONSE. */
export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  transaction: string;
  network: string;
  payer: string;
}

/** Error vocabulary (scheme_exact_tachi.md). */
export const ErrorCode = {
  INVALID_PAYMENT_REQUIREMENTS: 'invalid_payment_requirements',
  INVALID_PAYMENT_PAYLOAD: 'invalid_payment_payload',
  INVALID_SIGNATURE: 'invalid_signature',
  NETWORK_MISMATCH: 'network_mismatch',
  AMOUNT_MISMATCH: 'amount_mismatch',
  PAYEE_MISMATCH: 'payee_mismatch',
  SETTLEMENT_NOT_FOUND: 'settlement_not_found',
  SETTLEMENT_INSUFFICIENT: 'settlement_insufficient',
  REPLAY_DETECTED: 'replay_detected',
  CHALLENGE_EXPIRED: 'challenge_expired',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Result of a verification step. */
export interface VerifyResult {
  ok: boolean;
  error?: ErrorCodeValue;
  detail?: string;
}

/** Minimal read-only view of a Tachi transaction as returned by the daemon. */
export interface TachiTxRecord {
  hash: string;
  state: string;
  vin: Array<{ owner: string; vtxoId?: string; amount?: string }>;
  vout: Array<{ owner: string; amount: string }>;
  blockhash?: string;
  epoch?: number;
}
