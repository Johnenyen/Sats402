// Pure tests: binding, verification, and the substitution defense.
// No network. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  NETWORK_TACHI_REGTEST,
  buildBoundMessage,
  formPayment,
  replayKey,
  verifyPayment,
  verifySettlement,
  ErrorCode,
} from '../dist/index.js';

const NOW = 1790000000;

function testKeypair() {
  const priv = new Uint8Array(32).map((_, i) => (i * 7 + 13) % 251); // deterministic test key
  const pub = schnorr.getPublicKey(priv);
  const xOnly = Buffer.from(pub).toString('hex');
  return {
    priv,
    xOnly,
    signer: {
      publicKey: pub,
      signSchnorr: (m) => schnorr.sign(m, priv),
    },
  };
}

const payer = testKeypair();
// Arbitrary valid x-only placeholder for pure binding tests (no chain truth).
const payeeXOnly = '11'.repeat(32);

function acceptedReq(overrides = {}) {
  return {
    scheme: 'exact',
    network: NETWORK_TACHI_REGTEST,
    amount: '50',
    asset: 'BTC',
    payTo: payeeXOnly,
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: 'tachi_tx', paymentFlow: 'upfront' },
    ...overrides,
  };
}

function form(overrides = {}) {
  return formPayment({
    accepted: acceptedReq(),
    resource: { url: 'https://s1.example.com/fee-estimate' },
    signer: payer.signer,
    from: payer.xOnly,
    settlement: { txHash: 'a'.repeat(64), state: 'committed' },
    nowSeconds: NOW,
    ...overrides,
  });
}

test('a formed payment passes verification', () => {
  const r = verifyPayment(form(), NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('bound message contains every challenge field and txHash', () => {
  const p = form();
  const msg = buildBoundMessage(
    p.accepted,
    p.payload.authorization,
    p.resource.url,
    p.payload.settlement.txHash
  );
  assert.ok(msg.startsWith('sats402-exact-tachi:v2'));
  assert.ok(msg.includes(`value:${p.accepted.amount}`));
  assert.ok(msg.includes(`to:${p.accepted.payTo}`));
  assert.ok(msg.includes(`network:${p.accepted.network}`));
  assert.ok(msg.includes(`resource:${p.resource.url}`));
  assert.ok(msg.includes(`nonce:${p.payload.authorization.nonce}`));
  assert.ok(msg.includes(`tx:${p.payload.settlement.txHash}`));
});

test('SUBSTITUTION: same signature, different txHash, must fail', () => {
  const p = form();
  p.payload.settlement.txHash = 'b'.repeat(64);
  const r = verifyPayment(p, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, ErrorCode.INVALID_SIGNATURE);
});

test('SUBSTITUTION: same signature, different amount, must fail', () => {
  const p = form();
  p.accepted.amount = '51';
  p.payload.authorization.value = '51'; // keep cross-fields consistent
  const r = verifyPayment(p, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, ErrorCode.INVALID_SIGNATURE);
});

test('SUBSTITUTION: same signature, different payee, must fail', () => {
  const p = form();
  const other = 'b'.repeat(64);
  p.accepted.payTo = other;
  p.payload.authorization.to = other;
  const r = verifyPayment(p, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, ErrorCode.INVALID_SIGNATURE);
});

test('SUBSTITUTION: same signature, different network, must fail', () => {
  const p = form();
  p.accepted.network = 'tachi:' + 'c'.repeat(32);
  const r = verifyPayment(p, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, ErrorCode.INVALID_SIGNATURE);
});

test('SUBSTITUTION: same signature, different resource, must fail', () => {
  const p = form();
  p.resource.url = 'https://attacker.example.com/other';
  const r = verifyPayment(p, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, ErrorCode.INVALID_SIGNATURE);
});

test('SUBSTITUTION: same signature, different nonce, must fail', () => {
  const p = form();
  p.payload.authorization.nonce = 'd'.repeat(64);
  const r = verifyPayment(p, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, ErrorCode.INVALID_SIGNATURE);
});

test('mismatched cross-fields are rejected before signature check', () => {
  const p = form();
  p.payload.authorization.value = '999';
  const r = verifyPayment(p, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, ErrorCode.AMOUNT_MISMATCH);
});

test('tampered signature bytes are rejected', () => {
  const p = form();
  const sig = p.payload.signature;
  p.payload.signature = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
  const r = verifyPayment(p, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, ErrorCode.INVALID_SIGNATURE);
});

test('expired validity window is rejected', () => {
  const p = form();
  const r = verifyPayment(p, Number(p.payload.authorization.validBefore) + 1);
  assert.equal(r.ok, false);
  assert.equal(r.error, ErrorCode.CHALLENGE_EXPIRED);
});

test('settlement verification is read-only and strict', () => {
  const p = form();
  const good = {
    hash: 'a'.repeat(64),
    state: 'committed',
    vin: [{ owner: payer.xOnly }],
    vout: [
      { owner: payeeXOnly, amount: '50' },
      { owner: payer.xOnly, amount: '10' },
    ],
  };
  assert.equal(verifySettlement(p, good).ok, true);

  const shortPaid = { ...good, vout: [{ owner: payeeXOnly, amount: '49' }] };
  assert.equal(verifySettlement(p, shortPaid).error, ErrorCode.SETTLEMENT_INSUFFICIENT);

  const wrongPayer = { ...good, vin: [{ owner: payeeXOnly }] };
  assert.equal(verifySettlement(p, wrongPayer).error, ErrorCode.INVALID_PAYMENT_PAYLOAD);

  assert.equal(verifySettlement(p, null).error, ErrorCode.SETTLEMENT_NOT_FOUND);

  // Loose input ownership rejection: payer contributed only 1 sat on a 50 sat payment
  const loosePayer = {
    ...good,
    vin: [
      { owner: payer.xOnly, amount: '1' },
      { owner: payeeXOnly, amount: '100' },
    ],
  };
  assert.equal(verifySettlement(p, loosePayer).error, ErrorCode.INVALID_PAYMENT_PAYLOAD);

  // Sufficient input ownership: payer contributed 50 sats
  const fundedPayer = {
    ...good,
    vin: [
      { owner: payer.xOnly, amount: '50' },
      { owner: payeeXOnly, amount: '50' },
    ],
  };
  assert.equal(verifySettlement(p, fundedPayer).ok, true);
});

test('replay key is network:txhash, lowercase, colon-joined', () => {
  assert.equal(
    replayKey('tachi:x', 'AB' + 'c'.repeat(62)),
    'tachi:x:' + 'ab' + 'c'.repeat(62)
  );
});
