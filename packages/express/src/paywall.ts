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
  SettlementLookupError,
  fetchSettlement,
  normalizeResourceUrl,
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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Single-use settlement tracking. */
/** Single-use settlement tracking. */
export interface ReplayStore {
  /** True if the key is fresh and now consumed; false if already used. */
  consume(key: string): boolean | Promise<boolean>;
  /** Whether the key has already been consumed. */
  has(key: string): boolean | Promise<boolean>;
}

/** In-memory replay store. Suitable for tests and single-run processes only. */
export class MemoryReplayStore implements ReplayStore {
  private seen = new Set<string>();
  consume(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
  has(key: string): boolean {
    return this.seen.has(key);
  }
}

/**
 * File-backed replay store: consumed keys are appended to a file and the
 * file is loaded at construction. Durability boundary: replay protection is
 * restart-durable only when backed by a persistent external store; in
 * ephemeral or serverless environments (such as /tmp), durability is bounded
 * by instance lifetime.
 */
export class FileReplayStore implements ReplayStore {
  private seen = new Set<string>();
  constructor(readonly filePath: string) {
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, 'utf8').split('\n')) {
        const key = line.trim();
        if (key) this.seen.add(key);
      }
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
    }
  }
  consume(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    appendFileSync(this.filePath, `${key}\n`, 'utf8');
    return true;
  }
  has(key: string): boolean {
    return this.seen.has(key);
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
  /** Description of the protected resource (its url is set per request). */
  resource: ResourceInfo;
  maxTimeoutSeconds?: number;
  replay?: ReplayStore;
  /**
   * Public origin of this service (e.g. https://api.example.com or a function
   * deriving from req). When set it is the trusted base for the bound request URL.
   * When omitted, the base is derived from forwarded headers or the socket.
   */
  publicBaseUrl?: string | ((req: IncomingMessage) => string);
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

/**
 * The request URL that payment signatures are bound to. With `publicBaseUrl`
 * configured this is exact. Without it, the scheme comes from the proxy's
 * `x-forwarded-proto` (or the socket) and the host from the request, which is
 * fine for development but is host-header dependent.
 *
 * Normalization matters: an agent and a service behind a proxy must agree on
 * the same string even when the host differs in case, default ports, or a
 * trailing slash. Both sides normalize via core's normalizeResourceUrl.
 */
function requestUrl(req: IncomingMessage, opts: PaywallOptions): string {
  const path = (req as any).originalUrl ?? req.url ?? '/';
  const base = typeof opts.publicBaseUrl === 'function' ? opts.publicBaseUrl(req) : opts.publicBaseUrl;
  if (base) return normalizeResourceUrl(`${base.replace(/\/$/, '')}${path}`);
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto =
    (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]?.trim() ||
    ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const forwardedHost = req.headers['x-forwarded-host'];
  const host =
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(',')[0]?.trim() ||
    req.headers.host ||
    'localhost';
  return normalizeResourceUrl(`${proto}://${host}${path}`);
}

function sendChallenge(
  res: ServerResponse,
  opts: PaywallOptions,
  req: IncomingMessage,
  error?: string
): void {
  const required: PaymentRequired = {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: { ...opts.resource, url: requestUrl(req, opts) },
    accepts: [requirement(opts)],
    extensions: {},
  };
  res.statusCode = 402;
  res.setHeader('content-type', 'application/json');
  res.setHeader(HEADER_PAYMENT_REQUIRED, b64(required));
  res.end('{}');
}

function sendRejected(
  res: ServerResponse,
  opts: PaywallOptions,
  reason: ErrorCodeValue | string,
  payer: string,
  req: IncomingMessage,
  txHash?: string
): void {
  const required: PaymentRequired = {
    x402Version: 2,
    error: String(reason),
    resource: { ...opts.resource, url: requestUrl(req, opts) },
    accepts: [requirement(opts)],
    extensions: {},
  };
  const response: SettlementResponse = {
    success: false,
    errorReason: String(reason),
    transaction: txHash ?? '',
    network: opts.network,
    payer,
  };
  res.statusCode = 402;
  res.setHeader('content-type', 'application/json');
  res.setHeader(HEADER_PAYMENT_REQUIRED, b64(required));
  res.setHeader(HEADER_PAYMENT_RESPONSE, b64(response));
  res.end('{}');
}

interface CapturedResponse {
  status: number;
  headers: Record<string, unknown>;
  body: string;
}

/** Record what serve() writes so a replay can return the same response. */
function recording(res: ServerResponse): { res: ServerResponse; capture: () => CapturedResponse } {
  const chunks: Buffer[] = [];
  // Pragmatic interception of the response stream; types are intentionally
  // loose here because we are wrapping Node's overloaded write/end methods.
  const originalWrite = res.write.bind(res) as (...a: unknown[]) => unknown;
  const originalEnd = res.end.bind(res) as (...a: unknown[]) => unknown;
  const collect = (chunk: unknown) => {
    if (chunk && typeof chunk !== 'function') {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
  };
  (res as unknown as { write: (...a: unknown[]) => unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
    collect(chunk);
    return originalWrite(chunk, ...rest);
  };
  (res as unknown as { end: (...a: unknown[]) => unknown }).end = (chunk: unknown, ...rest: unknown[]) => {
    collect(chunk);
    return originalEnd(chunk, ...rest);
  };
  return {
    res,
    capture: () => ({
      status: res.statusCode,
      headers: { ...res.getHeaders() },
      body: Buffer.concat(chunks).toString('utf8'),
    }),
  };
}

/**
 * Build a node:http request handler enforcing payment before `serve`.
 * (Also usable as Express middleware: pass it directly as a route handler.)
 */
function responseCacheKey(
  network: string,
  nonce: string,
  resourceUrl: string,
  payer: string,
  txHash: string
): string {
  return `${network}:${nonce}:${resourceUrl}:${payer.toLowerCase()}:${txHash.toLowerCase()}`;
}

export function paywall(opts: PaywallOptions) {
  const replay = opts.replay ?? new MemoryReplayStore();
  const inFlight = new Set<string>();
  // Bounded response cache for the paid-but-expired policy: max entries and a
  // TTL so a long-running process cannot leak memory.
  const RESPONSE_CACHE_MAX = 200;
  const RESPONSE_TTL_MS = 10 * 60 * 1000;
  const responses = new Map<string, { at: number; res: CapturedResponse }>();
  const remember = (key: string, res: CapturedResponse) => {
    const now = Date.now();
    for (const [k, v] of responses) {
      if (now - v.at > RESPONSE_TTL_MS) responses.delete(k);
    }
    while (responses.size >= RESPONSE_CACHE_MAX) {
      const oldest = responses.keys().next().value;
      if (oldest === undefined) break;
      responses.delete(oldest);
    }
    responses.set(key, { at: now, res });
  };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = decodeHeader<PaymentPayload>(req, HEADER_PAYMENT_SIGNATURE);
    if (!payload) {
      sendChallenge(res, opts, req, 'PAYMENT-SIGNATURE header is required');
      return;
    }

    const payer = payload?.payload?.authorization?.from ?? '';
    const txHash = payload?.payload?.settlement?.txHash ?? '';
    const nonce = payload?.payload?.authorization?.nonce ?? '';
    const key =
      payload?.accepted && txHash
        ? replayKey(payload.accepted.network, txHash)
        : '';

    // In-flight race defense: add key to inFlight BEFORE expensive daemon/signature verification
    // so simultaneous duplicate requests cannot both pass.
    if (key) {
      if (inFlight.has(key)) {
        sendRejected(res, opts, 'replay_detected', payer, req, txHash);
        return;
      }
      inFlight.add(key);
    }

    try {
      // 1. The payment must be for the requirement this server issued. Network
      // is called out first so a cross-network payment reports the right error.
      if (payload.accepted && payload.accepted.network !== opts.network) {
        sendRejected(res, opts, 'network_mismatch', payer, req, txHash);
        return;
      }
      if (!payload.accepted || !sameRequirement(payload.accepted, requirement(opts))) {
        sendRejected(res, opts, 'invalid_payment_requirements', payer, req, txHash);
        return;
      }

      // 2. The payment must be bound to this exact request URL (normalized on
      // both sides so proxy quirks cannot burn a payer's settled funds).
      let normalized = '';
      try {
        normalized = normalizeResourceUrl(payload.resource?.url ?? '');
      } catch {
        normalized = '';
      }
      if (normalized !== requestUrl(req, opts)) {
        sendRejected(res, opts, 'invalid_payment_payload', payer, req, txHash);
        return;
      }

      // 3. Local verification: shape, binding, signature, validity window.
      // CRITICAL: NEVER serve cached content or read daemon before the request's
      // signature and challenge binding are cryptographically verified!
      const local = verifyPayment(payload);
      if (!local.ok) {
        sendRejected(res, opts, local.error ?? 'invalid_payment_payload', payer, req, txHash);
        return;
      }

      // 4. Cache hit check: only AFTER verification succeeds.
      // Cache key binds (network + nonce + resource + payer + txHash) so a bare txid
      // copied from /verify cannot retrieve cached data without the payer's key.
      const cacheKey = responseCacheKey(opts.network, nonce, normalized, payer, txHash);
      if (key && (await replay.has(key))) {
        const cached = responses.get(cacheKey);
        if (cached && Date.now() - cached.at <= RESPONSE_TTL_MS) {
          const c = cached.res;
          res.statusCode = c.status;
          for (const [name, value] of Object.entries(c.headers)) {
            if (value !== undefined) res.setHeader(name, value as string | string[] | number);
          }
          res.setHeader('X-Sats402-Replayed', '1');
          res.end(c.body);
          return;
        }
        sendRejected(res, opts, 'replay_detected', payer, req, txHash);
        return;
      }

      // 5. Read-only settlement verification against the Tachi daemon.
      let tx;
      try {
        tx = await fetchSettlement(opts.daemonUrl, txHash);
      } catch (err) {
        if (err instanceof SettlementLookupError) {
          // Transient daemon trouble is not a payment rejection: tell the
          // client to retry and consume nothing.
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'verification_unavailable', retry: true }));
          return;
        }
        throw err;
      }
      const settled = verifySettlement(payload, tx);
      if (!settled.ok) {
        sendRejected(res, opts, settled.error ?? 'settlement_not_found', payer, req, txHash);
        return;
      }

      // 6. Single use: consume now that the payment is proven.
      if (key && !(await replay.consume(key))) {
        sendRejected(res, opts, 'replay_detected', payer, req, txHash);
        return;
      }

      // PAID: report the settlement, then serve the resource. The response is
      // recorded under the bound cache key so a replay of this settlement returns
      // the same response without a second charge.
      const response: SettlementResponse = {
        success: true,
        transaction: txHash,
        network: payload.accepted.network,
        payer,
      };
      const { res: capturedRes, capture } = recording(res);
      capturedRes.setHeader(HEADER_PAYMENT_RESPONSE, b64(response));
      await opts.serve(req, capturedRes);
      if (cacheKey && capturedRes.statusCode < 400) remember(cacheKey, capture());
    } finally {
      if (key) inFlight.delete(key);
    }
  };
}
