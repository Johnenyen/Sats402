// Service: Bitcoin fee estimates — what agents actually buy.
//
// GET /api/services/fees
//   402 + PAYMENT-REQUIRED (5 sats) until paid; then the live fee ladder.
//
// Upstream: mempool.space public API (no key).
import { dataFeedPaywall } from '../_lib/services.mjs';

const handle = dataFeedPaywall({
  service: 'Bitcoin fee estimates',
  description: 'Live next-block fee ladder (fastest / half-hour / hour / economy)',
  priceSats: 5n,
  mnemonicEnv: 'SATS402_DATA_MNEMONIC',
  defaultMnemonic:
    'legal winner thank year wave sausage worth useful legal winner thank yellow',
  fetchProduct: async () => {
    try {
      const res = await fetch('https://mempool.space/api/v1/fees/recommended', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`mempool.space HTTP ${res.status}`);
      const fees = await res.json();
      return {
        unit: 'sat/vB',
        fastest: fees?.fastestFee ?? null,
        half_hour: fees?.halfHourFee ?? null,
        hour: fees?.hourFee ?? null,
        economy: fees?.economyFee ?? null,
        minimum: fees?.minimumFee ?? null,
        source: 'mempool.space public API',
        read_at: new Date().toISOString(),
      };
    } catch (err) {
      return {
        unit: 'sat/vB',
        fastest: null,
        half_hour: null,
        hour: null,
        economy: null,
        minimum: null,
        source: 'mempool.space public API (degraded)',
        error: String(err instanceof Error ? err.message : err),
        read_at: new Date().toISOString(),
      };
    }
  },
});

export default function handler(req, res) {
  return handle(req, res);
}
