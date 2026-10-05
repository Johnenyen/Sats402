// Service: grounded AI inference — the model an agent buys.
//
// POST /api/services/inference  { "question": "..." }
//   402 + PAYMENT-REQUIRED (50 sats) until paid; then a grounded answer.
//
// This service is itself an agent with its own key and spend policy: it
// cannot answer until it has bought the live network data the answer needs
// (from /api/services/network, 5 sats). Two purchase types, one request.
import { paywall } from '@sats402/express';
import { Sats402Agent, ensureFunded } from '@sats402/agent';
import { deriveIdentity, NETWORK_TACHI_REGTEST } from '@sats402/core';
import { readJson } from '../_lib/readjson.mjs';
import { withCors, getPublicBaseUrl, createReplayStore } from '../_lib/services.mjs';

const DAEMON = process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com';
const XKIRO_URL =
  process.env.SATS402_XKIRO_URL ?? 'https://api.xkiro.com/v1/chat/completions';
const MODEL = process.env.SATS402_MODEL ?? 'mistralai/ministral-14b';
// Cloudflare rejects non-browser clients on this API (error 1010).
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const inference = deriveIdentity(
  process.env.SATS402_INFERENCE_MNEMONIC ??
    'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  'regtest',
  0
);
const dataPayee = deriveIdentity(
  process.env.SATS402_DATA_MNEMONIC ??
    'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'regtest',
  0
);

// The service's own agent: its key, its policy, its payments. Created per
// request so one customer's spend never locks out the next.
function makeBuyer() {
  return new Sats402Agent({
    identity: inference,
    daemonUrl: DAEMON,
    network: NETWORK_TACHI_REGTEST,
    policy: {
      perCallCapSats: 10n,
      sessionBudgetSats: 100n,
      payeeAllowlist: [dataPayee.xOnly],
    },
  });
}

function b64(value) {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

const handle = paywall({
  priceSats: 50n,
  payeeXOnly: inference.xOnly,
  network: NETWORK_TACHI_REGTEST,
  daemonUrl: DAEMON,
  publicBaseUrl: (req) => getPublicBaseUrl(req),
  replay: createReplayStore('inference'),
  maxTimeoutSeconds: 120,
  resource: {
    description: 'A paid AI completion grounded in live Bitcoin and Tachi data',
    mimeType: 'application/json',
  },
  serve: async (req, res) => {
    const body = await readJson(req);
    // Bound the question: length cap and control characters stripped.
    const question = String(body.question ?? '')
      .slice(0, 2000)
      .replace(/[\u0000-\u001f]/g, ' ');

    // CANNOT ANSWER UNTIL IT HAS BOUGHT the live data the answer needs.
    // Best-effort pre-flight top-up: ensure inference service wallet is funded
    try {
      await ensureFunded(inference, DAEMON, 1000n, 10n);
    } catch (topUpErr) {
      console.warn('[inference] Pre-flight top-up failed or insufficient funds:', topUpErr?.message || topUpErr);
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          {
            error: 'wallet_funding_failed',
            message: `Inference service wallet funding failed: ${String(topUpErr instanceof Error ? topUpErr.message : topUpErr)}`,
          },
          null,
          2
        )
      );
      return;
    }

    const buyer = makeBuyer();
    const self = getPublicBaseUrl(req);
    const dataUrl = process.env.SATS402_DATA_URL ?? `${self}/api/services/network`;

    let paidData;
    let dataReceipt;
    try {
      const dataRes = await buyer.fetch(dataUrl);
      if (!dataRes.ok) {
        throw new Error(`grounding data purchase returned HTTP ${dataRes.status}`);
      }
      paidData = await dataRes.json();
      const dataReceiptRaw = dataRes.headers.get('PAYMENT-RESPONSE');
      dataReceipt = dataReceiptRaw ? b64(dataReceiptRaw) : null;
      if (!dataReceipt?.transaction || dataReceipt.transaction === 'n/a') {
        throw new Error('grounding data purchase produced no settlement transaction');
      }
    } catch (err) {
      // Fail closed: do NOT charge 50 sats and return 200 when grounding data buy fails.
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          {
            error: 'settlement_failed',
            message: `Grounding data could not be purchased: ${String(err instanceof Error ? err.message : err)}`,
          },
          null,
          2
        )
      );
      return;
    }

    const apiKey = process.env.XKIRO_API_KEY ?? '';
    let answer;
    if (!apiKey) {
      answer = 'Inference unavailable: XKIRO_API_KEY is not set on the server.';
    } else {
      try {
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
                  'You are a Bitcoin network analyst. Answer in under 80 words. Use only the paid live data provided.',
              },
              {
                role: 'user',
                content: `Question: ${question}\nPaid live data: ${JSON.stringify(paidData)}`,
              },
            ],
          }),
          signal: AbortSignal.timeout(8000),
        });
        const parsed = await completion.json().catch(() => ({}));
        const message = parsed?.choices?.[0]?.message ?? {};
        answer =
          message.content ||
          message.reasoning_content ||
          `completion unavailable (${completion.status})`;
      } catch (err) {
        answer = `completion unavailable: ${String(err instanceof Error ? err.message : err)}`;
      }
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        {
          answer,
          model: MODEL,
          paid_data: paidData,
          data_purchase: {
            what: 'buy the fact',
            amountSats: '5',
            tx: dataReceipt.transaction,
          },
        },
        null,
        2
      )
    );
  },
});

export default withCors(function handler(req, res) {
  return handle(req, res);
});
