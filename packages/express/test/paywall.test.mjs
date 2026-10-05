import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  NETWORK_TACHI_REGTEST,
  deriveIdentity,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_SIGNATURE,
  HEADER_PAYMENT_RESPONSE,
} from '@sats402/core';
import { paywall, MemoryReplayStore } from '../dist/index.js';

const payer = deriveIdentity(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'regtest',
  0
);
const payeeXOnly = '22'.repeat(32);
const MOCK_TXHASH = 'f'.repeat(64);

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

function unb64(str) {
  return JSON.parse(Buffer.from(str, 'base64').toString('utf8'));
}

test('COPIED TXHASH WITH NO VALID SIGNATURE RETURNS 402, NOT 200', async () => {
  let serveCount = 0;
  const replay = new MemoryReplayStore();
  const handle = paywall({
    priceSats: 50n,
    payeeXOnly,
    network: NETWORK_TACHI_REGTEST,
    daemonUrl: 'https://rpc-regtest.tachibtc.com',
    resource: {
      url: 'http://127.0.0.1/data',
      description: 'Test resource',
    },
    publicBaseUrl: 'http://127.0.0.1',
    replay,
    serve: (req, res) => {
      serveCount++;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ secret: 'premium_data', serveCount }));
    },
  });

  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Send challenge probe: verify 402 carries PAYMENT-REQUIRED
    const probe = await fetch(`${baseUrl}/data`);
    assert.equal(probe.status, 402);
    const challengeHeader = probe.headers.get(HEADER_PAYMENT_REQUIRED);
    assert.ok(challengeHeader, '402 challenge must carry PAYMENT-REQUIRED');
    const challenge = unb64(challengeHeader);
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.accepts[0].amount, '50');

    // 2. An attacker crafts a payload with a copied txHash from /verify but NO valid signature
    const copiedTxPayload = {
      x402Version: 2,
      resource: { url: 'http://127.0.0.1/data' },
      accepted: challenge.accepts[0],
      payload: {
        signature: '0'.repeat(128), // invalid/forged signature
        authorization: {
          from: payer.xOnly,
          to: payeeXOnly,
          value: '50',
          validAfter: String(Math.floor(Date.now() / 1000) - 60),
          validBefore: String(Math.floor(Date.now() / 1000) + 3600),
          nonce: '1'.repeat(64),
        },
        settlement: {
          txHash: MOCK_TXHASH,
          state: 'committed',
        },
      },
    };

    const res = await fetch(`${baseUrl}/data`, {
      headers: {
        [HEADER_PAYMENT_SIGNATURE]: b64(copiedTxPayload),
      },
    });

    // MUST return 402, NEVER 200
    assert.equal(res.status, 402, 'copied txHash with invalid signature must return 402');
    assert.equal(serveCount, 0, 'serve() must NEVER be called for unverified signature');

    // Rejection MUST carry PAYMENT-REQUIRED and PAYMENT-RESPONSE with real txHash
    const rejReqHeader = res.headers.get(HEADER_PAYMENT_REQUIRED);
    assert.ok(rejReqHeader, '402 rejection must carry PAYMENT-REQUIRED');
    const rejReq = unb64(rejReqHeader);
    assert.equal(rejReq.error, 'invalid_signature');

    const rejRespHeader = res.headers.get(HEADER_PAYMENT_RESPONSE);
    assert.ok(rejRespHeader, '402 rejection must carry PAYMENT-RESPONSE');
    const rejResp = unb64(rejRespHeader);
    assert.equal(rejResp.success, false);
    assert.equal(rejResp.transaction, MOCK_TXHASH, 'rejection must return submitted txHash');
  } finally {
    server.close();
  }
});

test('CACHED RESPONSE IS NOT ACCESSIBLE WITHOUT VALID SIGNATURE OVER BOUND CHALLENGE', async () => {
  const replay = new MemoryReplayStore();
  // Pre-seed the replay store to simulate an already-consumed settlement
  const key = `${NETWORK_TACHI_REGTEST}:${MOCK_TXHASH.toLowerCase()}`;
  replay.consume(key);

  const handle = paywall({
    priceSats: 50n,
    payeeXOnly,
    network: NETWORK_TACHI_REGTEST,
    daemonUrl: 'https://rpc-regtest.tachibtc.com',
    resource: {
      url: 'http://127.0.0.1/data',
    },
    publicBaseUrl: 'http://127.0.0.1',
    replay,
    serve: (req, res) => {
      res.statusCode = 200;
      res.end('secret');
    },
  });

  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Attacker sends the consumed txHash with an invalid signature
    const copiedPayload = {
      x402Version: 2,
      resource: { url: 'http://127.0.0.1/data' },
      accepted: {
        scheme: 'exact',
        network: NETWORK_TACHI_REGTEST,
        amount: '50',
        asset: 'BTC',
        payTo: payeeXOnly,
        maxTimeoutSeconds: 600,
        extra: { assetTransferMethod: 'tachi_tx', paymentFlow: 'upfront' },
      },
      payload: {
        signature: 'deadbeef'.repeat(16),
        authorization: {
          from: payer.xOnly,
          to: payeeXOnly,
          value: '50',
          validAfter: String(Math.floor(Date.now() / 1000) - 60),
          validBefore: String(Math.floor(Date.now() / 1000) + 3600),
          nonce: '2'.repeat(64),
        },
        settlement: {
          txHash: MOCK_TXHASH,
          state: 'committed',
        },
      },
    };

    const res = await fetch(`${baseUrl}/data`, {
      headers: {
        [HEADER_PAYMENT_SIGNATURE]: b64(copiedPayload),
      },
    });

    // Must be rejected at signature verification, NOT served from cache
    assert.equal(res.status, 402);
    const respHeader = unb64(res.headers.get(HEADER_PAYMENT_RESPONSE));
    assert.equal(respHeader.errorReason, 'invalid_signature');
    assert.equal(respHeader.transaction, MOCK_TXHASH);
  } finally {
    server.close();
  }
});
