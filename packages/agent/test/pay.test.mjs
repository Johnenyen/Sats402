import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveIdentity,
  NETWORK_TACHI_REGTEST,
  formPayment,
  verifyPayment,
} from '@sats402/core';
import { fetchSettlement, verifySettlement } from '@sats402/verify';
import {
  Sats402Agent,
  PolicyError,
  selectVtxos,
  markVtxoInFlight,
  releaseVtxo,
  clearInFlightVtxos,
  getInFlightVtxoIds,
  pay,
} from '../dist/index.js';

const DAEMON = 'https://rpc-regtest.tachibtc.com';
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PAYEE_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const payer = deriveIdentity(MNEMONIC, 'regtest', 0);
const payee = deriveIdentity(PAYEE_MNEMONIC, 'regtest', 0);

test('coin selection: smallest-sufficient VTXO is preferred', () => {
  clearInFlightVtxos();
  const vtxos = [
    { id: 'vtxo-large', amountSats: 100n },
    { id: 'vtxo-small', amountSats: 10n },
    { id: 'vtxo-medium', amountSats: 30n },
  ];

  // Need 25 sats: 30 sats is smallest sufficient (not 100, not 10)
  const result = selectVtxos(vtxos, 25n);
  assert.equal(result.picked.length, 1);
  assert.equal(result.picked[0].id, 'vtxo-medium');
  assert.equal(result.total, 30n);
});

test('coin selection: falls back to accumulation when no single VTXO suffices', () => {
  clearInFlightVtxos();
  const vtxos = [
    { id: 'vtxo-1', amountSats: 5n },
    { id: 'vtxo-2', amountSats: 10n },
    { id: 'vtxo-3', amountSats: 15n },
  ];

  // Need 22 sats: none of 5, 10, 15 suffices alone. Accumulates descending: 15 + 10 = 25
  const result = selectVtxos(vtxos, 22n);
  assert.equal(result.picked.length, 2);
  assert.equal(result.picked[0].id, 'vtxo-3');
  assert.equal(result.picked[1].id, 'vtxo-2');
  assert.equal(result.total, 25n);
});

test('coin selection: in-flight VTXOs are excluded from selection', () => {
  clearInFlightVtxos();
  const vtxos = [
    { id: 'vtxo-a', amountSats: 50n },
    { id: 'vtxo-b', amountSats: 100n },
  ];

  markVtxoInFlight('vtxo-a');
  assert.ok(getInFlightVtxoIds().has('vtxo-a'));

  // Need 30 sats: vtxo-a is in flight, so vtxo-b must be picked
  const result = selectVtxos(vtxos, 30n);
  assert.equal(result.picked.length, 1);
  assert.equal(result.picked[0].id, 'vtxo-b');
  assert.equal(result.total, 100n);

  releaseVtxo('vtxo-a');
  assert.ok(!getInFlightVtxoIds().has('vtxo-a'));
  clearInFlightVtxos();
});

test('coin selection: throws when total available funds are insufficient', () => {
  clearInFlightVtxos();
  const vtxos = [{ id: 'v1', amountSats: 10n }];
  assert.throws(
    () => selectVtxos(vtxos, 20n),
    /insufficient funds: have 10 sats, need 20/
  );
});

test('agent.pay: policy refusal fires on per-call cap violation without settling', async () => {
  const agent = new Sats402Agent({
    identity: payer,
    daemonUrl: DAEMON,
    network: NETWORK_TACHI_REGTEST,
    policy: {
      perCallCapSats: 20n,
      sessionBudgetSats: 100n,
      payeeAllowlist: [payee.xOnly],
    },
  });

  await assert.rejects(
    () => agent.pay({ payeeXOnly: payee.xOnly, amountSats: 25n }),
    (err) => err instanceof PolicyError && err.reason === 'per_call_cap'
  );
  assert.equal(agent.spentSats, 0n);
});

test('agent.pay: policy refusal fires on session budget violation', async () => {
  const agent = new Sats402Agent({
    identity: payer,
    daemonUrl: DAEMON,
    network: NETWORK_TACHI_REGTEST,
    policy: {
      perCallCapSats: 50n,
      sessionBudgetSats: 30n,
      payeeAllowlist: [payee.xOnly],
    },
  });

  await assert.rejects(
    () => agent.pay(payee.userAddress, 35n),
    (err) => err instanceof PolicyError && err.reason === 'session_budget'
  );
  assert.equal(agent.spentSats, 0n);
});

test('agent.pay: policy refusal fires when payee is not allowlisted', async () => {
  const agent = new Sats402Agent({
    identity: payer,
    daemonUrl: DAEMON,
    network: NETWORK_TACHI_REGTEST,
    policy: {
      perCallCapSats: 50n,
      sessionBudgetSats: 100n,
      payeeAllowlist: ['0'.repeat(64)],
    },
  });

  await assert.rejects(
    () => agent.pay({ payeeXOnly: payee.xOnly, amountSats: 10n }),
    (err) => err instanceof PolicyError && err.reason === 'payee_not_allowed'
  );
  assert.equal(agent.spentSats, 0n);
});

test('agent.pay: successful payment returns txHash and verifies read-only', async (t) => {
  try {
    const statusRes = await fetch(`${DAEMON}/tachi_status`, { signal: AbortSignal.timeout(3000) });
    if (!statusRes.ok) {
      t.skip('live Tachi daemon not responding');
      return;
    }
  } catch {
    t.skip('live Tachi daemon unreachable');
    return;
  }

  const agent = new Sats402Agent({
    identity: payer,
    daemonUrl: DAEMON,
    network: NETWORK_TACHI_REGTEST,
    policy: {
      perCallCapSats: 50n,
      sessionBudgetSats: 100n,
      payeeAllowlist: [payee.xOnly],
    },
  });

  // Execute live direct agent-to-agent payment (5 sats)
  const res = await agent.pay({
    recipientAddress: payee.userAddress,
    amountSats: 5n,
    memo: 'direct agent-to-agent settlement test',
  });

  assert.ok(res.txHash);
  assert.match(res.txHash, /^[0-9a-f]{64}$/);
  assert.equal(res.network, NETWORK_TACHI_REGTEST);
  assert.equal(res.receipt.success, true);
  assert.equal(res.receipt.transaction, res.txHash);
  assert.equal(res.receipt.payer, payer.xOnly);

  // Spent sats tracked (5 sats amount + 1 sat fee)
  assert.equal(agent.spentSats, 6n);

  // Independently verify read-only via @sats402/verify
  const tx = await fetchSettlement(DAEMON, res.txHash);
  assert.ok(tx, 'daemon must return transaction');
  assert.equal(tx.state, 'committed');

  const accepted = {
    scheme: 'exact',
    network: NETWORK_TACHI_REGTEST,
    amount: '5',
    asset: 'BTC',
    payTo: payee.xOnly,
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: 'tachi_tx', paymentFlow: 'upfront' },
  };
  const payload = formPayment({
    accepted,
    resource: { url: 'memo:direct agent-to-agent settlement test' },
    signer: payer.signer,
    from: payer.xOnly,
    settlement: { txHash: res.txHash, state: 'committed' },
  });
  const verified = verifySettlement(payload, tx);
  assert.equal(verified.ok, true, JSON.stringify(verified));
});
