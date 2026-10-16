// Shared request-body reader for Vercel Node functions.
//
// Vercel's runtime may pre-buffer the request into `req.body`, in which case
// listening to the stream hangs or yields nothing. Prefer `req.body`, fall
// back to the stream.
export function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body || '{}');
      } catch {
        return {};
      }
    }
    return typeof req.body === 'object' ? req.body : {};
  }
  return new Promise((resolve) => {
    let raw = '';
    let bytes = 0;
    const MAX_BYTES = 64 * 1024;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_BYTES) {
        resolve({ __error: 'payload too large' });
        req.destroy();
        return;
      }
      raw += c;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}
