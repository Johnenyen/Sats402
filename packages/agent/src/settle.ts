/**
 * Native sats settlement on Tachi: the agent signs and broadcasts its own
 * `tachi_tx`. This module never touches custody: it spends the caller's own
 * VTXOs with the caller's own key, through Tachi's official TAURUS SDK.
 */
import {
  buildTachiTxTransfer,
  buildVtxoPsbt,
  signVtxoPsbtAsUser,
  signTachiTx,
  broadcastTachiTx,
  waitForTachiTxCommit,
  getAddressVtxos,
  getAccountNonce,
  fetchConsensusQuorum,
  createVault,
  type VtxoInput,
  type VtxoOutput,
  type TaprootSigner,
} from '@tachibtc/taurus-vault-core';
import type { Identity } from '@sats402/core';

export interface SettleArgs {
  /** The paying agent's identity: owns the sats and signs the tx. */
  identity: Identity;
  /** Recipient's user P2TR address (bech32m). */
  recipientAddress: string;
  amountSats: bigint;
  /** Ledger fee in sats (default 1). */
  feeSats?: bigint;
  /** Tachid base URL, e.g. https://rpc-regtest.tachibtc.com */
  daemonUrl: string;
  /**
   * Tachi network the vault is reconstructed for (default `regtest`).
   * Regtest is the build target; signet is the same code with a different
   * daemon URL and this name.
   */
  network?: string;
}

export interface SettlementResult {
  /** Hash of the settled tachi_tx: re-fetchable from the daemon. */
  txHash: string;
  epoch: number;
  code: number;
  /** VTXO ids consumed as inputs. */
  inputs: string[];
}

/**
 * Sats currently spendable by an identity (sum of unspent, unlocked VTXOs).
 * Read-only. Useful for spend policies and demo setup.
 */
export async function getSpendableSats(identity: Identity, daemonUrl: string): Promise<bigint> {
  const base = daemonUrl.replace(/\/$/, '');
  const u = new URL(base);
  const allowInsecureHttp =
    u.protocol === 'http:' &&
    (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1');
  const res = await getAddressVtxos(identity.xOnly, {
    baseUrl: base,
    allowInsecureHttp,
    fetchImpl: fetch,
  });
  return (res.vtxos ?? [])
    .filter((v) => !v.spent && !v.locked)
    .reduce((sum, v) => sum + v.amountSats, 0n);
}

export interface FaucetResult {
  ok: boolean;
  txid?: string;
  error?: string;
}

/** Top up an address from the live Tachi faucet (up to 0.5 BTC per 24h). */
export async function topUpFromFaucet(
  address: string,
  amountBtc = 0.001,
  faucetUrl = 'https://faucet.tachibtc.com'
): Promise<FaucetResult> {
  try {
    const res = await fetch(`${faucetUrl.replace(/\/$/, '')}/api/faucet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: address.trim(),
        amountBtc,
        proof: null,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `faucet HTTP ${res.status}: ${text}` };
    }
    const body = (await res.json()) as { txid?: string; error?: string };
    if (body.txid) return { ok: true, txid: body.txid };
    return { ok: false, error: body.error ?? 'no txid returned' };
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
}

/**
 * Pre-flight funding step: check wallet balance and top up from the live Tachi faucet
 * when balance is below threshold. Prints a clear balance warning before the run and
 * never fails silently on insufficient funds.
 */
export async function ensureFunded(
  identity: Identity,
  daemonUrl: string,
  thresholdSats = 1000n,
  minRequiredSats = 180n
): Promise<bigint> {
  let balance = await getSpendableSats(identity, daemonUrl);
  if (balance < thresholdSats) {
    console.warn(
      `[wallet warning] Demo wallet balance (${balance} sats) is below threshold (${thresholdSats} sats). Topping up from live Tachi faucet...`
    );
    const topUp = await topUpFromFaucet(identity.userAddress);
    if (topUp.ok) {
      console.log(`[wallet] Faucet top-up broadcast: ${topUp.txid}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      balance = await getSpendableSats(identity, daemonUrl);
    } else {
      console.warn(`[wallet] Faucet top-up failed: ${topUp.error}`);
    }
  }

  if (balance < minRequiredSats) {
    throw new Error(
      `Insufficient funds: demo wallet has ${balance} sats, need at least ${minRequiredSats} sats. Top up ${identity.userAddress} at https://faucet.tachibtc.com.`
    );
  }
  return balance;
}

/**
 * Vault CSV delay used when reconstructing a vault. A construction constant:
 * it must match the value the vault was created with or the reconstructed
 * vault address changes. Not deployment configuration.
 */
const VAULT_CSV_BLOCKS = 2;

// Must exceed waitForTachiTxCommit overallTimeoutMs (120_000ms)
const IN_FLIGHT_TTL_MS = 180_000; // Must exceed waitForTachiTxCommit overallTimeoutMs (120s)
const inFlightVtxoIds = new Map<string, number>();

function cleanInFlight(): void {
  const now = Date.now();
  for (const [id, expiresAt] of inFlightVtxoIds.entries()) {
    if (expiresAt <= now) {
      inFlightVtxoIds.delete(id);
    }
  }
}

export function markVtxoInFlight(id: string, ttlMs = IN_FLIGHT_TTL_MS): void {
  inFlightVtxoIds.set(id, Date.now() + ttlMs);
}

export function releaseVtxo(id: string): void {
  inFlightVtxoIds.delete(id);
}

export function getInFlightVtxoIds(): Set<string> {
  cleanInFlight();
  return new Set(inFlightVtxoIds.keys());
}

export function clearInFlightVtxos(): void {
  inFlightVtxoIds.clear();
}

export interface VtxoCandidate {
  id: string;
  amountSats: bigint;
  spent?: boolean;
  locked?: boolean;
  script?: string;
}

export interface SelectionResult<T extends VtxoCandidate> {
  picked: T[];
  total: bigint;
}

/**
 * Deterministic smallest-sufficient VTXO selection.
 * Excludes spent, locked, and in-flight VTXOs.
 * Prefers smallest-sufficient VTXO (sort ascending, take first covering needSats).
 * Falls back to accumulation (sort descending to minimize inputs) if none suffices.
 */
export function selectVtxos<T extends VtxoCandidate>(
  vtxos: readonly T[],
  needSats: bigint,
  inFlightIds: Set<string> = getInFlightVtxoIds()
): SelectionResult<T> {
  const available = vtxos.filter((v) => !v.spent && !v.locked && !inFlightIds.has(v.id));

  // Sort ascending by amountSats for smallest-sufficient selection; tie-break deterministically by id
  const sortedAsc = [...available].sort((a, b) => {
    if (a.amountSats !== b.amountSats) {
      return a.amountSats < b.amountSats ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });

  // Prefer smallest-sufficient: first single VTXO that covers needSats
  const singleSufficient = sortedAsc.find((v) => v.amountSats >= needSats);
  if (singleSufficient) {
    return {
      picked: [singleSufficient],
      total: singleSufficient.amountSats,
    };
  }

  // Fall back to accumulation: sort descending to minimize number of inputs
  const sortedDesc = [...available].sort((a, b) => {
    if (a.amountSats !== b.amountSats) {
      return a.amountSats < b.amountSats ? 1 : -1;
    }
    return a.id.localeCompare(b.id);
  });

  const picked: T[] = [];
  let total = 0n;
  for (const v of sortedDesc) {
    picked.push(v);
    total += v.amountSats;
    if (total >= needSats) break;
  }

  if (total < needSats) {
    throw new Error(`insufficient funds: have ${total} sats, need ${needSats}`);
  }

  return { picked, total };
}

export async function settleTransfer(args: SettleArgs): Promise<SettlementResult> {
  const feeSats = args.feeSats ?? 1n;
  const base = args.daemonUrl.replace(/\/$/, '');
  const u = new URL(base);
  const allowInsecureHttp =
    u.protocol === 'http:' &&
    (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1');
  const opts = { baseUrl: base, allowInsecureHttp, fetchImpl: fetch };

  // Vault reconstruction is deterministic from the consensus quorum and the
  // user key descriptor; no registration or state is required to spend.
  const quorum = await fetchConsensusQuorum(opts);
  const vault = await createVault({
    network: (args.network ?? 'regtest') as 'regtest',
    nodePubkeys: quorum.nodePubkeys,
    csvBlocks: VAULT_CSV_BLOCKS,
    userKeyDescriptor: args.identity.userKeyDescriptor as never,
  });

  // Coin selection: unspent VTXOs, smallest-sufficient first, excluding in-flight VTXOs
  const res = await getAddressVtxos(args.identity.xOnly, opts);
  const need = args.amountSats + feeSats;
  const inFlight = getInFlightVtxoIds();
  const { picked, total } = selectVtxos(res.vtxos ?? [], need, inFlight);

  // Mark picked inputs in-flight immediately to prevent concurrent settlements from selecting them
  for (const v of picked) {
    markVtxoInFlight(v.id);
  }

  const inputs: VtxoInput[] = picked.map((v) => ({
    txid: v.id,
    vout: 0,
    valueSats: v.amountSats,
    scriptPubKey: v.script || Buffer.from(vault.p2tr.output).toString('hex'),
    vtxoId: Buffer.from(v.id, 'hex'),
  }));

  const outputs: VtxoOutput[] = [
    { address: args.recipientAddress, valueSats: args.amountSats },
  ];
  const changeSats = total - need;
  if (changeSats > 0n) {
    outputs.push({ address: args.identity.userAddress, valueSats: changeSats });
  }

  let broadcast;
  try {
    const signer = args.identity.signer as unknown as TaprootSigner;
    const built = buildVtxoPsbt({ vault, inputs, outputs, feeSats });
    await signVtxoPsbtAsUser(built.psbt, signer, vault, { maxFeeSats: feeSats });

    const nonce = await getAccountNonce(Buffer.from(args.identity.xOnly, 'hex'), opts);
    const tachiTx = buildTachiTxTransfer({ vault, inputs, outputs, feeSats, nonce, psbt: built.psbt });
    const signedTx = await signTachiTx(tachiTx, signer);

    broadcast = await broadcastTachiTx(signedTx, {
      url: `${base}/tachi_txBroadcastSync`,
      allowInsecureHttp,
      fetchImpl: fetch,
    });
    if (!broadcast?.tendermintTxHash) {
      throw new Error(`broadcast rejected: ${broadcast?.log || 'no transaction hash returned'}`);
    }
  } catch (err) {
    for (const v of picked) {
      releaseVtxo(v.id);
    }
    throw err;
  }

  // A code-0 broadcast means the mempool admitted the tx. Wait for the ledger
  // to actually apply it before reporting success.
  try {
    const status = await waitForTachiTxCommit(broadcast.tendermintTxHash, {
      baseUrl: base,
      allowInsecureHttp,
      fetchImpl: fetch,
      overallTimeoutMs: 120_000,
    });

    // Delay release by a 5-second grace window: the daemon indexer may lag a few
    // ms before getAddressVtxos reflects spent:true, so keep in-flight to prevent re-selection.
    for (const v of picked) {
      const timer = setTimeout(() => {
        releaseVtxo(v.id);
      }, 5_000);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    }

    return {
      // The daemon's status hash comes back uppercase; the Sats402 binding
      // specifies tx hashes as 64 lowercase hex, so normalize at the source.
      txHash: status.hash.toLowerCase(),
      epoch: status.epoch,
      code: status.code,
      inputs: picked.map((v) => v.id),
    };
  } catch (err) {
    // Commit failed or timed out; leave in flight until TTL to avoid mempool collision
    throw err;
  }
}
