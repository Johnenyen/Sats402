# Sats402

**SDK and protocol for x402 pay-per-request payments in native sats on Tachi.**

Sats402 enables autonomous AI agents to make low-value, pay-per-request payments
using native sats on Tachi. An agent pays per request by signing and broadcasting
its own `tachi_tx`; the service verifies the payment by reading the Tachi daemon.
No custodian sits in the path.

Settlement is a Tachi transaction on `tachi-regtest-1`.

## What it delivers

- **SDK for agent-to-service and agent-to-agent settlement** — the SDK exposes
  an agent fetch client (`@sats402/agent`, with spending policies and 402 challenge
  negotiation) and a custody-free paywall middleware (`@sats402/express`). The
  agent-to-agent case is two independent key-holders, each signing and broadcasting
  their own `tachi_tx`, where one agent settles on-chain to pay the other.
- **Support for the x402 / pay-per-request pattern** — the three x402 v2 headers
  (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`) and the network
  binding for the `exact` scheme. See [PROTOCOL.md](PROTOCOL.md).
- **Native sats settlement on Tachi** — the agent signs and broadcasts its own
  `tachi_tx`. Every payment re-fetches from the daemon and verifies independently.
- **Example app** — one command: an agent pays for a live answer and for the data
  read the answer depends on, with a burst of paid calls and a clean rejection.

## How a payment works

1. The agent requests a resource. The service answers `402` with a price in sats
   and a payment challenge (`PAYMENT-REQUIRED`).
2. The agent checks the price against its own spending policy, signs and broadcasts
   a `tachi_tx` for the exact amount, and retries the request with the payment proof
   (`PAYMENT-SIGNATURE`).
3. The service verifies by reading the daemon: the transaction exists, and the
   amount and payee match the challenge. The signature covers the full challenge
   and settlement transaction hash, so a payment cannot be moved onto a different request.
4. The service responds `200` with the resource (`PAYMENT-RESPONSE`).

## Direct agent-to-agent payment: `agent.pay`

For direct agent-to-agent settlement where one key-holder pays another without an HTTP 402 challenge loop:

```typescript
import { Sats402Agent } from '@sats402/agent';
import { deriveIdentity } from '@sats402/core';

const agent = new Sats402Agent({
  identity: deriveIdentity(MNEMONIC, 'regtest', 0),
  daemonUrl: 'https://rpc-regtest.tachibtc.com',
  network: 'tachi:0f9188f13cb7b2c71f2a335e3a4fc328',
  policy: { perCallCapSats: 60n, sessionBudgetSats: 400n, payeeAllowlist: [payeeXOnly] },
});

// Direct agent-to-agent settlement: one key-holder paying another, verified read-only
const { txHash, receipt } = await agent.pay({
  payeeXOnly,
  amountSats: 50n,
  memo: 'agent task completion',
});
```

`agent.pay` enforces the same spend-policy checks as `fetch` (per-call cap, session budget, payee allowlist), settles native sats via `settleTransfer` (smallest-sufficient coin selection), and verifies the settlement read-only via `@sats402/verify`.

## Why Tachi

x402 is the HTTP 402 "Payment Required" pattern for pay-per-request and
machine-to-machine commerce. Sats402 is the layer that lets x402 clients and
services settle in native sats on Tachi, without bridges, wrapped assets, or
custodians. Measured at 20/20 settled transactions in burst runs (5,492 ms p50 latency
end-to-end), with verifiable and sovereign micropayments for autonomous AI agents.

Replay protection is in-process memory by default; durable across restarts only
when configured with a persistent KV/Redis store (`KV_REST_API_URL` or
`UPSTASH_REDIS_REST_URL`).

## Quickstart & Example app

Install dependencies and build:

```bash
npm install
npm run build
```

Run the test suite:

```bash
npm test
```

Run the complete example app live:

```bash
npm run cold-start
```

Requirements, stated plainly: a reachable Tachi regtest daemon
(`SATS402_DAEMON`, default `https://rpc-regtest.tachibtc.com`). If demo keys
fall below 1,000 sats, pre-flight auto-tops up from the live Tachi faucet.
An optional `XKIRO_API_KEY` can be provided for cloud inference; if absent,
S2 degrades gracefully to a deterministic local completion grounded in live data,
so all settlements (S1 buy, S2 buy, burst) always execute on-chain.

An agent asks a question and pays for the answer in native sats on Tachi. The
service cannot answer until it has paid for the live daemon data the answer
needs: two purchases, one run, receipts for both. Then a burst of twenty paid
calls with measured latency, and two clean failures (a wrong-amount payment
rejected with no second charge, an over-budget call refused locally with no
transaction).

The two paid services are plain HTTP servers behind the same paywall:
S1 sells live daemon data (5 sats per call), S2 sells a completion (50 sats per
call) and is itself an agent with its own key, spending policy, and payments.

## Verify a settlement

Anyone can verify a settlement with one command. It is read-only: no keys, no
wallet, no signing. The record is daemon-returned and re-fetchable.

```
node packages/cli/bin/sats402.mjs verify <txid>
```

The runnable CLI command is `node packages/cli/bin/sats402.mjs verify <txid>`.
Alternatively, run `npm run verify -- <txid>`.

Or paste a tx id on the receipt page (`GET /verify?tx=<txid>` or web UI), which
also exposes the same record as JSON at `GET /receipt/:txid`.

## Status

In development. Built for the Tachi hackathon bounty "x402 on Bitcoin".
