/**
 * Read-only verification of an `exact`-on-Tachi payment.
 *
 * This module holds no key and broadcasts nothing. It checks the payload
 * shape and signature, then observes daemon state. That property is by
 * construction: the only network call here is a GET against the daemon.
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { buildBoundMessage } from './binding.js';
import {
  ErrorCode,
  X402_VERSION,
  type PaymentPayload,
  type TachiTxRecord,
  type VerifyResult,
} from './types.js';

const XONLY = /^[0-9a-f]{64}$/;
const SIG128 = /^[0-9a-f]{128}$/;
const DECIMAL = /^[0-9]+$/;

function fail(error: VerifyResult['error'], detail: string): VerifyResult {
  return { ok: false, error, detail };
}

/** Pure shape and binding checks. No network, no daemon. */
export function verifyPayment(payload: PaymentPayload, nowSeconds?: number): VerifyResult {
  const p = payload?.payload;
  const accepted = payload?.accepted;
  if (!p || !accepted) return fail(ErrorCode.INVALID_PAYMENT_PAYLOAD, 'missing payload or accepted');
  if (payload.x402Version !== X402_VERSION) return fail(ErrorCode.INVALID_PAYMENT_PAYLOAD, 'x402Version');
  if (accepted.scheme !== 'exact') return fail(ErrorCode.INVALID_PAYMENT_REQUIREMENTS, 'scheme');
  if (!DECIMAL.test(accepted.amount) || accepted.amount === '0') {
    return fail(ErrorCode.INVALID_PAYMENT_REQUIREMENTS, 'amount must be a positive sat string');
  }
  if (!XONLY.test(accepted.payTo)) return fail(ErrorCode.INVALID_PAYMENT_REQUIREMENTS, 'payTo');

  const a = p.authorization;
  if (!XONLY.test(a?.from ?? '') || !XONLY.test(a?.to ?? '')) {
    return fail(ErrorCode.INVALID_PAYMENT_PAYLOAD, 'from/to must be x-only hex');
  }
  if (!XONLY.test(p.settlement?.txHash ?? '')) {
    return fail(ErrorCode.INVALID_PAYMENT_PAYLOAD, 'txHash must be 64 hex');
  }
  if (!XONLY.test(a.nonce)) return fail(ErrorCode.INVALID_PAYMENT_PAYLOAD, 'nonce must be 64 hex');
  if (!DECIMAL.test(a.validAfter) || !DECIMAL.test(a.validBefore)) {
    return fail(ErrorCode.INVALID_PAYMENT_PAYLOAD, 'validity window must be unix seconds');
  }
  if (!SIG128.test(p.signature)) return fail(ErrorCode.INVALID_PAYMENT_PAYLOAD, 'signature');

  // Cross-field binding: the authorization MUST match the accepted challenge.
  if (a.to !== accepted.payTo) return fail(ErrorCode.PAYEE_MISMATCH, 'to != accepted.payTo');
  if (a.value !== accepted.amount) return fail(ErrorCode.AMOUNT_MISMATCH, 'value != accepted.amount');

  // Validity window.
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const after = Number(a.validAfter);
  const before = Number(a.validBefore);
  if (!(after <= before)) return fail(ErrorCode.INVALID_PAYMENT_PAYLOAD, 'window inverted');
  if (now < after || now > before) return fail(ErrorCode.CHALLENGE_EXPIRED, 'outside validity window');

  // Signature over the full challenge: substitution defense.
  const resourceUrl = payload.resource?.url ?? '';
  const message = buildBoundMessage(accepted, a, resourceUrl);
  const digest = sha256(new TextEncoder().encode(message));
  const sig = hexToBytes(p.signature);
  const pub = hexToBytes(a.from);
  if (!schnorr.verify(sig, digest, pub)) return fail(ErrorCode.INVALID_SIGNATURE, 'bound-message signature');

  return { ok: true };
}

/**
 * Read the daemon for the settlement transaction. Read-only.
 * GET <daemonUrl>/tachi_search?q=<txHash>
 *
 * The daemon returns `{ type: "tx", result: { txHash, state, vin, vout } }`.
 * Input records reference the spent outputs as `txid` + `vout` index and carry
 * no owner field, so this resolves each input's owner from the referenced
 * transaction's outputs (additional read-only GETs).
 */
export async function fetchSettlement(
  daemonUrl: string,
  txHash: string,
  fetchImpl: typeof fetch = fetch
): Promise<TachiTxRecord | null> {
  const base = daemonUrl.replace(/\/$/, '');
  const t = await fetchTx(base, txHash, fetchImpl);
  if (!t) return null;

  const vin: TachiTxRecord['vin'] = await Promise.all(
    ((t.vin ?? []) as Array<{ vtxo_id?: string; txid?: string; vout?: number }>).map(async (v) => ({
      owner: await resolveInputOwner(base, v.vtxo_id ?? v.txid ?? '', v.vout ?? 0, fetchImpl),
      vtxoId: v.vtxo_id,
    }))
  );

  return {
    hash: String(t.txHash ?? ''),
    state: String(t.state ?? ''),
    vin,
    vout: ((t.vout ?? []) as Array<{ owner: string; amount: unknown }>).map((o) => ({
      owner: o.owner,
      amount: String(o.amount),
    })),
    blockhash: t.blockhash as string | undefined,
    epoch: t.epoch as number | undefined,
  };
}

async function fetchTx(
  base: string,
  txHash: string,
  fetchImpl: typeof fetch
): Promise<(Record<string, unknown> & { vout?: unknown[] }) | null> {
  const res = await fetchImpl(`${base}/tachi_search?q=${txHash}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { type?: string; result?: Record<string, unknown> };
  const t = body?.type === 'tx' ? body.result : null;
  if (!t) return null;
  const hash = String((t as { txHash?: string }).txHash ?? '').toLowerCase();
  return hash === txHash.toLowerCase() ? t : null;
}

/**
 * Resolve the owner of a spent input. The daemon serves two record shapes from
 * `tachi_search`: `vtxo` records carry `Owner` as base64 of the 32-byte x-only
 * key; `tx` records carry output owners as hex. Both are read-only GETs.
 */
async function resolveInputOwner(
  base: string,
  ref: string,
  voutIndex: number,
  fetchImpl: typeof fetch
): Promise<string> {
  try {
    const res = await fetchImpl(`${base}/tachi_search?q=${ref}`);
    if (!res.ok) return '';
    const body = (await res.json()) as {
      type?: string;
      result?: Record<string, unknown> & { vout?: Array<{ owner?: string }> };
    };
    const r = body?.result;
    if (!r) return '';
    if (body.type === 'vtxo') {
      const owner = (r as { Owner?: string }).Owner;
      return owner ? Buffer.from(owner, 'base64').toString('hex') : '';
    }
    if (body.type === 'tx') {
      return r.vout?.[voutIndex]?.owner ?? '';
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Verify the settlement against daemon state:
 * the transaction exists, its outputs include at least `value` sats owned by
 * the payee, and the payer owns the spent inputs.
 */
export function verifySettlement(payload: PaymentPayload, tx: TachiTxRecord | null): VerifyResult {
  if (!tx) return fail(ErrorCode.SETTLEMENT_NOT_FOUND, 'daemon returned no such transaction');
  const a = payload.payload.authorization;

  const paidToPayee = tx.vout
    .filter((o) => o.owner === a.to)
    .reduce((sum, o) => sum + BigInt(o.amount), 0n);
  if (paidToPayee < BigInt(a.value)) {
    return fail(ErrorCode.SETTLEMENT_INSUFFICIENT, `outputs to payee total ${paidToPayee}, need ${a.value}`);
  }

  const payerOwnsInputs = tx.vin.some((i) => i.owner === a.from);
  if (!payerOwnsInputs) return fail(ErrorCode.INVALID_PAYMENT_PAYLOAD, 'payer does not own spent inputs');

  return { ok: true };
}

/** Replay consumption key: `network + ":" + tx_hash` (scheme_exact_tachi.md). */
export function replayKey(network: string, txHash: string): string {
  return `${network}:${txHash.toLowerCase()}`;
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
