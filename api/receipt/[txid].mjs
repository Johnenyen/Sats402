import { verifyReceipt } from '@sats402/verify';

const DAEMON = process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com';

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');

  const raw = (req.query?.txid ?? '').toString();
  const txid = raw.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'txid must be 64 hex characters' }));
    return;
  }

  try {
    const amountParam = req.query?.amount ? req.query.amount.toString() : null;
    if (amountParam !== null && !/^[0-9]+$/.test(amountParam)) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'amount must be a decimal sat string' }));
      return;
    }
    const payee = req.query?.payee ? req.query.payee.toString() : undefined;
    const check = await verifyReceipt(
      DAEMON,
      txid,
      payee || amountParam
        ? { payee, amountSats: amountParam ? BigInt(amountParam) : undefined }
        : undefined
    );
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(check, null, 2));
    return;
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
    return;
  }
}
