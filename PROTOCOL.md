# Sats402 protocol

Sats402 implements the x402 pay-per-request pattern with settlement in native
sats on Tachi. This file is the protocol overview. The normative network binding
is [specs/schemes/exact/scheme_exact_tachi.md](specs/schemes/exact/scheme_exact_tachi.md).

## Wire format

Three x402 v2 headers, nothing more:

- `PAYMENT-REQUIRED` — returned on the `402` response, carrying the payment
  challenge (price in sats, payee, network, validity window).
- `PAYMENT-SIGNATURE` — sent on the paid retry, carrying the payment payload and
  the proof of settlement.
- `PAYMENT-RESPONSE` — returned on the successful `200` response.

## Payment scheme

x402 payments are made in a defined scheme. Sats402 uses the `exact` scheme with
a Tachi network binding, written from the x402 scheme template specification.

- **Network identifiers** — CAIP-2-style in the `tachi` namespace, reference taken
  from the underlying Bitcoin network's genesis prefix (BIP-122 convention). The
  namespace is a proposal declared by this binding.
- **Amounts** — sat strings, atomic units, exact match required.
- **Payee** — the payee's x-only owner key on the Tachi ledger.

## Settlement

The client settles: it signs and broadcasts its own `tachi_tx`, paying the exact
requested amount to the payee's owner key. The service verifies by reading the
daemon: the transaction exists and the amount and payee match the challenge. The
service holds no key and moves no funds.

The signature covers the complete challenge and settlement: network, amount, payee,
resource, nonce, validity window, and settlement transaction hash. A payment made
for one request cannot be presented for another.

## Replay protection

Each settlement is consumed once, keyed by `network + ":" + tx_hash`.
Replay protection is in-process memory by default; durable across restarts only when configured with a persistent KV/Redis store (`KV_REST_API_URL` or `UPSTASH_REDIS_REST_URL`). A settlement is never charged twice: verified requests with an existing settlement return the original cached response while in cache, and unverified or reused proofs are rejected.
