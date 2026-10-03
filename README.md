# Sats402

x402 scheme, settlement is a Tachi tx on tachi-regtest-1.

Sats402 is the `exact` payment scheme for Tachi. Autonomous AI agents pay per
request in native sats: the agent signs and broadcasts its own `tachi_tx`, and the
server verifies by reading the daemon. No custodian sits in the path.

Status: in development. Documentation and the demo command land with the first
working release.
