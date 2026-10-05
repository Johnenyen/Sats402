// The demo agent: run a real paid call from the website.
//
// POST /api/demo/call  { "target": "data" | "inference", "question": "..." }
//
// Acts exactly like any Sats402 agent: it receives the 402 challenge, checks
// its own spending policy, settles with its own key (a real tachi_tx), retries
// with the payment proof, and reports the whole exchange. The sats are real.
//
// Guarded: per-IP rate limit (the wallet is real and finite) and a fixed
// outbound origin (no Host-header SSRF).
import { Sats402Agent, getSpendableSats, ensureFunded, PolicyError } from '@sats402/agent';
import { deriveIdentity, NETWORK_TACHI_REGTEST } from '@sats402/core';
import { readJson } from '../_lib/readjson.mjs';
import { getPublicBaseUrl } from '../_lib/services.mjs';

const DAEMON = process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com';

const AGENT_MNEMONIC =
  process.env.SATS402_AGENT_MNEMONIC ??
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const DATA_MNEMONIC =
  process.env.SATS402_DATA_MNEMONIC ??
  process.env.SATS402_S1_MNEMONIC ??
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const INFERENCE_MNEMONIC =
  process.env.SATS402_INFERENCE_MNEMONIC ??
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
    res.end(JSON.stringify({ error: 'POST { target: "data" | "inference", question? }' }));
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
  const self = getPublicBaseUrl(req);
  const TARGETS = {
    data: { url: `${self}/api/services/price`, price: '5', post: false },
    fees: { url: `${self}/api/services/fees`, price: '5', post: false },
    network: { url: `${self}/api/services/network`, price: '5', post: false },
    inference: { url: `${self}/api/services/inference`, price: '50', post: true },
  };
  const target = TARGETS[body.target] ? body.target : 'data';
  const selected = TARGETS[target];

  const identity = deriveIdentity(AGENT_MNEMONIC, 'regtest', 0);
  const dataService = deriveIdentity(DATA_MNEMONIC, 'regtest', 0);
  const inferenceService = deriveIdentity(INFERENCE_MNEMONIC, 'regtest', 0);
  const url = selected.url;

  // Pre-flight funding: ensure wallet has sufficient sats before paying
  await ensureFunded(identity, DAEMON, 500n, BigInt(selected.price) + 2n);

  const agent = new Sats402Agent({
    identity,
    daemonUrl: DAEMON,
    network: NETWORK_TACHI_REGTEST,
    policy: {
      perCallCapSats: 60n,
      sessionBudgetSats: 400n,
      payeeAllowlist: [dataService.xOnly, inferenceService.xOnly],
    },
  });

  try {
    // 1. The unpaid call: show the challenge the service issues.
    const init = {
      method: selected.post ? 'POST' : 'GET',
      headers: selected.post ? { 'content-type': 'application/json' } : {},
      body: selected.post
        ? JSON.stringify({ question: body.question ?? '' })
        : undefined,
      signal: AbortSignal.timeout(8000),
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
    let record = null;
    if (receipt?.transaction) {
      try {
        const recRes = await fetch(`${self}/receipt/${receipt.transaction}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (recRes.ok) record = await recRes.json();
      } catch {}
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        {
          target,
          price_sats: selected.price,
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
          wallet: {
            agent_balance_sats: String(await getSpendableSats(identity, DAEMON)),
            agent_spent_this_call_sats: String(agent.spentSats),
            inference_service_balance_sats: String(
              await getSpendableSats(inferenceService, DAEMON)
            ),
          },
          verify_command: receipt?.transaction
            ? `node packages/cli/bin/sats402.mjs verify ${receipt.transaction}`
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
