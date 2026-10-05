// The two paid services of the example app.
//
// S1 "daemon stats"  : a paid read of live Tachi daemon data (5 sats).
// S2 "inference"     : a paid completion (50 sats). S2 is an agent with its own
//                      key: it cannot answer until it has paid S1 for the fact.
//
// Both sit behind the same paywall. Neither holds a customer key.
import http from 'node:http';
import { paywall } from '@sats402/express';
import { NETWORK_TACHI_REGTEST } from '@sats402/core';
import { Sats402Agent } from '@sats402/agent';

const DAEMON = process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com';
const XKIRO_URL =
  process.env.SATS402_XKIRO_URL ?? 'https://api.xkiro.com/v1/chat/completions';
// Cloudflare rejects non-browser clients on this API (error 1010).
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/** The live daemon read S1 sells. Fetched fresh on every paid request. */
export async function readDaemon() {
  const fee = await (await fetch(`${DAEMON}/tachi_feeEstimate`, { signal: AbortSignal.timeout(8000) })).json();
  const status = await (await fetch(`${DAEMON}/tachi_status`, { signal: AbortSignal.timeout(8000) })).json();
  return {
    fee_estimate_sat: fee,
    epoch_height: status?.result?.sync_info?.latest_block_height ?? null,
    network: status?.result?.node_info?.network ?? null,
    read_at: new Date().toISOString(),
    source: 'live Tachi daemon read, no cache',
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** S1: paid live daemon data. */
export function startS1({ identity, priceSats = 5n }) {
  const handle = paywall({
    priceSats,
    payeeXOnly: identity.xOnly,
    network: NETWORK_TACHI_REGTEST,
    daemonUrl: DAEMON,
    resource: {
      url: '/s1/daemon-stats',
      description: 'Live Tachi daemon data: fee estimate and epoch height',
      mimeType: 'application/json',
    },
    serve: async (req, res) => {
      const data = await readDaemon();
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(data));
    },
  });
  const server = http.createServer((req, res) => handle(req, res));
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/s1/daemon-stats` })
    )
  );
}

/** S2: paid inference. Buys its fact from S1 before answering. */
export function startS2({ identity, s1Url, s1PayeeXOnly, priceSats = 50n, model, apiKey }) {
  if (!apiKey) {
    console.log(
      '[services] Note: XKIRO_API_KEY is not set; falling back to deterministic local completion (payment flows still execute real settlements)'
    );
  }

  // S2 is itself an agent: its own key, its own spend policy, its own payments.
  const s2Agent = new Sats402Agent({
    identity,
    daemonUrl: DAEMON,
    network: NETWORK_TACHI_REGTEST,
    policy: {
      perCallCapSats: 10n,
      sessionBudgetSats: 200n,
      payeeAllowlist: [s1PayeeXOnly],
    },
  });

  const handle = paywall({
    priceSats,
    payeeXOnly: identity.xOnly,
    network: NETWORK_TACHI_REGTEST,
    daemonUrl: DAEMON,
    resource: {
      url: '/s2/complete',
      description: 'A paid AI completion grounded in live Tachi daemon data',
      mimeType: 'application/json',
    },
    serve: async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');

      // S2 CANNOT ANSWER UNTIL IT HAS PAID S1 for the live fact.
      const factRes = await s2Agent.fetch(s1Url);
      if (!factRes.ok) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'failed to purchase fact from S1' }));
        return;
      }
      const fact = await factRes.json();
      const factReceipt = JSON.parse(
        Buffer.from(factRes.headers.get('PAYMENT-RESPONSE'), 'base64').toString('utf8')
      );

      let answer;
      if (!apiKey) {
        answer = `[Deterministic local completion: XKIRO_API_KEY not set] Grounded live fact at epoch ${fact?.epoch ?? 'unknown'}: recommended fee is ${fact?.fee_estimate_sat ?? 1} sat/vB (min/avg/rec: ${fact?.min_fee_sat ?? 1}/${fact?.avg_fee_sat ?? 1}/${fact?.recommended_fee_sat ?? 1} sats). S2 bought this fact from S1 for 5 sats before answering.`;
      } else {
        try {
          const completion = await fetch(XKIRO_URL, {
            method: 'POST',
            signal: AbortSignal.timeout(8000),
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'User-Agent': BROWSER_UA,
            },
            body: JSON.stringify({
              model,
              max_tokens: 300,
              messages: [
                {
                  role: 'system',
                  content:
                    'You are a Tachi network analyst. Answer in under 80 words. Use only the paid live data provided.',
                },
                {
                  role: 'user',
                  content: `Question: ${body.question ?? ''}\nPaid live daemon data: ${JSON.stringify(fact)}`,
                },
              ],
            }),
          });
          const parsed = await completion.json().catch(() => ({}));
          const message = parsed?.choices?.[0]?.message ?? {};
          // Some models return reasoning first; fall back to it rather than show
          // nothing. The default demo model answers directly in `content`.
          answer =
            message.content ||
            message.reasoning_content ||
            `completion unavailable (${completion.status})`;
        } catch (err) {
          answer = `[Local fallback] Grounded in paid fact: recommended fee is ${fact?.fee_estimate_sat ?? 1} sat/vB at epoch ${fact?.epoch ?? 'unknown'}.`;
        }
      }

      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          answer,
          model: apiKey ? model : 'deterministic-local-fallback',
          paid_fact: fact,
          s1_payment: {
            what: 'buy the fact',
            amountSats: '5',
            tx: factReceipt.transaction,
          },
        })
      );
    },
  });
  const server = http.createServer((req, res) => handle(req, res));
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/s2/complete` })
    )
  );
}
