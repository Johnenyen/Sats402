/**
 * Read-only verification of a Sats402 settlement.
 *
 * This package holds no key and broadcasts nothing. Its only network call is a
 * GET against the Tachi daemon. It reports what the daemon returns, nothing
 * more: the record is daemon-returned and re-fetchable.
 */
import { fetchSettlement, verifySettlement, type TachiTxRecord } from '@sats402/core/verify';

export { fetchSettlement, verifySettlement };

export interface ReceiptCheck {
  /** The transaction hash as queried. */
  txHash: string;
  /** Whether the daemon returned the transaction. */
  found: boolean;
  /** Daemon-returned state, e.g. `committed`. */
  state?: string;
  /** Epoch the transaction was applied in, when the daemon reports one. */
  epoch?: number;
  /** Outputs as the daemon records them: owner key and sats. */
  outputs: Array<{ owner: string; amountSats: string }>;
  /** Owner keys of the spent inputs, resolved from daemon records. */
  inputOwners: string[];
  /** Human-readable notes for display. */
  notes: string[];
}

/**
 * Check a settlement by reading the daemon. Optionally assert the expected
 * payee and amount.
 */
export async function verifyReceipt(
  daemonUrl: string,
  txHash: string,
  expect?: { payee?: string; amountSats?: bigint }
): Promise<ReceiptCheck> {
  const tx: TachiTxRecord | null = await fetchSettlement(daemonUrl, txHash);
  const notes: string[] = [
    'Record is daemon-returned and re-fetchable: anyone can repeat this lookup.',
  ];

  if (!tx) {
    return { txHash, found: false, outputs: [], inputOwners: [], notes };
  }

  if (expect?.payee) {
    const paid = tx.vout
      .filter((o) => o.owner === expect.payee)
      .reduce((s, o) => s + BigInt(o.amount), 0n);
    notes.push(
      expect.amountSats !== undefined
        ? paid >= expect.amountSats
          ? `Payee received ${paid} sats, expected at least ${expect.amountSats}: OK`
          : `Payee received ${paid} sats, expected at least ${expect.amountSats}: NOT MET`
        : `Payee received ${paid} sats`
    );
  }

  return {
    txHash,
    found: true,
    state: tx.state,
    epoch: tx.epoch,
    outputs: tx.vout.map((o) => ({ owner: o.owner, amountSats: String(o.amount) })),
    inputOwners: tx.vin.map((v) => v.owner).filter(Boolean),
    notes,
  };
}
