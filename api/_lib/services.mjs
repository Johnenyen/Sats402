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
      replay: new FileReplayStore(`/tmp/sats402-replay-${opts.service.replace(/\W+/g, '-')}.jsonl`),
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
