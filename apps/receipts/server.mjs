// The Sats402 receipt surface.
//
//   GET /                — paste a tx id, see the daemon record
//   GET /receipt/:txid   — the same record as JSON (?payee=&amount= to assert)
//
// Read-only: this server holds no key and broadcasts nothing. Every record it
// shows is daemon-returned and re-fetchable.
import http from 'node:http';
import { verifyReceipt } from '@sats402/verify';

const DAEMON = process.env.SATS402_DAEMON ?? 'https://rpc-regtest.tachibtc.com';
const PORT = Number(process.env.PORT ?? 8787);

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sats402 receipts</title>
<style>
  :root {
    --bg: #eceaf3;
    --card: #ffffff;
    --ink: #1c1b22;
    --muted: #6b6876;
    --accent: #4f46e5;
    --ok: #16a34a;
    --bad: #dc2626;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: var(--bg);
    color: var(--ink);
    font-family: "Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
    display: flex;
    justify-content: center;
    padding: 48px 20px;
  }
  .frame {
    background: var(--card);
    border-radius: 24px;
    box-shadow: 0 24px 60px rgba(28, 27, 34, 0.10);
    width: 100%;
    max-width: 720px;
    padding: 40px;
    height: fit-content;
  }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin: 0 0 28px; font-size: 14px; line-height: 1.6; }
  .row { display: flex; gap: 10px; }
  input {
    flex: 1;
    border: 1px solid #e4e1ee;
    border-radius: 14px;
    padding: 13px 16px;
    font-size: 14px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    outline: none;
    background: #faf9fd;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12); }
  button {
    border: 0;
    border-radius: 14px;
    padding: 13px 22px;
    background: var(--accent);
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { filter: brightness(1.06); }
  .hint { color: var(--muted); font-size: 12px; margin: 12px 2px 0; line-height: 1.7; }
  .result { margin-top: 28px; display: none; }
  .badge {
    display: inline-block;
    border-radius: 999px;
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 14px;
  }
  .ok { background: rgba(22, 163, 74, 0.12); color: var(--ok); }
  .bad { background: rgba(220, 38, 38, 0.10); color: var(--bad); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 9px 2px; border-bottom: 1px solid #f0eef7; vertical-align: top; }
  td:first-child { color: var(--muted); width: 120px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  .note { color: var(--muted); font-size: 12px; margin-top: 14px; line-height: 1.7; }
</style>
</head>
<body>
  <div class="frame">
    <h1>Sats402 receipts</h1>
    <p class="sub">
      Paste a settlement transaction id to see what the Tachi daemon records.
      The record is daemon-returned and re-fetchable: anyone can repeat this
      lookup with <code>npx sats402 verify &lt;txid&gt;</code>.
    </p>
    <div class="row">
      <input id="txid" placeholder="transaction id (64 hex)" spellcheck="false" />
      <button id="go">Look up</button>
    </div>
    <p class="hint">
      No keys, no wallet, no signing. This page only reads the daemon.
    </p>
    <div class="result" id="result">
      <span class="badge" id="badge"></span>
      <table id="table"></table>
      <p class="note" id="note"></p>
    </div>
  </div>
<script>
  const $ = (id) => document.getElementById(id);
  // Daemon-returned fields are untrusted until proven hex: escape before HTML.
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  async function lookUp() {
    const txid = $('txid').value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      $('result').style.display = 'block';
      $('badge').className = 'badge bad';
      $('badge').textContent = 'not a transaction id';
      $('table').innerHTML = '';
      $('note').textContent = 'A transaction id is 64 hex characters.';
      return;
    }
    const res = await fetch('/receipt/' + txid);
    const rec = await res.json();
    $('result').style.display = 'block';
    $('badge').className = 'badge ' + (rec.found ? 'ok' : 'bad');
    $('badge').textContent = rec.found ? esc(rec.state) : 'not found';
    const rows = [];
    rows.push(['tx', '<code>' + esc(rec.txHash) + '</code>']);
    if (rec.found) {
      rows.push(['epoch', esc(rec.epoch ?? 'n/a')]);
      for (const o of rec.outputs) {
        rows.push(['output', '<code>' + esc(o.owner) + '</code> &middot; ' + esc(o.amountSats) + ' sats']);
      }
      for (const owner of rec.inputOwners) {
        rows.push(['input owner', '<code>' + esc(owner) + '</code>']);
      }
    }
    $('table').innerHTML = rows.map(([k, v]) => '<tr><td>' + k + '</td><td>' + v + '</td></tr>').join('');
    $('note').textContent = rec.notes.join(' ');
  }
  $('go').addEventListener('click', lookUp);
  $('txid').addEventListener('keydown', (e) => { if (e.key === 'Enter') lookUp(); });
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  res.setHeader('access-control-allow-origin', '*');

  if (url.pathname === '/') {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
    return;
  }

  const match = url.pathname.match(/^\/receipt\/([0-9a-fA-F]{64})$/);
  if (match) {
    try {
      const amountParam = url.searchParams.get('amount');
      if (amountParam !== null && !/^[0-9]+$/.test(amountParam)) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'amount must be a decimal sat string' }));
        return;
      }
      const check = await verifyReceipt(
        DAEMON,
        match[1].toLowerCase(),
        url.searchParams.get('payee') || amountParam
          ? {
              payee: url.searchParams.get('payee') ?? undefined,
              amountSats: amountParam ? BigInt(amountParam) : undefined,
            }
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

  res.statusCode = 404;
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`sats402 receipts: http://localhost:${PORT}  (daemon: ${DAEMON})`);
});
