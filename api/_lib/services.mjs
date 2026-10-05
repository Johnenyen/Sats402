// Shared service construction: wrap a live data product in the Sats402 paywall.
//
// Every service in this directory is shaped the same way, the way paid API
// products are arranged in the Bitcoin agent ecosystem: one endpoint, one
// price in sats, live data, no accounts.
import { paywall, FileReplayStore } from '@sats402/express';
import { deriveIdentity, NETWORK_TACHI_REGTEST } from '@sats402/core';

const DAEMON = process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com';

/**
 * CORS wrapper: web-based agents must be able to call these endpoints from any
 * origin and read the payment headers. Handles the preflight for the custom
 * x402 headers.
 */
export function withCors(handler) {
  return async function corsHandler(req, res) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader(
      'access-control-expose-headers',
      'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Sats402-Replayed'
    );
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader(
        'access-control-allow-headers',
        'content-type, PAYMENT-SIGNATURE'
      );
      res.statusCode = 204;
      res.end();
      return;
    }
    return handler(req, res);
  };
}

/**
 * Derive public base URL from incoming request or environment variables.
 * Ensures consistent normalization across sats402.vercel.app and mirrors.
 */
export function getPublicBaseUrl(req) {
  if (process.env.SATS402_PUBLIC_URL) return process.env.SATS402_PUBLIC_URL;
  if (req) {
    const origin = req.headers?.origin;
    if (origin && typeof origin === 'string') return origin.replace(/\/$/, '');
    const forwardedProto = req.headers?.['x-forwarded-proto'];
    const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]?.trim() || 'https';
    const forwardedHost = req.headers?.['x-forwarded-host'];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(',')[0]?.trim() || req.headers?.host;
    if (host) return `${proto}://${host}`;
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://sats402.vercel.app';
}

/**
 * Pluggable replay store: uses external KV (Vercel KV or Upstash Redis) when
 * environment variables are present. When absent, uses an in-process store with
 * best-effort local file caching. Durability boundary: replay protection is
 * restart-durable only when configured with an external persistent store;
 * without one, durability is bounded by instance lifetime.
 */
export function createReplayStore(serviceName) {
  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (kvUrl && kvToken) {
    const memory = new Set();
    return {
      async consume(key) {
        if (memory.has(key)) return false;
        try {
          const res = await fetch(`${kvUrl}/set/sats402:replay:${encodeURIComponent(key)}/consumed?nx=true`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${kvToken}` },
          });
          if (res.ok) {
            const data = await res.json();
            if (data.result === 'OK') {
              memory.add(key);
              return true;
            }
            return false;
          }
        } catch {
          // If external call fails, fall back to in-process memory
        }
        if (memory.has(key)) return false;
        memory.add(key);
        return true;
      },
      async has(key) {
        if (memory.has(key)) return true;
        try {
          const res = await fetch(`${kvUrl}/get/sats402:replay:${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${kvToken}` },
          });
          if (res.ok) {
            const data = await res.json();
            if (data.result !== null && data.result !== undefined) {
              memory.add(key);
              return true;
            }
          }
        } catch {}
        return memory.has(key);
      },
    };
  }

  return new FileReplayStore(`/tmp/sats402-replay-${serviceName.replace(/\W+/g, '-')}.jsonl`);
}

/**
 * Build a paid data endpoint.
 *
 * @param {object} opts
 * @param {string} opts.service        Human name, used in the challenge.
 * @param {string} opts.description   What the buyer gets.
 * @param {bigint} opts.priceSats     Price per request.
 * @param {string} opts.mnemonicEnv   Env var holding the payee mnemonic.
 * @param {string} opts.defaultMnemonic Demo fixture fallback.
 * @param {string} [opts.path]        Public path (for the bound URL copy).
 * @param {() => Promise<object>} opts.fetchProduct  The live product.
 */
export function dataFeedPaywall(opts) {
  const mnemonic = process.env[opts.mnemonicEnv] ?? opts.defaultMnemonic;
  const payee = deriveIdentity(mnemonic, 'regtest', 0);

  return withCors(
    paywall({
      priceSats: opts.priceSats,
      payeeXOnly: payee.xOnly,
      network: NETWORK_TACHI_REGTEST,
      daemonUrl: DAEMON,
      publicBaseUrl: (req) => getPublicBaseUrl(req),
      replay: createReplayStore(opts.service),
      maxTimeoutSeconds: 120,
      resource: {
        description: `${opts.description} (${opts.service})`,
        mimeType: opts.mimeType ?? 'application/json',
      },
      serve: async (req, res) => {
        const product = await opts.fetchProduct();
        res.statusCode = 200;
        if (opts.render) {
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(opts.render(product));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(product, null, 2));
      },
    })
  );
}

/** The payee identity of a service (for allowlists and documentation). */
export function serviceIdentity(mnemonicEnv, defaultMnemonic) {
  return deriveIdentity(process.env[mnemonicEnv] ?? defaultMnemonic, 'regtest', 0);
}
