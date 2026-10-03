// The demo agent: run a real paid call from the website.
//
// POST /api/demo/call  { "target": "s1" | "s2", "question": "..." }
//
// Acts exactly like any Sats402 agent: it receives the 402 challenge, checks
// its own spending policy, settles with its own key (a real tachi_tx), retries
// with the payment proof, and reports the whole exchange. The sats are real.
import { Sats402Agent, getSpendableSats, PolicyError } from '@sats402/agent';
import { deriveIdentity, NETWORK_TACHI_REGTEST } from '@sats402/core';

const DAEMON = process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com';
const AGENT_MNEMONIC =
  process.env.SATS402_AGENT_MNEMONIC ??
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const S1_MNEMONIC =
  process.env.SATS402_S1_MNEMONIC ??
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const S2_MNEMONIC =
  process.env.SATS402_S2_MNEMONIC ??
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

function b64json(value) {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'POST { target: "s1" | "s2", question? }' }));
    return;
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  const target = body.target === 's2' ? 's2' : 's1';
  const origin = `https://${req.headers.host}`;

  const identity = deriveIdentity(AGENT_MNEMONIC, 'regtest', 0);
  const s1 = deriveIdentity(S1_MNEMONIC, 'regtest', 0);
  const s2 = deriveIdentity(S2_MNEMONIC, 'regtest', 0);
  const url = target === 's2' ? `${origin}/api/s2/complete` : `${origin}/api/s1/stats`;

  const agent = new Sats402Agent({
    identity,
    daemonUrl: DAEMON,
    network: NETWORK_TACHI_REGTEST,
    policy: {
      perCallCapSats: 60n,
      sessionBudgetSats: 400n,
      payeeAllowlist: [s1.xOnly, s2.xOnly],
    },
  });

  try {
    // 1. The unpaid call: show the challenge the service issues.
    const probe = await fetch(url, {
      method: target === 's2' ? 'POST' : 'GET',
      headers: target === 's2' ? { 'content-type': 'application/json' } : {},
      body: target === 's2' ? JSON.stringify({ question: body.question ?? '' }) : undefined,
    });
    const challenge = probe.headers.get('PAYMENT-REQUIRED')
      ? b64json(probe.headers.get('PAYMENT-REQUIRED'))
      : null;

    // 2. The paid call: policy -> settle (our own tachi_tx) -> retry.
    const started = Date.now();
    const paid = await agent.fetch(url, {
      method: target === 's2' ? 'POST' : 'GET',
      headers: target === 's2' ? { 'content-type': 'application/json' } : {},
      body: target === 's2' ? JSON.stringify({ question: body.question ?? '' }) : undefined,
    });
    const elapsedMs = Date.now() - started;
    const served = await paid.json();
    const receipt = paid.headers.get('PAYMENT-RESPONSE')
      ? b64json(paid.headers.get('PAYMENT-RESPONSE'))
      : null;

    // 3. The independent re-fetch, straight from the daemon record endpoint.
    const record = receipt?.transaction
      ? await (await fetch(`${origin}/receipt/${receipt.transaction}`)).json()
      : null;

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        {
          target,
          price_sats: target === 's2' ? '50' : '5',
          challenge_seen: challenge
            ? {
                price: challenge.accepts?.[0]?.amount,
                network: challenge.accepts?.[0]?.network,
                payTo: challenge.accepts?.[0]?.payTo,
                flow: challenge.accepts?.[0]?.extra,
              }
            : null,
          payment: receipt
            ? {
                txHash: receipt.transaction,
                payer: receipt.payer,
                network: receipt.network,
                settled: receipt.success,
              }
            : null,
          settled_record: record,
          response_status: paid.status,
          served,
          elapsed_ms: elapsedMs,
          agent_spent_sats: String(agent.spentSats),
          verify_command: receipt?.transaction
            ? `npx sats402 verify ${receipt.transaction}`
            : null,
        },
        null,
        2
      )
    );
  } catch (err) {
    const status = err instanceof PolicyError ? 402 : 500;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: String(err instanceof Error ? err.message : err),
        policy_refusal: err instanceof PolicyError ? err.reason : undefined,
      })
    );
  }
}
