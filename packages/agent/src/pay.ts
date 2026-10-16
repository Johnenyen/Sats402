/**
 * Direct agent-to-agent settlement.
 * One key-holder paying another in native sats, verified read-only.
 */
import type { SettlementResponse } from '@sats402/core';
import type { Sats402Agent } from './fetch.js';

export interface PayArgs {
  /** Payee's 64-character lowercase hex x-only public key. */
  payeeXOnly?: string;
  /** Payee's bech32m P2TR user address. */
  recipientAddress?: string;
  /** Amount to transfer in atomic sat units. */
  amountSats: bigint;
  /** Ledger fee in sats (default 1). */
  feeSats?: bigint;
  /** Optional memo bound into the payment challenge. */
  memo?: string;
}

export interface PayResult {
  txHash: string;
  receipt: SettlementResponse;
  network: string;
}

/**
 * Direct agent-to-agent payment helper.
 * Calls agent.pay internally with the same spend-policy enforcement,
 * native sats settlement, and read-only verification.
 */
export async function pay(agent: Sats402Agent, args: PayArgs): Promise<PayResult> {
  return agent.pay(args);
}
