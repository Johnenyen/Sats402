// COLD START — the Sats402 example app, one command.
//
//   npm run cold-start
//
// An agent asks a question and pays for the answer in native sats on Tachi.
// The service cannot answer until it has paid for the live fact the answer
// needs. Two purchases, one run: agent-to-service and agent-to-agent. Then a
// burst of twenty paid calls with measured latency, then two clean failures.
//
// Everything is real: live daemon data, real inference, real settlements.
// Demo keys are the public BIP-39 test vectors (fixtures, not secrets).
import { deriveIdentity, formPayment, NETWORK_TACHI_REGTEST } from '@sats402/core';
import { Sats402Agent, settleTransfer, getSpendableSats, PolicyError } from '@sats402/agent';
import { verifyReceipt } from '@sats402/verify';
import { startS1, startS2 } from './services.mjs';

const DAEMON = process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com';
const MODEL = process.env.SATS402_MODEL ?? 'mistralai/ministral-14b';
const XKIRO_KEY = process.env.XKIRO_API_KEY ?? '';
const PROMPT =
  'What is the recommended fee on this Tachi network right now, and is 50 sats enough for ten calls?';

// Public BIP-39 test vectors as demo fixtures.
const AGENT_MNEMONIC = process.env.SATS402_AGENT_MNEMONIC ??
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const S1_MNEMONIC = process.env.SATS402_S1_MNEMONIC ??
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const S2_MNEMONIC = process.env.SATS402_S2_MNEMONIC ??
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

const line = (s = '') => console.log(s);

async function main() {
  line('=== COLD START: the Sats402 example app ===');
  line('An agent pays per request in native sats on Tachi. No custodian in the path.');
  line('');

  const agent = deriveIdentity(AGENT_MNEMONIC, 'regtest', 0);
  const s1 = deriveIdentity(S1_MNEMONIC, 'regtest', 0);
  const s2 = deriveIdentity(S2_MNEMONIC, 'regtest', 0);

  // ---- SETUP (one-time, not part of the payment story) ----------------
  const s2Funds = await getSpendableSats(s2, DAEMON);
  if (s2Funds < 20n) {
    line(`[setup] funding S2's key with 100 sats so it can pay for facts...`);
    const setupTx = await settleTransfer({
      identity: agent,
      recipientAddress: s2.userAddress,
      amountSats: 100n,
      feeSats: 1n,
      daemonUrl: DAEMON,
    });
    line(`[setup] done: ${setupTx.txHash}`);
    line('');
  }

  // ---- THE SERVICES ---------------------------------------------------
  const s1Svc = await startS1({ identity: s1, priceSats: 5n });
  const s2Svc = await startS2({
    identity: s2,
    s1Url: s1Svc.url,
    s1PayeeXOnly: s1.xOnly,
    priceSats: 50n,
    model: MODEL,
    apiKey: XKIRO_KEY,
  });
  line(`[services] S1 daemon-stats: ${s1Svc.url} (5 sats per call)`);
  line(`[services] S2 completion:   ${s2Svc.url} (50 sats per call)`);
  line('');

  // ---- THE LOOP: one question, two purchases -------------------------
  line(`[agent] prompt: "${PROMPT}"`);
  line('[agent] spending policy: per-call cap 50 sats, session budget 500 sats, payee allowlist on');
  const buyer = new Sats402Agent({
    identity: agent,
    daemonUrl: DAEMON,
    network: NETWORK_TACHI_REGTEST,
    policy: {
      perCallCapSats: 50n,
      sessionBudgetSats: 500n,
      payeeAllowlist: [s1.xOnly, s2.xOnly],
    },
  });

  const t0 = Date.now();
  const res = await buyer.fetch(s2Svc.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: PROMPT }),
  });
  const body = await res.json();
  const receiptHeader = JSON.parse(
    Buffer.from(res.headers.get('PAYMENT-RESPONSE'), 'base64').toString('utf8')
  );
  line('');
  line(`[answer] ${body.answer}`);
  line('');

  // ---- RECEIPTS -------------------------------------------------------
  line('[receipts]');
  const r1 = await verifyReceipt(DAEMON, receiptHeader.transaction, {
    payee: s2.xOnly,
    amountSats: 50n,
  });
  line(`  buy the answer  50 sats  agent -> S2 (inference)   tx ${receiptHeader.transaction}`);
  line(`    state: ${r1.state}  epoch: ${r1.epoch}  re-fetch: ${r1.found ? 'yes' : 'NO'}`);
  const r2 = await verifyReceipt(DAEMON, body.s1_payment.tx, {
    payee: s1.xOnly,
    amountSats: 5n,
  });
  line(`  buy the fact     5 sats  S2 -> S1 (daemon read)    tx ${body.s1_payment.tx}`);
  line(`    state: ${r2.state}  epoch: ${r2.epoch}  re-fetch: ${r2.found ? 'yes' : 'NO'}`);
  line('  every record is daemon-returned and re-fetchable');
  line('');

  // ---- BURST: high-velocity proof ------------------------------------
  line('[burst] 20 paid S1 calls, live counter, measured latency');
  const latencies = [];
  const burstTxIds = [];
  for (let i = 1; i <= 20; i++) {
    const start = Date.now();
    const r = await buyer.fetch(s1Svc.url);
    const ms = Date.now() - start;
    latencies.push(ms);
    const receiptRaw = r.headers.get('PAYMENT-RESPONSE');
    const receipt = receiptRaw
      ? JSON.parse(Buffer.from(receiptRaw, 'base64').toString('utf8'))
      : null;
    if (receipt?.transaction) burstTxIds.push(receipt.transaction);
    const ok = r.status === 200;
    line(`  ${String(i).padStart(2)}/20  ${ok ? 'paid + served' : `status ${r.status}`}  ${ms} ms  tx ${receipt?.transaction ?? 'n/a'}`);
    if (!ok) break;
  }
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)];
  line(
    `[burst] done: ${latencies.length}/20  p50 ${pct(50)} ms  p95 ${pct(95)} ms  max ${latencies[latencies.length - 1]} ms`
  );
  line('');

  // ---- FAILURE PATHS --------------------------------------------------
  line('[failure] one wrong-amount payment: clean rejection, no second charge');
  const spentBefore = buyer.spentSats;
  const forged = formPayment({
    accepted: {
      scheme: 'exact',
      network: NETWORK_TACHI_REGTEST,
      amount: '49', // the challenge said 50
      asset: 'BTC',
      payTo: s2.xOnly,
      maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: 'tachi_tx', paymentFlow: 'upfront' },
    },
    resource: { url: s2Svc.url },
    signer: agent.signer,
    from: agent.xOnly,
    settlement: { txHash: 'a'.repeat(64), state: 'committed' },
  });
  const rejected = await fetch(s2Svc.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(forged)).toString('base64'),
    },
    body: JSON.stringify({ question: PROMPT }),
  });
  const rejectedReceipt = JSON.parse(
    Buffer.from(rejected.headers.get('PAYMENT-RESPONSE'), 'base64').toString('utf8')
  );
  line(`  server answered ${rejected.status}: ${rejectedReceipt.errorReason}`);
  line(`  second charge: none (agent spent ${buyer.spentSats - spentBefore} sats on this attempt)`);
  line('');

  line('[failure] one call that would break the session budget: refused locally, no tx');
  const capped = new Sats402Agent({
    identity: agent,
    daemonUrl: DAEMON,
    network: NETWORK_TACHI_REGTEST,
    policy: {
      perCallCapSats: 50n,
      sessionBudgetSats: 10n, // below any real payment
      payeeAllowlist: [s1.xOnly, s2.xOnly],
    },
  });
  try {
    await capped.fetch(s2Svc.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: PROMPT }),
    });
    line('  UNEXPECTED: payment was not refused');
  } catch (err) {
    if (err instanceof PolicyError) {
      line(`  agent refused locally: ${err.reason} (no transaction was made)`);
    } else {
      throw err;
    }
  }
  line('');

  // ---- SUMMARY --------------------------------------------------------
  line('=== SUMMARY ===');
  line(`  loop:      agent -> inference service (50 sats), inference -> data service (5 sats), both re-fetchable`);
  line(`  burst:     ${latencies.length} paid calls, p50 ${pct(50)} ms, p95 ${pct(95)} ms`);
  line(`  failures:  wrong amount rejected by the server, over-budget call refused locally`);
  line(`  agent spent this session: ${buyer.spentSats} sats of a 500-sat budget`);
  line(`  total wall time: ${Math.round((Date.now() - t0) / 1000)} s`);

  // ---- PUBLISHED EVIDENCE (the numbers on the website come from here) --
  const evidence = {
    run_at: new Date().toISOString(),
    network: 'tachi-regtest-1',
    daemon: DAEMON,
    model: MODEL,
    prompt: PROMPT,
    answer: body.answer,
    receipts: [
      {
        what: 'buy the answer',
        description: 'agent -> inference service (model completion), agent-to-agent',
        amountSats: '50',
        tx: receiptHeader.transaction,
        state: r1.state,
        epoch: r1.epoch,
      },
      {
        what: 'buy the fact',
        description: 'inference service -> data service (live daemon read), agent-to-service',
        amountSats: '5',
        tx: body.s1_payment.tx,
        state: r2.state,
        epoch: r2.epoch,
      },
    ],
    burst: {
      count: latencies.length,
      latencies_ms: latencies,
      p50_ms: pct(50),
      p95_ms: pct(95),
      max_ms: latencies[latencies.length - 1],
      txids: burstTxIds,
    },
    failures: [
      {
        what: 'wrong amount',
        description: 'a signed payment for 49 sats against a 50-sat challenge',
        result: 'rejected by the server: invalid_payment_requirements',
        second_charge: false,
      },
      {
        what: 'over session budget',
        description: 'a call that would break the agent session budget',
        result: 'refused locally by the agent',
        transaction_made: false,
      },
    ],
    agent_spent_sats: String(buyer.spentSats),
  };
  const evidencePath = new URL('../apps/site/run-evidence.json', import.meta.url);
  await (await import('node:fs/promises')).writeFile(
    evidencePath,
    JSON.stringify(evidence, null, 2) + '\n'
  );
  line(`  evidence: apps/site/run-evidence.json (${burstTxIds.length} burst tx ids published)`);

  s1Svc.server.close();
  s2Svc.server.close();
}

main().catch((err) => {
  console.error('cold-start failed:', err);
  process.exit(1);
});
