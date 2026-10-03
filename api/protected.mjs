// Protected page example: the paywall protecting content, not just JSON.
//
// GET /api/protected
//   402 + PAYMENT-REQUIRED (5 sats) until paid; then an HTML market brief
//   built from live data. Same middleware as the JSON services, with a
//   renderer instead of a JSON serializer. Nothing is intercepted: the
//   service renders its own response after the payment clears.
import { dataFeedPaywall } from './_lib/services.mjs';

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

function renderBrief(data) {
  const rows = Object.entries(data)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td><code>${esc(v)}</code></td></tr>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Market brief — paid with sats · Sats402</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/assets/style.css" /></head><body>
<nav class="nav"><a class="brand" href="/">Sats402<span class="dot-accent">.</span></a>
<div class="links"><a href="/">Home</a><a href="/services">Services</a><a href="/demo">Demo</a><a href="/verify">Verify</a>
<a href="/docs">Docs</a>
<a class="btn-nav" href="https://github.com/Johnenyen/Sats402" target="_blank" rel="noopener">GitHub</a></div></nav>
<div class="wrap"><div class="frame">
<span class="eyebrow"><span class="dot"></span> Protected page example</span>
<h1>Market brief<span class="grad">, paid in sats.</span></h1>
<p class="lede">You paid 5 sats to read this page. The same paywall that guards
JSON endpoints guards rendered content: challenge, settlement, proof, page.</p>
<table><tbody>${rows}</tbody></table>
<div class="note">The payment for this page is a Tachi transaction you can
re-fetch. Verify it on the <a href="/verify">verify page</a>.</div>
</div>
<p class="foot">
Sats402 — SDK and protocol for x402 pay-per-request payments in native sats on Tachi.<br />
Every settlement is a tx id on Tachi: daemon-returned and re-fetchable.
</p>
</div></body></html>`;
}

export default dataFeedPaywall({
  service: 'Protected market brief page',
  description: 'A rendered HTML page of live Bitcoin market data, pay-per-view',
  priceSats: 5n,
  mimeType: 'text/html',
  mnemonicEnv: 'SATS402_DATA_MNEMONIC',
  defaultMnemonic:
    'legal winner thank year wave sausage worth useful legal winner thank yellow',
  render: renderBrief,
  fetchProduct: async () => {
    const price = await (
      await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true'
      )
    ).json();
    const fees = await (
      await fetch('https://mempool.space/api/v1/fees/recommended')
    ).json();
    return {
      asset: 'bitcoin',
      usd: price?.bitcoin?.usd ?? null,
      usd_24h_change_pct: price?.bitcoin?.usd_24h_change ?? null,
      fastest_fee_sat_vb: fees?.fastestFee ?? null,
      hour_fee_sat_vb: fees?.hourFee ?? null,
      source: 'CoinGecko + mempool.space public APIs',
      read_at: new Date().toISOString(),
    };
  },
});
