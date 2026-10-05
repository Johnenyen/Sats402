// POST /api/verify-payment — verify an x402 payment payload live, read-only.
//
// Body: { "payload": <PaymentPayload> }
// Returns each check with pass/fail and the daemon record it was checked
// against. Holds no key, broadcasts nothing.
import {
  verifyPayment,
  verifySettlement,
  fetchSettlement,
  SettlementLookupError,
} from '@sats402/core/verify';
import { readJson } from './_lib/readjson.mjs';

export default async function handler(req, res) {
  try {
    res.setHeader('access-control-allow-origin', '*');
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'POST a PaymentPayload to verify' }));
      return;
    }

    const parsed = await readJson(req);
    const payload = parsed.payload ?? parsed;

    const checks = [];
    const local = verifyPayment(payload);
    checks.push({
      check: 'shape, binding, and signature',
      pass: local.ok,
      detail: local.ok ? 'BIP-340 signature covers the full challenge' : `${local.error}: ${local.detail ?? ''}`,
    });

    let record = null;
    try {
      record = await fetchSettlement(
        process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com',
        String(payload?.payload?.settlement?.txHash ?? '').toLowerCase()
      );
      checks.push({
        check: 'settlement re-fetches from the daemon',
        pass: !!record,
        detail: record ? `state ${record.state}, epoch ${record.epoch}` : 'no such transaction',
      });
      if (record) {
        const settled = verifySettlement(payload, record);
        checks.push({
          check: 'committed, payee amount, payer owns inputs',
          pass: settled.ok,
          detail: settled.ok ? 'daemon record matches the payment' : `${settled.error}: ${settled.detail ?? ''}`,
        });
      }
    } catch (err) {
      if (err instanceof SettlementLookupError) {
        checks.push({ check: 'settlement re-fetches from the daemon', pass: false, detail: 'daemon lookup unavailable, retry' });
      } else {
        throw err;
      }
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: checks.every((c) => c.pass), checks }, null, 2));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      })
    );
  }
}
