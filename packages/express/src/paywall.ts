/**
 * The paywall: x402 challenge and verification for a paid service.
 *
 * Holds no key and moves no funds. A payment is verified by reading Tachi
 * daemon state. Everything here is read-only: the only network call is a GET
 * against the daemon.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  fetchSettlement,
  replayKey,
  verifyPayment,
  verifySettlement,
  type ErrorCodeValue,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
  type SettlementResponse,
} from '@sats402/core/verify';

/** Single-use settlement tracking. */
export interface ReplayStore {
  /** True if the key is fresh and now consumed; false if already used. */
  consume(key: string): boolean;
}

/** In-memory replay store. Sufficient for a single-process service. */
export class MemoryReplayStore implements ReplayStore {
  private seen = new Set<string>();
  consume(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

export interface PaywallOptions {
  /** Price per request in sats. */
  priceSats: bigint;
  /** Payee owner key (x-only hex) that must receive the payment. */
  payeeXOnly: string;
  /** Network id, e.g. `tachi:0f9188f13cb7b2c71f2a335e3a4fc328`. */
  network: string;
  /** Tachid base URL for read-only verification. */
  daemonUrl: string;
  /** Description of the protected resource. */
  resource: ResourceInfo;
  maxTimeoutSeconds?: number;
  replay?: ReplayStore;
  /** The protected handler, called only after a verified payment. */
  serve: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function decodeHeader<T>(req: IncomingMessage, name: string): T | null {
  const raw = req.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function requirement(opts: PaywallOptions): PaymentRequirements {
  return {
    scheme: 'exact',
    network: opts.network,
    amount: String(opts.priceSats),
    asset: 'BTC',
    payTo: opts.payeeXOnly,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 600,
    extra: { assetTransferMethod: 'tachi_tx', paymentFlow: 'upfront' },
  };
}

/** The accepted requirement must match the issued one exactly. */
function sameRequirement(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.amount === b.amount &&
    a.asset === b.asset &&
    a.payTo === b.payTo &&
    a.maxTimeoutSeconds === b.maxTimeoutSeconds &&
    JSON.stringify(a.extra ?? {}) === JSON.stringify(b.extra ?? {})
  );
}

function requestUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}${req.url ?? '/'}`;
}

function sendChallenge(res: ServerResponse, opts: PaywallOptions, error?: string): void {
  const required: PaymentRequired = {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: opts.resource,
    accepts: [requirement(opts)],
    extensions: {},
  };
  res.statusCode = 402;
  res.setHeader(HEADER_PAYMENT_REQUIRED, b64(required));
  res.end('{}');
}

function sendRejected(
  res: ServerResponse,
  opts: PaywallOptions,
  reason: ErrorCodeValue | string,
  payer: string
): void {
  const response: SettlementResponse = {
    success: false,
    errorReason: String(reason),
    transaction: '',
    network: opts.network,
    payer,
  };
  res.statusCode = 402;
  res.setHeader(HEADER_PAYMENT_RESPONSE, b64(response));
  res.end('{}');
}

/**
 * Build a node:http request handler enforcing payment before `serve`.
 */
export function paywall(opts: PaywallOptions) {
  const replay = opts.replay ?? new MemoryReplayStore();

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = decodeHeader<PaymentPayload>(req, HEADER_PAYMENT_SIGNATURE);
    if (!payload) {
      sendChallenge(res, opts, 'PAYMENT-SIGNATURE header is required');
      return;
    }

    const payer = payload?.payload?.authorization?.from ?? '';

    // 1. The payment must be for the requirement this server issued. Network
    // is called out first so a cross-network payment reports the right error.
    if (payload.accepted && payload.accepted.network !== opts.network) {
      sendRejected(res, opts, 'network_mismatch', payer);
      return;
    }
    if (!payload.accepted || !sameRequirement(payload.accepted, requirement(opts))) {
      sendRejected(res, opts, 'invalid_payment_requirements', payer);
      return;
    }

    // 2. The payment must be bound to this exact request URL.
    if ((payload.resource?.url ?? '') !== requestUrl(req)) {
      sendRejected(res, opts, 'invalid_payment_payload', payer);
      return;
    }

    // 3. Local verification: shape, binding, signature, validity window.
    const local = verifyPayment(payload);
    if (!local.ok) {
      sendRejected(res, opts, local.error ?? 'invalid_payment_payload', payer);
      return;
    }

    // 4. Read-only settlement verification against the Tachi daemon.
    const tx = await fetchSettlement(opts.daemonUrl, payload.payload.settlement.txHash);
    const settled = verifySettlement(payload, tx);
    if (!settled.ok) {
      sendRejected(res, opts, settled.error ?? 'settlement_not_found', payer);
      return;
    }

    // 5. Single use.
    const key = replayKey(payload.accepted.network, payload.payload.settlement.txHash);
    if (!replay.consume(key)) {
      sendRejected(res, opts, 'replay_detected', payer);
      return;
    }

    // PAID: report the settlement, then serve the resource.
    const response: SettlementResponse = {
      success: true,
      transaction: payload.payload.settlement.txHash,
      network: payload.accepted.network,
      payer,
    };
    res.setHeader(HEADER_PAYMENT_RESPONSE, b64(response));
    await opts.serve(req, res);
  };
}
