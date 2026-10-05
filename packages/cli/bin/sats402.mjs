#!/usr/bin/env node
// sats402 — the CLI for Sats402 settlements.
//
//   sats402 verify <txid> [--payee <xonly>] [--amount <sats>] [--daemon <url>]
//
// Read-only: checks a settlement against Tachi daemon state. It holds no key
// and broadcasts nothing. The record it prints is daemon-returned and
// re-fetchable: anyone can repeat this lookup.
import { verifyReceipt } from '@sats402/verify';

const [, , command, ...args] = process.argv;

function opt(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage() {
  console.log('usage: sats402 verify <txid> [--payee <xonly>] [--amount <sats>] [--daemon <url>]');
  process.exit(2);
}

if (command !== 'verify' || !args.find((a) => !a.startsWith('--'))) usage();

const txid = args.find((a) => !a.startsWith('--')).toLowerCase();
const daemonUrl = opt('daemon') ?? 'https://rpc-regtest.tachibtc.com';
const payee = opt('payee');
const amount = opt('amount');

const check = await verifyReceipt(
  daemonUrl,
  txid,
  payee || amount
    ? { payee, amountSats: amount ? BigInt(amount) : undefined }
    : undefined
);

if (!check.found) {
  console.log(`sats402: the daemon at ${daemonUrl} has no transaction ${txid}`);
  process.exit(1);
}

console.log(`settlement   ${check.txHash}`);
console.log(`state        ${check.state}   (daemon-returned)`);
console.log(`epoch        ${check.epoch ?? 'n/a'}`);
console.log('outputs');
for (const o of check.outputs) {
  console.log(`  ${o.owner}  ${o.amountSats} sats`);
}
console.log('spent inputs');
for (const owner of check.inputOwners) {
  console.log(`  ${owner}`);
}
for (const note of check.notes) {
  console.log(`note: ${note}`);
}
// A failed --amount / --payee assertion must be a non-zero exit so CI pipelines
// and scripts reading $? do not treat a failed check as success.
if (check.notes.some((n) => /NOT MET|not met/i.test(n))) {
  process.exit(1);
}
