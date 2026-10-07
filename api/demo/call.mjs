// The demo agent: run a real paid call from the website.
//
// POST /api/demo/call  { "target": "data" | "fees" | "network" | "inference", "question": "..." }
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
  // Answer CORS preflights so cross-origin agents can call this endpoint.
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, payment-signature');
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'POST { target: "data" | "fees" | "network" | "inference", question? }' }));
    return;
  }

  const ip =
    (req.headers['x-forwarded-for'] ?? '').toString().split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  if (rateLimited(ip)) {
    res.statusCode = 429;
    res.setHeader('retry-after', '300');
    res.end(
      JSON.stringify({
        error:
          'rate limit: 6 demo payments per hour per client. The demo wallet is real and finite. Run `npm run demo:pay` from a checkout to pay from your own wallet.',
        rate_limited: true,
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

  const priceSats = BigInt(selected.price);
  const feeSats = 1n;
  // Guard 1: preflight the wallet before any attempt. A demo wallet that
  // cannot cover the next payment fails with an honest message instead of a
  // chain error. Threshold covers price + fee for the two purchase shapes.
  const minSats = target === 'inference' ? priceSats + 6n : priceSats + feeSats;
  let balance;
  try {
    balance = await getSpendableSats(identity, DAEMON);
  } catch {
    balance = null; // daemon read failed: don't block, let the flow report it
  }
  if (balance !== null && balance < minSats) {
    try {
      balance = await ensureFunded(identity, DAEMON, 1000n, minSats);
    } catch {
      // faucet auto-refill failed, continue to 503 check below
    }
  }
  if (balance !== null && balance < minSats) {
    res.statusCode = 503;
    res.setHeader('retry-after', '3600');
    res.end(
      JSON.stringify({
        error:
          'The demo wallet is empty (spendable: ' +
          balance.toString() +
          ' sats). Run `npm run cold-start` from a checkout with your own keys to see the same flow end to end.',
        wallet_empty: true,
        agent_balance_sats: balance.toString(),
      })
    );
    return;
  }

  // Guard 2: inference needs the service's own agent to buy data first. If the
  // INFERENCE service wallet is drained, auto-top up before charging visitor.
  if (target === 'inference') {
    try {
      let inferenceBalance = await getSpendableSats(inferenceService, DAEMON);
      if (inferenceBalance < 6n) {
        try {
          inferenceBalance = await ensureFunded(inferenceService, DAEMON, 1000n, 10n);
        } catch {}
      }
      if (inferenceBalance < 6n) {
        res.statusCode = 503;
        res.setHeader('retry-after', '3600');
        res.end(
          JSON.stringify({
            error:
              'The inference service wallet cannot currently buy the live data it grounds answers in. Try the data feeds (5 sats), or run `npm run cold-start` with your own keys.',
            wallet_empty: true,
            inference_service_balance_sats: inferenceBalance.toString(),
          })
        );
        return;
      }
    } catch {
      // daemon read failed: don't block, the flow will surface any real error
    }
  }

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

    // 2. The paid call: policy -> settle (our own tachi_tx) -> retry. A mempool
    // race (another attempt's VTXO still pending) settled nothing, so retrying
    // is safe: back off and retry until the mempool clears (6s, then 12s).
    // The paid call gets its own generous timeout: the chained inference path
    // (settle -> service buys grounding data -> LLM) legitimately exceeds the
    // probe's 8s, and aborting it mid-settlement reports a false timeout.
    const paidInit = { ...init, signal: AbortSignal.timeout(60_000) };
    const started = Date.now();
    let paid;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        paid = await agent.fetch(url, paidInit);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (!/pending in mempool/i.test(String(err?.message ?? err))) throw err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 6000 * (attempt + 1)));
      }
    }
    if (!paid) throw lastErr;
    const elapsedMs = Date.now() - started;
    const served = await paid.json();
    const receipt = paid.headers.get('PAYMENT-RESPONSE')
      ? b64json(paid.headers.get('PAYMENT-RESPONSE'))
      : null;
    const replayed = paid.headers.get('X-Sats402-Replayed') === '1';

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
                replayed,
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
    const message = String(err instanceof Error ? err.message : err);
    if (err instanceof PolicyError) {
      res.statusCode = 402;
      res.end(
        JSON.stringify({
          error: message,
          policy_refusal: err.reason,
          wallet: {
            agent_balance_sats: await getSpendableSats(identity, DAEMON).catch(() => 'n/a'),
          },
        })
      );
      return;
    }
    if (/insufficient funds/i.test(message)) {
      res.statusCode = 503;
      res.setHeader('retry-after', '3600');
      res.end(
        JSON.stringify({
          error:
            'The demo wallet could not cover this payment. Run `npm run cold-start` from a checkout with your own keys to see the same flow end to end.',
          wallet_empty: true,
        })
      );
      return;
    }
    if (/pending in mempool/i.test(message)) {
      res.statusCode = 409;
      res.end(
        JSON.stringify({
          error:
            'Two payment attempts raced inside the demo wallet; the second was rejected by the mempool. Nothing was charged. Wait a few seconds and try again.',
          mempool_race: true,
        })
      );
      return;
    }
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        error: message,
        note: 'This is a live payment path: the underlying error is surfaced verbatim rather than hidden.',
      })
    );
  }
}
