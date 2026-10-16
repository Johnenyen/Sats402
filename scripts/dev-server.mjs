import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(ROOT_DIR, '.env'))) {
  try {
    process.loadEnvFile(path.join(ROOT_DIR, '.env'));
  } catch {}
}
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// Stage the site first to ensure public/ is up to date
await import('./stage-site.mjs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
  const pathname = url.pathname;
  req.query = Object.fromEntries(url.searchParams.entries());

  // 1. Redirects matching vercel.json
  if (pathname === '/demo') {
    res.writeHead(302, { Location: '/services' });
    res.end();
    return;
  }
  if (pathname === '/receipts') {
    res.writeHead(302, { Location: '/verify' });
    res.end();
    return;
  }

  // 2. Receipt API route: /receipt/:txid or /api/receipt/:txid
  const receiptMatch = pathname.match(/^\/(?:api\/)?receipt\/([0-9a-fA-F]{64})$/);
  if (receiptMatch) {
    req.query.txid = receiptMatch[1];
    try {
      const mod = await import('../api/receipt/[txid].mjs');
      await mod.default(req, res);
      return;
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String(err) }));
      return;
    }
  }

  // 3. API routes under /api/
  if (pathname.startsWith('/api/')) {
    const apiRel = pathname.replace(/^\/api\//, '');
    const apiFile = path.join(ROOT_DIR, 'api', `${apiRel}.mjs`);
    if (fs.existsSync(apiFile)) {
      try {
        const mod = await import(`file://${apiFile}`);
        await mod.default(req, res);
        return;
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: String(err) }));
        return;
      }
    }
  }

  // 4. Static files and clean URLs in public/
  let filePath = path.join(PUBLIC_DIR, pathname);

  if (pathname === '/' || pathname === '') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else if (!fs.existsSync(filePath)) {
    // Clean URLs check (.html)
    if (fs.existsSync(`${filePath}.html`)) {
      filePath = `${filePath}.html`;
    }
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // 5. 404 fallback
  const notFoundPath = path.join(PUBLIC_DIR, '404.html');
  if (fs.existsSync(notFoundPath)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(notFoundPath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Sats402 local server running at http://localhost:${PORT}`);
});
