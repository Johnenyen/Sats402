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
    csvBlocks: 2,
    userKeyDescriptor: args.identity.userKeyDescriptor as never,
  });

  // Coin selection: unspent VTXOs, largest first, until amount + fee is covered.
  const res = await getAddressVtxos(args.identity.xOnly, opts);
  const need = args.amountSats + feeSats;
  const sorted = [...(res.vtxos ?? [])]
    .filter((v) => !v.spent && !v.locked)
    .sort((a, b) => (b.amountSats > a.amountSats ? 1 : -1));
  const picked: typeof sorted = [];
  let total = 0n;
  for (const v of sorted) {
    if (total >= need) break;
    picked.push(v);
    total += v.amountSats;
  }
  if (total < need) throw new Error(`insufficient funds: have ${total} sats, need ${need}`);

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

  const signer = args.identity.signer as unknown as TaprootSigner;
  const built = buildVtxoPsbt({ vault, inputs, outputs, feeSats });
  await signVtxoPsbtAsUser(built.psbt, signer, vault, { maxFeeSats: feeSats });

  const nonce = await getAccountNonce(Buffer.from(args.identity.xOnly, 'hex'), opts);
  const tachiTx = buildTachiTxTransfer({ vault, inputs, outputs, feeSats, nonce, psbt: built.psbt });
  const signedTx = await signTachiTx(tachiTx, signer);

  const broadcast = await broadcastTachiTx(signedTx, {
    url: `${base}/tachi_txBroadcastSync`,
    allowInsecureHttp,
    fetchImpl: fetch,
  });

  // A code-0 broadcast means the mempool admitted the tx. Wait for the ledger
  // to actually apply it before reporting success.
  const status = await waitForTachiTxCommit(broadcast.tendermintTxHash, {
    baseUrl: base,
    allowInsecureHttp,
    fetchImpl: fetch,
    overallTimeoutMs: 120_000,
  });

  return {
    // The daemon's status hash comes back uppercase; the Sats402 binding
    // specifies tx hashes as 64 lowercase hex, so normalize at the source.
    txHash: status.hash.toLowerCase(),
    epoch: status.epoch,
    code: status.code,
    inputs: picked.map((v) => v.id),
  };
}
