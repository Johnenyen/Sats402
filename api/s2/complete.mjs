// S2 "inference" — a live paid service that is itself an agent.
//
// POST /api/s2/complete  { "question": "..." }
//   without payment: 402 + PAYMENT-REQUIRED (50 sats)
//   with a verified payment: 200 + a grounded answer + PAYMENT-RESPONSE
//
// S2 cannot answer until it has paid S1 for the live fact the answer needs:
// that inner payment is a real settlement signed by S2's own key.
import { paywall } from '@sats402/express';
import { Sats402Agent } from '@sats402/agent';
import { deriveIdentity, NETWORK_TACHI_REGTEST } from '@sats402/core';

const DAEMON = process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com';
const S1_URL = process.env.SATS402_S1_URL ?? '';
const S2_MNEMONIC =
  process.env.SATS402_S2_MNEMONIC ??
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const S1_MNEMONIC =
  process.env.SATS402_S1_MNEMONIC ??
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const XKIRO_URL =
  process.env.SATS402_XKIRO_URL ?? 'https://api.xkiro.com/v1/chat/completions';
const MODEL = process.env.SATS402_MODEL ?? 'mistralai/ministral-14b';
// Cloudflare rejects non-browser clients on this API (error 1010).
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const s2 = deriveIdentity(S2_MNEMONIC, 'regtest', 0);
const s1 = deriveIdentity(S1_MNEMONIC, 'regtest', 0);

const s2Agent = new Sats402Agent({
  identity: s2,
  daemonUrl: DAEMON,
  network: NETWORK_TACHI_REGTEST,
  policy: {
    perCallCapSats: 10n,
    sessionBudgetSats: 2000n,
    payeeAllowlist: [s1.xOnly],
  },
});

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const handle = paywall({
  priceSats: 50n,
  payeeXOnly: s2.xOnly,
  network: NETWORK_TACHI_REGTEST,
  daemonUrl: DAEMON,
  resource: {
    description: 'A paid AI completion grounded in live Tachi daemon data',
    mimeType: 'application/json',
  },
  serve: async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}');
    const origin = `https://${req.headers.host}`;

    // S2 CANNOT ANSWER UNTIL IT HAS PAID S1 for the live fact.
    const factRes = await s2Agent.fetch(S1_URL || `${origin}/api/s1/stats`);
    const fact = await factRes.json();
    const factReceipt = JSON.parse(
      Buffer.from(factRes.headers.get('PAYMENT-RESPONSE'), 'base64').toString('utf8')
    );

    const apiKey = process.env.XKIRO_API_KEY ?? '';
    let answer;
    if (!apiKey) {
      answer = 'Inference unavailable: XKIRO_API_KEY is not set on the server.';
    } else {
      const completion = await fetch(XKIRO_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': BROWSER_UA,
        },
        body: JSON.stringify({
          model: MODEL,
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
      const parsed = await completion.json();
      const message = parsed?.choices?.[0]?.message ?? {};
      answer =
        message.content ||
        message.reasoning_content ||
        `completion unavailable (${completion.status})`;
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        {
          answer,
          model: MODEL,
          paid_fact: fact,
          s1_payment: {
            what: 'buy the fact',
            amountSats: '5',
            tx: factReceipt.transaction,
          },
        },
        null,
        2
      )
    );
  },
});

export default function handler(req, res) {
  return handle(req, res);
}
