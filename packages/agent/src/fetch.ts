/**
 * Payment-enabled fetch for autonomous agents.
 *
 * Flow: request -> 402 challenge -> local spending policy -> settle (the agent
 * signs and broadcasts its own tachi_tx) -> retry with PAYMENT-SIGNATURE.
 * Policy refusals happen before any transaction exists.
 */
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_SIGNATURE,
  formPayment,
  userAddressForXOnly,
  type Identity,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
} from '@sats402/core';
import { settleTransfer } from './settle.js';

/** Local spending policy. Enforced before any settlement is made. */
export interface SpendPolicy {
  /** Maximum sats for a single payment. */
  perCallCapSats: bigint;
  /** Maximum sats this agent may spend per session. */
  sessionBudgetSats: bigint;
  /** Allowed payee owner keys (x-only hex). Anything else is refused. */
  payeeAllowlist: readonly string[];
}

export interface AgentOptions {
  identity: Identity;
  daemonUrl: string;
  /** Network the agent accepts payments on (must match the challenge exactly). */
  network: string;
  policy: SpendPolicy;
  /** Ledger fee per settlement (default 1 sat). */
  feeSats?: bigint;
}

/** Thrown when the agent's own policy refuses a payment. No tx is made. */
export class PolicyError extends Error {
  readonly code = 'policy_refused';
  constructor(
    message: string,
    readonly reason: 'per_call_cap' | 'session_budget' | 'payee_not_allowed' | 'wrong_network'
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

function decodeHeader<T>(res: Response, name: string): T | null {
  const raw = res.headers.get(name);
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export class Sats402Agent {
  /** Sats spent so far in this session (settled payments only). */
  spentSats = 0n;

  constructor(readonly options: AgentOptions) {}

  /**
   * fetch with automatic x402 payment. Non-402 responses pass through. On a
   * 402, the agent checks policy, settles in native sats on Tachi, and retries
   * with the payment proof.
   */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, init);
    if (res.status !== 402) return res;

    const challenge = decodeHeader<PaymentRequired>(res, HEADER_PAYMENT_REQUIRED);
    if (!challenge) return res; // 402 without an x402 challenge: not ours

    const accepted = this.chooseRequirement(challenge);
    const amount = BigInt(accepted.amount);

    // POLICY FIRST: a refusal here must not create a transaction.
    if (amount > this.options.policy.perCallCapSats) {
      throw new PolicyError(`payment of ${amount} sats exceeds per-call cap`, 'per_call_cap');
    }
    if (this.spentSats + amount > this.options.policy.sessionBudgetSats) {
      throw new PolicyError(`payment of ${amount} sats exceeds session budget`, 'session_budget');
    }
    if (!this.options.policy.payeeAllowlist.includes(accepted.payTo)) {
      throw new PolicyError('payee is not in the allowlist', 'payee_not_allowed');
    }

    // SETTLE: the agent signs and broadcasts its own tachi_tx.
    const settled = await settleTransfer({
      identity: this.options.identity,
      recipientAddress: userAddressForXOnly(accepted.payTo),
      amountSats: amount,
      feeSats: this.options.feeSats ?? 1n,
      daemonUrl: this.options.daemonUrl,
    });

    const resource: ResourceInfo = { url };
    const payload: PaymentPayload = formPayment({
      accepted,
      resource,
      signer: this.options.identity.signer,
      from: this.options.identity.xOnly,
      settlement: { txHash: settled.txHash, state: 'committed' },
    });

    // RETRY with the payment proof.
    const retryHeaders = new Headers(init.headers ?? {});
    retryHeaders.set(
      HEADER_PAYMENT_SIGNATURE,
      Buffer.from(JSON.stringify(payload)).toString('base64')
    );
    const retry = await fetch(url, { ...init, headers: retryHeaders });
    if (retry.ok) this.spentSats += amount;
    return retry;
  }

  private chooseRequirement(challenge: PaymentRequired): PaymentRequirements {
    const wanted = challenge.accepts.find(
      (a) => a.scheme === 'exact' && a.network === this.options.network
    );
    if (!wanted) {
      throw new PolicyError(
        `challenge offers no exact payment on ${this.options.network}`,
        'wrong_network'
      );
    }
    return wanted;
  }
}
