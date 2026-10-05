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
  if (!/^tachi:[0-9a-f]{32}$/.test(accepted.network)) {
    return fail(ErrorCode.NETWORK_MISMATCH, 'network must be tachi:<32 hex genesis prefix>');
  }
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
  const txHash = payload.payload?.settlement?.txHash ?? '';
  const message = buildBoundMessage(accepted, a, resourceUrl, txHash);
  const digest = sha256(new TextEncoder().encode(message));
  const sig = hexToBytes(p.signature);
  const pub = hexToBytes(a.from);
  if (!schnorr.verify(sig, digest, pub)) return fail(ErrorCode.INVALID_SIGNATURE, 'bound-message signature');

  return { ok: true };
}

/** Thrown when a daemon lookup fails transiently; distinct from "not found". */
export class SettlementLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementLookupError';
  }
}

/** Minimal input resolution info. */
interface ResolvedInput {
  owner: string;
  amount?: string;
}

/**
 * Read the daemon for the settlement transaction. Read-only.
 * GET <daemonUrl>/tachi_search?q=<txHash>
 *
 * The daemon returns `{ type: "tx", result: { txHash, state, vin, vout } }`.
 * Input records reference the spent outputs as `txid` + `vout` index and carry
 * no owner field, so this resolves each input's owner and amount from the referenced
 * record (additional read-only GETs). Lookups retry on transient failure and
 * throw {@link SettlementLookupError} rather than silently reporting an empty
 * owner, which would wrongly reject a valid payment.
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
    ((t.vin ?? []) as Array<{ vtxo_id?: string; txid?: string; vout?: number; value_sats?: unknown }>).map(async (v) => {
      const resolved = await resolveInputInfo(base, v.vtxo_id ?? v.txid ?? '', v.vout ?? 0, fetchImpl, v.value_sats);
      return {
        owner: resolved.owner,
        amount: resolved.amount,
        vtxoId: v.vtxo_id,
      };
    })
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
 * Resolve the owner and amount of a spent input. The daemon serves two record shapes from
 * `tachi_search`: `vtxo` records carry `Owner` as base64 of the 32-byte x-only
 * key; `tx` records carry output owners as hex. Both are read-only GETs.
 * Transient failures retry, then throw SettlementLookupError: a lookup failure
 * must never masquerade as "payer does not own inputs".
 */
async function resolveInputInfo(
  base: string,
  ref: string,
  voutIndex: number,
  fetchImpl: typeof fetch,
  valueSatsHint?: unknown,
  attempts = 3
): Promise<ResolvedInput> {
  const hintAmount = valueSatsHint !== undefined && valueSatsHint !== null ? String(valueSatsHint) : undefined;
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(`${base}/tachi_search?q=${ref}`);
      if (!res.ok) {
        lastError = `daemon returned ${res.status}`;
        continue;
      }
      const body = (await res.json()) as {
        type?: string;
        result?: Record<string, unknown> & { Amount?: unknown; vout?: Array<{ owner?: string; amount?: unknown }> };
      };
      const r = body?.result;
      if (!r) return { owner: '', amount: hintAmount };
      if (body.type === 'vtxo') {
        const owner = (r as { Owner?: string }).Owner;
        const ownerHex = owner ? Buffer.from(owner, 'base64').toString('hex').toLowerCase() : '';
        const amount = r.Amount !== undefined && r.Amount !== null ? String(r.Amount) : hintAmount;
        return { owner: ownerHex, amount };
      }
      if (body.type === 'tx') {
        const out = r.vout?.[voutIndex];
        const owner = (out?.owner ?? '').toLowerCase();
        const amount = out?.amount !== undefined && out?.amount !== null ? String(out.amount) : hintAmount;
        return { owner, amount };
      }
      return { owner: '', amount: hintAmount };
    } catch (err) {
      lastError = String(err instanceof Error ? err.message : err);
    }
  }
  throw new SettlementLookupError(
    `daemon lookup failed for input ${ref} after ${attempts} attempts: ${lastError}`
  );
}

/**
 * Verify the settlement against daemon state:
 * the transaction exists, is committed, is the transaction the payload names,
 * its outputs include at least `value` sats owned by the payee, and the payer
 * owns the spent inputs that fund the payment.
 */
export function verifySettlement(payload: PaymentPayload, tx: TachiTxRecord | null): VerifyResult {
  if (!tx) return fail(ErrorCode.SETTLEMENT_NOT_FOUND, 'daemon returned no such transaction');

  const named = payload.payload.settlement.txHash.toLowerCase();
  if (tx.hash.toLowerCase() !== named) {
    return fail(ErrorCode.SETTLEMENT_NOT_FOUND, 'daemon record is for a different transaction');
  }
  if (tx.state !== 'committed') {
    return fail(ErrorCode.SETTLEMENT_NOT_FOUND, `transaction state is ${tx.state}, need committed`);
  }

  const a = payload.payload.authorization;

  const paidToPayee = tx.vout
    .filter((o) => o.owner === a.to)
    .reduce((sum, o) => sum + BigInt(o.amount), 0n);
  if (paidToPayee < BigInt(a.value)) {
    return fail(ErrorCode.SETTLEMENT_INSUFFICIENT, `outputs to payee total ${paidToPayee}, need ${a.value}`);
  }

  const payerInputs = tx.vin.filter((i) => i.owner === a.from);
  if (payerInputs.length === 0) {
    return fail(ErrorCode.INVALID_PAYMENT_PAYLOAD, 'payer does not own spent inputs');
  }

  const hasAmounts = payerInputs.every((i) => i.amount !== undefined && i.amount !== '');
  if (hasAmounts) {
    const payerInputTotal = payerInputs.reduce((sum, i) => sum + BigInt(i.amount!), 0n);
    if (payerInputTotal < BigInt(a.value)) {
      return fail(ErrorCode.INVALID_PAYMENT_PAYLOAD, `payer inputs total ${payerInputTotal}, need ${a.value}`);
    }
  } else {
    const allOwnedByPayer = tx.vin.every((i) => i.owner === a.from);
    if (!allOwnedByPayer) {
      return fail(ErrorCode.INVALID_PAYMENT_PAYLOAD, 'payer does not own all spent inputs');
    }
  }

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
