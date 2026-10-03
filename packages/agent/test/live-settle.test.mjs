// LIVE GATE (Phase 2): one freshly settled payment whose tx id re-fetches.
// Nothing mocked. Run: npm run test:live
//
// A 50-sat agent-to-agent payment between the two public BIP-39 test-vector
// identities, settled with @sats402/agent (the payer signs and broadcasts its
// own tachi_tx), then re-fetched and verified read-only with @sats402/core.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NETWORK_TACHI_REGTEST,
  deriveIdentity,
  formPayment,
  verifyPayment,
  fetchSettlement,
  verifySettlement,
} from '@sats402/core';
import { settleTransfer } from '../dist/index.js';

const DAEMON = 'https://rpc-regtest.tachibtc.com';
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PAYEE_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

test('LIVE: a settled agent payment re-fetches and verifies as x402 payment', async () => {
  const payer = deriveIdentity(MNEMONIC, 'regtest', 0);
  const payee = deriveIdentity(PAYEE_MNEMONIC, 'regtest', 0);

  // SETTLE: the agent signs and broadcasts its own tachi_tx (native sats).
  const settled = await settleTransfer({
    identity: payer,
    recipientAddress: payee.userAddress,
    amountSats: 50n,
    feeSats: 1n,
    daemonUrl: DAEMON,
  });
  assert.equal(settled.code, 0, 'ledger must apply the tx');
  assert.match(settled.txHash, /^[0-9a-f]{64}$/);

  // RE-FETCH: the tx id must resolve from the daemon with payee and amount.
  const tx = await fetchSettlement(DAEMON, settled.txHash);
  assert.ok(tx, 'daemon must return the settled transaction');
  assert.ok(tx.vout.some((o) => o.owner === payee.xOnly && BigInt(o.amount) === 50n));

  // VERIFY: as an x402 payment, read-only.
  const accepted = {
    scheme: 'exact',
    network: NETWORK_TACHI_REGTEST,
    amount: '50',
    asset: 'BTC',
    payTo: payee.xOnly,
    maxTimeoutSeconds: 3600,
    extra: { assetTransferMethod: 'tachi_tx', paymentFlow: 'upfront' },
  };
  const payload = formPayment({
    accepted,
    resource: { url: 'https://s2.example.com/completion' },
    signer: payer.signer,
    from: payer.xOnly,
    settlement: { txHash: settled.txHash, state: 'committed' },
  });
  const local = verifyPayment(payload);
  assert.equal(local.ok, true, JSON.stringify(local));
  const settledOk = verifySettlement(payload, tx);
  assert.equal(settledOk.ok, true, JSON.stringify(settledOk));

  console.log(JSON.stringify({
    gate: 'PASSED',
    txHash: settled.txHash,
    epoch: settled.epoch,
    code: settled.code,
    amountSats: '50',
    payer: payer.xOnly,
    payee: payee.xOnly,
    inputs: settled.inputs.map((i) => i.slice(0, 12)),
  }));
});
