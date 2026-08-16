// Local dev server. Vercel uses api/index.js; both call the same handler.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { handle } from './lib/router.js';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api')) {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const out = await handle(
      { method: req.method, url: req.url, body, headers: req.headers },
      { baseUrl: `http://${req.headers.host}` }
    );
    res.writeHead(out.status, { 'Content-Type': 'application/json', ...out.headers });
    return res.end(JSON.stringify(out.body));
  }

  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const buf = await readFile(join(root, 'public', file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    const buf = await readFile(join(root, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  }
}).listen(PORT, () => console.log(`Chalk Line running on http://localhost:${PORT}`));
