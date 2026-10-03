// S1 "daemon stats" — a live paid service.
//
// GET /api/s1/stats
//   without payment: 402 + PAYMENT-REQUIRED (5 sats)
//   with a verified payment: 200 + live Tachi daemon data + PAYMENT-RESPONSE
//
// Holds no customer key. It only sells reads of live daemon state.
import { paywall } from '@sats402/express';
import { deriveIdentity, NETWORK_TACHI_REGTEST } from '@sats402/core';

const DAEMON = process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com';
const S1_MNEMONIC =
  process.env.SATS402_S1_MNEMONIC ??
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

const s1 = deriveIdentity(S1_MNEMONIC, 'regtest', 0);

async function readDaemon() {
  const fee = await (await fetch(`${DAEMON}/tachi_feeEstimate`)).json();
  const status = await (await fetch(`${DAEMON}/tachi_status`)).json();
  return {
    fee_estimate_sat: fee,
    epoch_height: status?.result?.sync_info?.latest_block_height ?? null,
    network: status?.result?.node_info?.network ?? null,
    read_at: new Date().toISOString(),
    source: 'live Tachi daemon read, no cache',
  };
}

const handle = paywall({
  priceSats: 5n,
  payeeXOnly: s1.xOnly,
  network: NETWORK_TACHI_REGTEST,
  daemonUrl: DAEMON,
  resource: {
    description: 'Live Tachi daemon data: fee estimate and epoch height',
    mimeType: 'application/json',
  },
  serve: async (req, res) => {
    const data = await readDaemon();
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(data, null, 2));
  },
});

export default function handler(req, res) {
  return handle(req, res);
}
