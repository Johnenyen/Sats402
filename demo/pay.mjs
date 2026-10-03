#!/usr/bin/env node
// demo/pay.mjs — run the Sats402 agent from YOUR machine.
//
//   npm run demo:pay -- data       buy the BTC market price feed (5 sats)
//   npm run demo:pay -- fees       buy the Bitcoin fee ladder (5 sats)
//   npm run demo:pay -- network    buy Tachi network state (5 sats)
//   npm run demo:pay -- inference  buy a grounded answer (50 sats, chained)
//
// This is the same SDK the hosted demo uses: it receives the 402 challenge,
// checks the spending policy, settles with its own key (a real tachi_tx), and
// retries with the proof. Set SATS402_AGENT_MNEMONIC to use your own key.
import { Sats402Agent, getSpendableSats } from '@sats402/agent';
import { deriveIdentity, NETWORK_TACHI_REGTEST } from '@sats402/core';

const SELF = process.env.SATS402_PUBLIC_URL ?? 'https://sats402.vercel.app';
const DAEMON = process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com';
const MNEMONIC =
  process.env.SATS402_AGENT_MNEMONIC ??
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const TARGETS = {
  data: { url: `${SELF}/api/services/price`, price: 5n, post: false },
  fees: { url: `${SELF}/api/services/fees`, price: 5n, post: false },
  network: { url: `${SELF}/api/services/network`, price: 5n, post: false },
  inference: { url: `${SELF}/api/services/inference`, price: 50n, post: true },
};

const target = process.argv[2] ?? 'data';
const selected = TARGETS[target];
if (!selected) {
  console.error('usage: npm run demo:pay -- [data|fees|network|inference]');
  process.exit(2);
}

const identity = deriveIdentity(MNEMONIC, 'regtest', 0);
const agent = new Sats402Agent({
  identity,
  daemonUrl: DAEMON,
  network: NETWORK_TACHI_REGTEST,
  policy: {
    perCallCapSats: 60n,
    sessionBudgetSats: 400n,
    payeeAllowlist: [], // filled from the live challenge below
  },
});

console.log(`sats402 demo agent`);
console.log(`  key (x-only): ${identity.xOnly}`);
console.log(`  balance:      ${await getSpendableSats(identity, DAEMON)} sats`);
console.log(`  target:       ${target} -> ${selected.url}`);
console.log(`  price:        ${selected.price} sats`);
console.log('');

// 1. The unpaid call: see the challenge exactly as the service issues it.
const init = {
  method: selected.post ? 'POST' : 'GET',
  headers: selected.post ? { 'content-type': 'application/json' } : {},
  body: selected.post
    ? JSON.stringify({ question: 'What is the recommended fee on this Tachi network right now?' })
    : undefined,
};
const probe = await fetch(selected.url, init);
const challengeB64 = probe.headers.get('PAYMENT-REQUIRED');
const challenge = challengeB64
  ? JSON.parse(Buffer.from(challengeB64, 'base64').toString('utf8'))
  : null;
const req = challenge?.accepts?.[0];
console.log(`1. challenge:   ${probe.status}  price ${req?.amount} sats  payTo ${String(req?.payTo).slice(0, 12)}…`);

// 2. Policy and settlement: this machine signs and broadcasts its own tachi_tx.
agent.options.policy.payeeAllowlist.push(req.payTo);
console.log('2. paying:      policy ok -> settling with our own key...');
const paid = await agent.fetch(selected.url, init);
const receipt = paid.headers.get('PAYMENT-RESPONSE')
  ? JSON.parse(Buffer.from(paid.headers.get('PAYMENT-RESPONSE'), 'base64').toString('utf8'))
  : null;
console.log(`   settled:     ${receipt?.transaction}  (${agent.spentSats} sats left this session)`);

// 3. The product and the independent re-fetch.
const product = await paid.json();
console.log(`3. received:    ${JSON.stringify(product).slice(0, 160)}…`);
const record = await (await fetch(`${SELF}/receipt/${receipt.transaction}`)).json();
console.log('');
console.log(`re-fetch:       ${record.found ? record.state + ' · epoch ' + record.epoch : 'NOT FOUND'}`);
console.log(`verify:         npx sats402 verify ${receipt.transaction}`);
