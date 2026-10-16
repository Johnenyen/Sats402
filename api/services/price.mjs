// Service: BTC market price feed — what agents actually buy.
//
// GET /api/services/price
//   402 + PAYMENT-REQUIRED (5 sats) until paid; then live BTC price data.
//
// Upstream: CoinGecko public API (no key). Read at request time.
import { dataFeedPaywall } from '../_lib/services.mjs';

const handle = dataFeedPaywall({
  service: 'BTC market price feed',
  description: 'Live BTC price in USD with 24h change',
  priceSats: 5n,
  mnemonicEnv: 'SATS402_DATA_MNEMONIC',
  defaultMnemonic:
    'legal winner thank year wave sausage worth useful legal winner thank yellow',
  fetchProduct: async () => {
    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
        {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
      const data = await res.json();
      return {
        asset: 'bitcoin',
        usd: data?.bitcoin?.usd ?? null,
        usd_24h_change_pct: data?.bitcoin?.usd_24h_change ?? null,
        source: 'CoinGecko public API',
        read_at: new Date().toISOString(),
      };
    } catch (err) {
      return {
        asset: 'bitcoin',
        usd: null,
        usd_24h_change_pct: null,
        source: 'CoinGecko public API (degraded)',
        error: String(err instanceof Error ? err.message : err),
        read_at: new Date().toISOString(),
      };
    }
  },
});

export default function handler(req, res) {
  return handle(req, res);
}
