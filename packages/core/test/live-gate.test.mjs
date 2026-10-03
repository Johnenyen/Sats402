// LIVE GATE (Phase 1): a payment payload our client forms and our verifier
// accepts against the live Tachi regtest daemon, over a real settled
// transaction. Nothing mocked. Run: npm run test:live
//
// The settlement is the hard-gate transaction from Phase 0:
//   787c00ca82def1eb994e994884e7ce3f00fd8a3b32b830a4057336611e37ac4d
// It paid 200 sats to the payee below, signed by the payer key derived from the
// BIP-39 test vector mnemonic (standard public test fixture, not a secret).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NETWORK_TACHI_REGTEST,
  deriveIdentity,
  formPayment,
  verifyPayment,
  fetchSettlement,
  verifySettlement,
  replayKey,
  ErrorCode,
} from '../dist/index.js';

const DAEMON = 'https://rpc-regtest.tachibtc.com';
const TX_HASH = '787c00ca82def1eb994e994884e7ce3f00fd8a3b32b830a4057336611e37ac4d';
const PAYER_XONLY = 'e7ab2537b5d49e970309aae06e9e49f36ce1c9febbd44ec8e0d1cca0b4f9c319';
// BIP-39 test vector 1 (public standard fixture).
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// BIP-39 test vector 2 (public standard fixture): the payee identity.
const PAYEE_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

test('LIVE: formed payment verifies against the live daemon settlement', async () => {
  const identity = deriveIdentity(MNEMONIC, 'regtest', 0);
  assert.equal(identity.xOnly, PAYER_XONLY, 'derived payer key must own the settled inputs');
  const payee = deriveIdentity(PAYEE_MNEMONIC, 'regtest', 0);

  const accepted = {
    scheme: 'exact',
    network: NETWORK_TACHI_REGTEST,
    amount: '200',
    asset: 'BTC',
    payTo: payee.xOnly,
    maxTimeoutSeconds: 3600,
    extra: { assetTransferMethod: 'tachi_tx', paymentFlow: 'upfront' },
  };
  const payload = formPayment({
    accepted,
    resource: { url: 'https://s2.example.com/completion' },
    signer: identity.signer,
    from: identity.xOnly,
    settlement: { txHash: TX_HASH, state: 'committed' },
  });

  // 1. Local verification: shape, binding, BIP-340 signature.
  const local = verifyPayment(payload);
  assert.equal(local.ok, true, JSON.stringify(local));

  // 2. Read-only daemon read: the settlement must re-fetch.
  const tx = await fetchSettlement(DAEMON, TX_HASH);
  assert.ok(tx, 'daemon must return the settlement transaction');
  assert.equal(tx.state, 'committed');

  // The derived payee must be exactly what the settled tx paid: derivation and
  // daemon are independent sources and must agree (no hardcoded key here).
  assert.ok(tx.vout.some((o) => o.owner === payee.xOnly), 'settled tx must pay the derived payee key');

  // 3. Settlement verification: payee amount and payer ownership.
  const settled = verifySettlement(payload, tx);
  assert.equal(settled.ok, true, JSON.stringify(settled));

  console.log(JSON.stringify({
    gate: 'PASSED',
    txHash: TX_HASH,
    daemonState: tx.state,
    payee: payee.xOnly,
    paidToPayee: tx.vout.filter((o) => o.owner === payee.xOnly).reduce((s, o) => s + BigInt(o.amount), 0n).toString(),
    payerOwnsInputs: tx.vin.some((i) => i.owner === PAYER_XONLY),
    replayKey: replayKey(NETWORK_TACHI_REGTEST, TX_HASH),
  }));
});

test('LIVE: substitution of the accepted amount fails the signature', () => {
  const identity = deriveIdentity(MNEMONIC, 'regtest', 0);
  const payee = deriveIdentity(PAYEE_MNEMONIC, 'regtest', 0);
  const accepted = {
    scheme: 'exact',
    network: NETWORK_TACHI_REGTEST,
    amount: '200',
    asset: 'BTC',
    payTo: payee.xOnly,
    maxTimeoutSeconds: 3600,
  };
  const payload = formPayment({
    accepted,
    resource: { url: 'https://s2.example.com/completion' },
    signer: identity.signer,
    from: identity.xOnly,
    settlement: { txHash: TX_HASH, state: 'committed' },
  });

  // Attacker re-labels the payment as 201 sats, same signature.
  const forged = JSON.parse(JSON.stringify(payload));
  forged.accepted.amount = '201';
  forged.payload.authorization.value = '201';
  const r = verifyPayment(forged);
  assert.equal(r.ok, false);
  assert.equal(r.error, ErrorCode.INVALID_SIGNATURE);
  console.log(JSON.stringify({ substitution: 'REJECTED', error: r.error }));
});
