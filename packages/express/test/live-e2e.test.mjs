// LIVE GATE (Phase 2, end to end): pay-per-request over real HTTP with real
// sats. Nothing mocked. Run: npm run test:live
//
// A paid service behind the paywall (price 5 sats). An agent with a spending
// policy requests it, gets 402, settles on Tachi, retries with the payment
// proof, and receives the resource. Then the failure paths: a policy refusal
// (local, no tx), a wrong-amount payment (rejected by the server), and a
// replayed settlement (rejected).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  NETWORK_TACHI_REGTEST,
  deriveIdentity,
  formPayment,
} from '@sats402/core';
import { Sats402Agent, PolicyError } from '@sats402/agent';
import { paywall, MemoryReplayStore, FileReplayStore } from '../dist/index.js';

const DAEMON = 'https://rpc-regtest.tachibtc.com';
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PAYEE_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const payer = deriveIdentity(MNEMONIC, 'regtest', 0);
const payee = deriveIdentity(PAYEE_MNEMONIC, 'regtest', 0);

let server;
let baseUrl;
let sharedReplayStore;

test.before(async () => {
  // A restart-durable store on disk, shared across the simulated servers.
  sharedReplayStore = new FileReplayStore(
    path.join(os.tmpdir(), `sats402-e2e-replay-${process.pid}.jsonl`)
  );
  const handle = paywall({
    priceSats: 5n,
    payeeXOnly: payee.xOnly,
    network: NETWORK_TACHI_REGTEST,
    daemonUrl: DAEMON,
    resource: {
      url: '/s1/fee-estimate',
      description: 'Live Tachi network stats',
      mimeType: 'application/json',
    },
    replay: sharedReplayStore,
    serve: (req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: 'fee-estimate', source: 'live daemon' }));
    },
  });
  server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());

test('E2E: agent pays per request and receives the resource', async () => {
  const agent = new Sats402Agent({
    identity: payer,
    daemonUrl: DAEMON,
    network: NETWORK_TACHI_REGTEST,
    policy: {
      perCallCapSats: 10n,
      sessionBudgetSats: 50n,
      payeeAllowlist: [payee.xOnly],
    },
  });

  const res = await agent.fetch(`${baseUrl}/s1/fee-estimate`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data, 'fee-estimate');

  const receipt = res.headers.get('PAYMENT-RESPONSE');
  assert.ok(receipt, 'success response must carry PAYMENT-RESPONSE');
  const parsed = JSON.parse(Buffer.from(receipt, 'base64').toString('utf8'));
  assert.equal(parsed.success, true);
  assert.match(parsed.transaction, /^[0-9a-f]{64}$/);
  assert.equal(parsed.payer, payer.xOnly);

  // The reported settlement must re-fetch from the daemon.
  const { fetchSettlement } = await import('@sats402/core/verify');
  const tx = await fetchSettlement(DAEMON, parsed.transaction);
  assert.ok(tx, 'settlement must re-fetch from the daemon');
  assert.ok(tx.vout.some((o) => o.owner === payee.xOnly && BigInt(o.amount) === 5n));

  // spentSats counts what left the agent's control: 5 sats paid + 1 sat fee.
  assert.equal(agent.spentSats, 6n);
  console.log(JSON.stringify({
    e2e: 'PASSED',
    txHash: parsed.transaction,
    status: res.status,
    spentSats: String(agent.spentSats),
  }));
});

test('policy refusal is local: no transaction is made', async () => {
  const agent = new Sats402Agent({
    identity: payer,
    daemonUrl: DAEMON,
    network: NETWORK_TACHI_REGTEST,
    policy: {
      perCallCapSats: 1n, // below the 5-sat price
      sessionBudgetSats: 50n,
      payeeAllowlist: [payee.xOnly],
    },
  });

  await assert.rejects(
    () => agent.fetch(`${baseUrl}/s1/fee-estimate`),
    (err) => err instanceof PolicyError && err.reason === 'per_call_cap'
  );
  assert.equal(agent.spentSats, 0n);
  console.log(JSON.stringify({ policy_refusal: 'LOCAL, NO TX' }));
});

test('server rejects a self-consistent payment with the wrong amount', async () => {
  // An attacker signs a payment for 4 sats instead of the offered 5: the
  // signature is internally valid, but the accepted requirement is not the
  // one the server issued.
  const forgedAccepted = {
    scheme: 'exact',
    network: NETWORK_TACHI_REGTEST,
    amount: '4',
    asset: 'BTC',
    payTo: payee.xOnly,
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: 'tachi_tx', paymentFlow: 'upfront' },
  };
  const payload = formPayment({
    accepted: forgedAccepted,
    resource: { url: `${baseUrl}/s1/fee-estimate` },
    signer: payer.signer,
    from: payer.xOnly,
    settlement: { txHash: 'a'.repeat(64), state: 'committed' },
  });

  const res = await fetch(`${baseUrl}/s1/fee-estimate`, {
    headers: {
      'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload)).toString('base64'),
    },
  });
  assert.equal(res.status, 402);
  const receipt = JSON.parse(
    Buffer.from(res.headers.get('PAYMENT-RESPONSE'), 'base64').toString('utf8')
  );
  assert.equal(receipt.success, false);
  assert.equal(receipt.errorReason, 'invalid_payment_requirements');
  console.log(JSON.stringify({ wrong_amount: 'REJECTED', reason: receipt.errorReason }));
});

test('a replayed settlement is never charged again', async () => {
  // Pay once with a manually built payment, keep the header, send it again.
  const accepted = {
    scheme: 'exact',
    network: NETWORK_TACHI_REGTEST,
    amount: '5',
    asset: 'BTC',
    payTo: payee.xOnly,
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: 'tachi_tx', paymentFlow: 'upfront' },
  };
  const { settleTransfer } = await import('@sats402/agent');
  const settled = await settleTransfer({
    identity: payer,
    recipientAddress: payee.userAddress,
    amountSats: 5n,
    feeSats: 1n,
    daemonUrl: DAEMON,
  });
  const payload = formPayment({
    accepted,
    resource: { url: `${baseUrl}/s1/fee-estimate` },
    signer: payer.signer,
    from: payer.xOnly,
    settlement: { txHash: settled.txHash, state: 'committed' },
  });
  const header = Buffer.from(JSON.stringify(payload)).toString('base64');

  const first = await fetch(`${baseUrl}/s1/fee-estimate`, {
    headers: { 'PAYMENT-SIGNATURE': header },
  });
  assert.equal(first.status, 200, 'the first use of a settlement is accepted');
  const firstBody = await first.text();

  // PAID-BUT-EXPIRED POLICY: a retry with the same proof gets the original
  // response back, marked as a replay, with no second charge.
  const second = await fetch(`${baseUrl}/s1/fee-estimate`, {
    headers: { 'PAYMENT-SIGNATURE': header },
  });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('X-Sats402-Replayed'), '1');
  assert.equal(await second.text(), firstBody);

  // A server that no longer holds the response (restart) still refuses the
  // replay, because the consumption key is restart-durable.
  const freshServer = http.createServer((req, res) =>
    paywall({
      priceSats: 5n,
      payeeXOnly: payee.xOnly,
      network: NETWORK_TACHI_REGTEST,
      daemonUrl: DAEMON,
      resource: { url: '/s1/fee-estimate' },
      // A NEW instance on the same file: exactly what a process restart sees.
      replay: new FileReplayStore(sharedReplayStore.filePath),
      serve: (req2, res2) => {
        res2.statusCode = 200;
        res2.end('served');
      },
    })(req, res)
  );
  await new Promise((resolve) => freshServer.listen(0, '127.0.0.1', resolve));
  const freshUrl = `http://127.0.0.1:${freshServer.address().port}/s1/fee-estimate`;
  const third = await fetch(freshUrl, { headers: { 'PAYMENT-SIGNATURE': header } });
  assert.equal(third.status, 402);
  const receipt = JSON.parse(
    Buffer.from(third.headers.get('PAYMENT-RESPONSE'), 'base64').toString('utf8')
  );
  assert.equal(receipt.errorReason, 'replay_detected');
  freshServer.close();
  console.log(JSON.stringify({
    replay: 'NEVER CHARGED TWICE',
    idempotentRetry: 'original response returned',
    restartReplay: 'rejected (durable key store)',
    txHash: settled.txHash,
  }));
});
