#!/usr/bin/env node
// sats402-verify <txHash> [--payee <xonly>] [--amount <sats>]
//   [--daemon <url>]
//
// Read-only: checks a settlement against Tachi daemon state. No keys, no
// broadcast. Prints the daemon-returned record.
import { verifyReceipt } from '../dist/index.js';

const args = process.argv.slice(2);
const txHash = args.find((a) => !a.startsWith('--'));
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!txHash) {
  console.error('usage: sats402-verify <txHash> [--payee <xonly>] [--amount <sats>] [--daemon <url>]');
  process.exit(2);
}

const daemonUrl = opt('daemon') ?? 'https://rpc-regtest.tachibtc.com';
const payee = opt('payee');
const amount = opt('amount');

const check = await verifyReceipt(
  daemonUrl,
  txHash.toLowerCase(),
  payee || amount ? { payee, amountSats: amount ? BigInt(amount) : undefined } : undefined
);

console.log(JSON.stringify(check, null, 2));
process.exit(check.found ? 0 : 1);
