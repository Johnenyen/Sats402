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
  normalizeResourceUrl,
  tachiNetworkName,
  userAddressForXOnly,
  xOnlyFromAddress,
  type Identity,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
  type SettlementResponse,
} from '@sats402/core';
import { fetchSettlement, verifySettlement } from '@sats402/verify';
import { settleTransfer } from './settle.js';
import type { PayArgs, PayResult } from './pay.js';

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
  /** Sats that have left this agent's control: settled payments plus fees. */
  spentSats = 0n;

  /** Serializes settlements: concurrent calls must not double-spend inputs. */
  private settleQueue: Promise<unknown> = Promise.resolve();

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
    const fee = this.options.feeSats ?? 1n;

    // POLICY FIRST: a refusal here must not create a transaction.
    if (amount > this.options.policy.perCallCapSats) {
      throw new PolicyError(`payment of ${amount} sats exceeds per-call cap`, 'per_call_cap');
    }
    if (this.spentSats + amount + fee > this.options.policy.sessionBudgetSats) {
      throw new PolicyError(`payment of ${amount} sats exceeds session budget`, 'session_budget');
    }
    if (!this.options.policy.payeeAllowlist.includes(accepted.payTo)) {
      throw new PolicyError('payee is not in the allowlist', 'payee_not_allowed');
    }

    // SETTLE: the agent signs and broadcasts its own tachi_tx.
    const networkName = tachiNetworkName(this.options.network);
    const settled = await this.enqueueSettle(() =>
      settleTransfer({
        identity: this.options.identity,
        recipientAddress: userAddressForXOnly(accepted.payTo, networkName),
        amountSats: amount,
        feeSats: fee,
        daemonUrl: this.options.daemonUrl,
        network: networkName,
      })
    );

    // The sats have moved on-chain regardless of what the server answers.
    this.spentSats += amount + fee;

    const resource: ResourceInfo = { url: normalizeResourceUrl(url) };
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
    return fetch(url, { ...init, headers: retryHeaders });
  }

  /**
   * Direct agent-to-agent settlement: one key-holder paying another, verified read-only.
   * Runs the same spend-policy checks as fetch (per-call cap, session budget, payee allowlist),
   * settles native sats on Tachi, and verifies the settlement read-only via @sats402/verify.
   */
  async pay(
    recipientOrArgs:
      | string
      | PayArgs,
    amountSats?: bigint,
    options?: { feeSats?: bigint; memo?: string }
  ): Promise<PayResult> {
    const networkName = tachiNetworkName(this.options.network);
    let payeeXOnly: string;
    let recipientAddress: string;
    let amount: bigint;
    let fee: bigint;
    let memo: string | undefined;

    if (typeof recipientOrArgs === 'string') {
      if (amountSats === undefined) {
        throw new Error('amountSats is required when first argument is recipient address or pubkey');
      }
      amount = amountSats;
      fee = options?.feeSats ?? this.options.feeSats ?? 1n;
      memo = options?.memo;

      if (/^[0-9a-f]{64}$/i.test(recipientOrArgs)) {
        payeeXOnly = recipientOrArgs.toLowerCase();
        recipientAddress = userAddressForXOnly(payeeXOnly, networkName);
      } else {
        recipientAddress = recipientOrArgs;
        payeeXOnly = xOnlyFromAddress(recipientAddress);
      }
    } else {
      amount = recipientOrArgs.amountSats;
      fee = recipientOrArgs.feeSats ?? this.options.feeSats ?? 1n;
      memo = recipientOrArgs.memo;

      if (recipientOrArgs.payeeXOnly) {
        payeeXOnly = recipientOrArgs.payeeXOnly.toLowerCase();
        recipientAddress =
          recipientOrArgs.recipientAddress ?? userAddressForXOnly(payeeXOnly, networkName);
      } else if (recipientOrArgs.recipientAddress) {
        recipientAddress = recipientOrArgs.recipientAddress;
        payeeXOnly = xOnlyFromAddress(recipientAddress);
      } else {
        throw new Error('either payeeXOnly or recipientAddress must be provided');
      }
    }

    // 1. POLICY FIRST: same checks as fetch
    if (amount > this.options.policy.perCallCapSats) {
      throw new PolicyError(`payment of ${amount} sats exceeds per-call cap`, 'per_call_cap');
    }
    if (this.spentSats + amount + fee > this.options.policy.sessionBudgetSats) {
      throw new PolicyError(`payment of ${amount} sats exceeds session budget`, 'session_budget');
    }
    if (!this.options.policy.payeeAllowlist.includes(payeeXOnly)) {
      throw new PolicyError('payee is not in the allowlist', 'payee_not_allowed');
    }

    // 2. SETTLE: the agent signs and broadcasts its own tachi_tx
    const settled = await this.enqueueSettle(() =>
      settleTransfer({
        identity: this.options.identity,
        recipientAddress,
        amountSats: amount,
        feeSats: fee,
        daemonUrl: this.options.daemonUrl,
        network: networkName,
      })
    );

    this.spentSats += amount + fee;

    // 3. READ-ONLY VERIFICATION via @sats402/verify (fetchSettlement + verifySettlement)
    const accepted: PaymentRequirements = {
      scheme: 'exact',
      network: this.options.network,
      amount: String(amount),
      asset: 'BTC',
      payTo: payeeXOnly,
      maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: 'tachi_tx', paymentFlow: 'upfront' },
    };

    const resource: ResourceInfo = {
      url: memo ? `memo:${memo}` : `tachi:${payeeXOnly}`,
    };

    const payload: PaymentPayload = formPayment({
      accepted,
      resource,
      signer: this.options.identity.signer,
      from: this.options.identity.xOnly,
      settlement: { txHash: settled.txHash, state: 'committed' },
    });

    const txRecord = await fetchSettlement(this.options.daemonUrl, settled.txHash);
    const verified = verifySettlement(payload, txRecord);
    if (!verified.ok) {
      throw new Error(`settlement verification failed: ${verified.error} (${verified.detail})`);
    }

    const receipt: SettlementResponse = {
      success: true,
      transaction: settled.txHash,
      network: this.options.network,
      payer: this.options.identity.xOnly,
    };

    return {
      txHash: settled.txHash,
      receipt,
      network: this.options.network,
    };
  }

  private enqueueSettle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.settleQueue.then(fn, fn);
    this.settleQueue = run.catch(() => undefined);
    return run;
  }

  private chooseRequirement(challenge: PaymentRequired): PaymentRequirements {
    const wanted = (challenge.accepts ?? []).find(
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
