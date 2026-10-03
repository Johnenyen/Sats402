// The demo agent: run a real paid call from the website.
//
// POST /api/demo/call  { "target": "s1" | "s2", "question": "..." }
//
// Acts exactly like any Sats402 agent: it receives the 402 challenge, checks
// its own spending policy, settles with its own key (a real tachi_tx), retries
// with the payment proof, and reports the whole exchange. The sats are real.
//
// Guarded: per-IP rate limit (the wallet is real and finite), fixed outbound
// origin (no Host-header SSRF), and an automatic small top-up of the S2 key
// from the agent key when S2 runs low (reported in the response as setup).
import { Sats402Agent, settleTransfer, getSpendableSats, PolicyError } from '@sats402/agent';
import { deriveIdentity, NETWORK_TACHI_REGTEST, userAddressForXOnly } from '@sats402/core';
import { readJson } from '../_lib/readjson.mjs';

const DAEMON = process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com';
// Fixed outbound origin: never built from the request Host header.
const SELF = process.env.SATS402_PUBLIC_URL ?? 'https://sats402-receipts.vercel.app';
const AGENT_MNEMONIC =
  process.env.SATS402_AGENT_MNEMONIC ??
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const S1_MNEMONIC =
  process.env.SATS402_S1_MNEMONIC ??
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const S2_MNEMONIC =
  process.env.SATS402_S2_MNEMONIC ??
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

// Simple per-IP rate limit: the demo wallet is real and finite. Per-instance,
// best effort; it stops casual loops, not a determined attacker.
const hits = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 6;
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) return true;
  list.push(now);
  hits.set(ip, list);
  return false;
}

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

  const ip =
    (req.headers['x-forwarded-for'] ?? '').toString().split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  if (rateLimited(ip)) {
    res.statusCode = 429;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error:
          'rate limit: 6 demo payments per hour per client. The demo wallet is real and finite.',
      })
    );
    return;
  }

  const body = await readJson(req);
  const target = body.target === 's2' ? 's2' : 's1';

  const identity = deriveIdentity(AGENT_MNEMONIC, 'regtest', 0);
  const s1 = deriveIdentity(S1_MNEMONIC, 'regtest', 0);
  const s2 = deriveIdentity(S2_MNEMONIC, 'regtest', 0);
  const url = target === 's2' ? `${SELF}/api/s2/complete` : `${SELF}/api/s1/stats`;

  // Keep the demo self-healing: if S2's key is low, the agent tops it up so S2
  // can keep buying facts. This is infrastructure, reported as such.
  let setupTopup = null;
  const s2Balance = await getSpendableSats(s2, DAEMON);
  if (target === 's2' && s2Balance < 20n) {
    const tx = await settleTransfer({
      identity,
      recipientAddress: userAddressForXOnly(s2.xOnly),
      amountSats: 100n,
      feeSats: 1n,
      daemonUrl: DAEMON,
    });
    setupTopup = { what: 'top up S2 key so it can buy facts', amountSats: '100', tx: tx.txHash };
  }

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
    const init = {
      method: target === 's2' ? 'POST' : 'GET',
      headers: target === 's2' ? { 'content-type': 'application/json' } : {},
      body: target === 's2' ? JSON.stringify({ question: body.question ?? '' }) : undefined,
    };
    const probe = await fetch(url, init);
    const challenge = probe.headers.get('PAYMENT-REQUIRED')
      ? b64json(probe.headers.get('PAYMENT-REQUIRED'))
      : null;

    // 2. The paid call: policy -> settle (our own tachi_tx) -> retry.
    const started = Date.now();
    const paid = await agent.fetch(url, init);
    const elapsedMs = Date.now() - started;
    const served = await paid.json();
    const receipt = paid.headers.get('PAYMENT-RESPONSE')
      ? b64json(paid.headers.get('PAYMENT-RESPONSE'))
      : null;

    // 3. The independent re-fetch, straight from the daemon record endpoint.
    const record = receipt?.transaction
      ? await (await fetch(`${SELF}/receipt/${receipt.transaction}`)).json()
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
          setup_topup: setupTopup,
          wallet: {
            agent_balance_sats: String(await getSpendableSats(identity, DAEMON)),
            agent_spent_this_call_sats: String(agent.spentSats),
            s2_balance_sats: String(await getSpendableSats(s2, DAEMON)),
          },
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
        wallet: {
          agent_balance_sats: String(await getSpendableSats(identity, DAEMON).catch(() => 'n/a')),
        },
      })
    );
  }
}
