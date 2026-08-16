// Vercel serverless entry. Thin wrapper around the shared router so the
// deployed code path is identical to the one the tests exercise.
import { handle } from '../lib/router.js';

export default async function (req, res) {
  let body = req.body ?? {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;

  const out = await handle(
    { method: req.method, url: req.url, body, headers: req.headers },
    { baseUrl: `${proto}://${host}` }
  );

  for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json');
  res.status(out.status).send(JSON.stringify(out.body));
}
