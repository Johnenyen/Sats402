# Sats402

**SDK and protocol for x402 pay-per-request payments in native sats on Tachi.**

Sats402 enables autonomous AI agents to make high-frequency, low-value payments
using native sats on Tachi. An agent pays per request by signing and broadcasting
its own `tachi_tx`; the service verifies the payment by reading the Tachi daemon.
No custodian sits in the path.

Settlement is a Tachi transaction on `tachi-regtest-1`.

## What it delivers

- **SDK for agent-to-agent and agent-to-service payments** — `@sats402/agent` (the
  paying client), `@sats402/express` (paid services), `@sats402/verify` (a read-only
  verifier that holds no key).
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
   amount and payee match the challenge. The signature covers the full challenge,
   so a payment cannot be moved onto a different request.
4. The service responds `200` with the resource (`PAYMENT-RESPONSE`).

## Why Tachi

x402 is the HTTP 402 "Payment Required" pattern for pay-per-request and
machine-to-machine commerce. Sats402 is the layer that lets x402 clients and
services settle in native sats on Tachi, without bridges, wrapped assets, or
custodians. Built for high-velocity, verifiable, sovereign micropayments suitable
for AI agents and decentralized AI networks.

## Example app

One command runs the whole loop, live:

```
npm run cold-start
```

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
npx sats402 verify <txid>
```

Or paste a tx id on the receipt page (`GET /` on the receipt server), which
also exposes the same record as JSON at `GET /receipt/:txid`.

## Status

In development. Built for the Tachi hackathon bounty "x402 on Bitcoin".
