# Scheme: `exact` on Tachi (`tachi`)

This is the network binding for the `exact` payment scheme when Tachi is the
settlement and verification substrate. The generic `exact` behavior is defined in
`scheme_exact.md`. This document defines the Tachi-specific payload shape,
validation semantics, and asset transfer method.

## Summary

This binding adapts the `exact` scheme to Tachi ledgers. The client pays per
request in native sats by signing and broadcasting its own `tachi_tx`. The server
or facilitator verifies by reading Tachi daemon state. No custodian sits in the
path and no facilitator ever holds a key.

## Scheme and Networks

The network identifier is a CAIP-2-style identifier in the `tachi` namespace:

```text
tachi:0f9188f13cb7b2c71f2a335e3a4fc328
```

The reference is the first 32 characters of the underlying Bitcoin network's
genesis block hash in lowercase hexadecimal, following the BIP-122 CAIP-2
reference convention used by `scheme_exact_lnbtc.md`. The value above is the
Bitcoin regtest genesis prefix, verified live from the Tachi regtest daemon on
2026-10-03 (`getblockhash 0` = `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`).

The `tachi` namespace and its reference convention are a proposal declared by
this binding. They are not an official CAIP namespace assignment.

Networks MUST match exactly. A request for one `tachi:` reference MUST NOT be
paid by a transaction on another. Implementations MUST reject a payload whose
network does not equal the validated `PaymentRequirements.network`.

The asset is bitcoin. Amounts are denominated in sats as described in
`Amounts`. Every verification step MUST reject decimal notation, exponent
notation, thousand separators, and any sign other than an implicit positive.

## Asset Transfer Method and Payment Flow

The scheme supports only the `tachi_tx` asset transfer method and the `upfront`
payment flow.

The client constructs, signs, and broadcasts a `tachi_tx` to the Tachi daemon
itself. The transfer completes before the server responds. Verification is
read-only observation of daemon state: existence, commitment state, payee, and
amount. The server MUST NOT move funds and MUST NOT hold keys. If a server takes
custody of payer funds to broadcast later, it is not a compliant implementation
of this scheme.

Because the client broadcasts its own transaction, the payment is both
client-submitted and client-prepaid: the settlement step in the flow is binding
read-only proof after the client has already broadcast, per the `exact` scheme's
settlement semantics for client-submitted proofs.

## Terminology and Adapter Requirements

- **daemon**: a Tachi node's JSON-RPC interface, e.g.
  `https://rpc-regtest.tachibtc.com`.
- **owner key**: the payer's or payee's 32-byte x-only public key identifying
  VTXO ownership on the Tachi ledger. Encoded as 64 lowercase hex characters.
- **VTXO**: a Tachi ledger output owned by an owner key, with an amount in sats.
- **`tachi_tx`**: a Tachi transaction moving VTXOs, signed by the owner keys of
  its inputs and broadcast to the daemon (`tachi_tx` method family).
- **adapter**: a service implementing the three HTTP headers of the `exact`
  scheme and this payload shape.

Payees are identified by their owner key in `payTo`, not by a BTC address.

## Amounts

`PaymentRequirements.amount` is a decimal string denominated in sats. Sats are
the atomic unit: no subdivision exists and no decimals are permitted. The string
MUST match `^[0-9]+$`, MUST NOT be empty, and MUST NOT have leading zeros unless
the value is exactly `"0"`. The signer's declared value MUST equal the accepted
requirement exactly; a larger payment does not substitute for the accepted
amount.

## `PaymentRequirements`

`PaymentRequirements` follows `scheme_exact.md` with these binding specifics:

| Field | Value |
|---|---|
| `scheme` | `exact` |
| `network` | `tachi:<32-char genesis prefix>` |
| `amount` | decimal sat string |
| `asset` | `BTC` |
| `payTo` | payee owner key, 64 lowercase hex |
| `maxTimeoutSeconds` | positive integer |
| `extra.assetTransferMethod` | `tachi_tx` |
| `extra.paymentFlow` | `upfront` |

## Request Binding

The client signature binds the complete accepted requirements, not a summary.
Substituting any requirement, including the network, amount, or payee, MUST
invalidate the signature.

The bound message is the ASCII string:

```text
sats402-exact-tachi:v1:nonce:<64 hex>:after:<unix>:before:<unix>:value:<sats>:to:<payee xonly>:network:<network>:resource:<url>
```

where `nonce` is 64 lowercase hex, `after` and `before` are Unix seconds, `value`
is the accepted `amount` string, `to` is the accepted `payTo`, `network` is the
accepted `network`, and `resource` is the requested resource URL. The signature
is a BIP-340 Schnorr signature over `SHA-256` of that message by the payer's
owner key.

### HTTP Profile (`http:1`)

Wire format is the three `exact` v2 headers only:

- `PAYMENT-REQUIRED` on the 402 response, carrying the challenge.
- `PAYMENT-SIGNATURE` on the paid retry, carrying the `PaymentPayload`.
- `PAYMENT-RESPONSE` on the successful 200 response, carrying the server's
  payment result.

This binding makes no claim that a stock EVM `@x402/fetch` client can pay it.
Spec compliance means client and server speak the v2 headers and this scheme
shape.

## `PaymentPayload`

```jsonc
{
  "x402Version": 2,
  "resource": "https://api.example.com/data",
  "accepted": { /* PaymentRequirements echoed verbatim */ },
  "payload": {
    "signature": "<128 hex>",       // BIP-340 over the bound message by from
    "authorization": {
      "from": "<payer xonly>",      // 64 lowercase hex
      "to": "<payee xonly>",        // equals accepted.payTo
      "value": "50",                // equals accepted.amount
      "validAfter": "1790000000",   // unix seconds, decimal string
      "validBefore": "1790003600",  // unix seconds, decimal string
      "nonce": "<64 hex>"           // 32 random bytes, lowercase hex
    },
    "settlement": {
      "txHash": "<64 hex>",         // the tachi_tx the client broadcast
      "state": "committed"          // daemon-returned state at verification
    }
  }
}
```

`accepted` MUST be byte-for-byte the requirements the server issued.
`authorization.to` and `authorization.value` MUST equal `accepted.payTo` and
`accepted.amount`. `signature` MUST verify under `authorization.from` over the
bound message derived from `accepted` and the authorization nonce and validity
window. The payload shape mirrors the `exact` scheme's payload (a top-level
`signature` beside `authorization`) with the Tachi-specific `settlement` proof.

## Request Binding Test Vectors

Concrete vectors are generated by the `@sats402/core` test suite from the exact
serialization above, and are published with the first release. This document
fixes the construction procedure; it publishes no hand-computed values.

## Client Payment Construction

1. Receive the 402 challenge and parse `PaymentRequirements`.
2. Build the authorization fields (`nonce`, validity window, `from`, `to`,
   `value`).
3. Sign the bound message with the payer's owner key.
4. Construct a `tachi_tx` spending the payer's VTXOs, paying `value` sats to the
   payee owner key, with change back to the payer; sign each input with the
   payer's owner key.
5. Broadcast via the daemon's `tachi_tx` method family and wait for the daemon to
   accept it.
6. Retry the request with `PAYMENT-SIGNATURE` carrying the payload above.

## Facilitator Validation

Validation is read-only and stateless except for the replay store.

1. Parse and shape-check the payload.
2. Verify the BIP-340 signature over the bound message under `authorization.from`.
3. Check `authorization.to` equals `accepted.payTo` and `authorization.value`
   equals `accepted.amount`.
4. Check `network` matches the offered network exactly.
5. Check the validity window covers now.
6. Read the daemon for `settlement.txHash`. The transaction MUST exist and its
   recorded outputs MUST include a VTXO of at least `value` sats owned by the
   payee. The payer in `authorization.from` MUST be the owner of the spent
   inputs the transaction consumed.
7. Consume the replay key (below) atomically. A repeated key is a rejection.

Receipts and CLI output MUST state the record is daemon-returned and re-fetchable
and MUST NOT claim more than the daemon proves.

### Paid-but-expired Policy

A transaction that settles is a payment even if the HTTP response is lost. On a
retry with the same `nonce`, the server SHOULD return the original successful
response without charging again, provided the replay key is the same.

## Settlement and Replay Protection

Settlement does not move funds in the facilitator step; the client moved the
funds when it broadcast. Verification is observation. Enforcing single-use
requires a restart-durable replay store. The canonical consumption key MUST be:

```text
network + ":" + tx_hash
```

`network` is the validated network identifier and `tx_hash` is the settlement
transaction hash as 64 lowercase hex, no prefix.

## Error Vocabulary

- `invalid_payment_requirements`
- `invalid_payment_payload`
- `invalid_signature`
- `network_mismatch`
- `amount_mismatch`
- `payee_mismatch`
- `settlement_not_found`
- `settlement_insufficient`
- `replay_detected`
- `challenge_expired`

## Security Considerations

### Mandatory Cryptographic Proof

A payload without a valid signature over the bound message is rejected before any
daemon read.

### Payment Substitution

The signature covers network, amount, payee, resource, nonce, and validity
window. A payment produced for one challenge cannot be presented as payment for
another. The substitution test case is part of the test suite.

### Receiver Key Isolation

The verifier, including `@sats402/verify`, holds no key and can only read daemon
state. That property is greppable: no module reachable from the verifier contains
a signing primitive.

### Network and Currency Confusion

Networks are compared as full CAIP-2 strings. Amounts are sat strings with a
fixed grammar. There is no unit conversion anywhere in the scheme.

### Durable Replay Protection

The replay store MUST survive restarts and the insert MUST be atomic with
acceptance.

### Payer Anonymity

Owner keys are public in transactions. Payment records are readable on the
ledger by anyone with daemon access. This scheme provides payer verification,
not payer anonymity.

## References

- `scheme_exact.md` — generic `exact` scheme (x402 v2)
- `scheme_exact_lnbtc.md` — Bitcoin Lightning binding (structural template)
- BIP-122 — URI scheme for blockchain references (CAIP-2 convention)
- BIP-340 — Schnorr signatures for secp256k1
