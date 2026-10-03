// Service: Tachi network state — settlement-layer data an agent needs.
//
// GET /api/services/network
//   402 + PAYMENT-REQUIRED (5 sats) until paid; then live Tachi daemon state.
//
// Upstream: the Tachi regtest daemon itself (no cache).
import { dataFeedPaywall } from '../_lib/services.mjs';

const DAEMON = process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com';

const handle = dataFeedPaywall({
  service: 'Tachi network state',
  description: 'Live Tachi settlement-layer state: ledger fee, epoch height, network',
  priceSats: 5n,
  mnemonicEnv: 'SATS402_DATA_MNEMONIC',
  defaultMnemonic:
    'legal winner thank year wave sausage worth useful legal winner thank yellow',
  fetchProduct: async () => {
    const fee = await (await fetch(`${DAEMON}/tachi_feeEstimate`)).json();
    const status = await (await fetch(`${DAEMON}/tachi_status`)).json();
    return {
      ledger_fee_sat: fee,
      epoch_height: status?.result?.sync_info?.latest_block_height ?? null,
      network: status?.result?.node_info?.network ?? null,
      source: 'live Tachi daemon read, no cache',
      read_at: new Date().toISOString(),
    };
  },
});

export default function handler(req, res) {
  return handle(req, res);
}
