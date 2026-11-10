// Boomboats Node server: serves the web client and runs multiplayer rooms over WebSockets.
// The game itself lives in game.js (shared with the Cloudflare version in worker/).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createGame, TICK_RATE } from './game.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.svg': 'image/svg+xml', '.txt': 'text/plain',
  '.ico': 'image/x-icon', '.webp': 'image/webp',
};

function serveFile(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': rel.startsWith('/models') || rel.startsWith('/fx') || rel.startsWith('/audio') ? 'public, max-age=3600' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url === '/api/e') { req.resume(); res.writeHead(204); return res.end(); } // analytics only run on Cloudflare
  if (url.startsWith('/admin/api/')) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"Analytics only run on the Cloudflare version"}'); }
  if (url.startsWith('/vendor/three/')) return serveFile(res, THREE_DIR, url.slice('/vendor/three'.length));
  serveFile(res, PUBLIC, url === '/' ? '/index.html' : url);
});

// ---------------------------------------------------------------- game
const game = createGame({
  matchSeconds: process.env.BB_MATCH_SECONDS, // shorter matches for testing
  debug: !!process.env.BB_DEBUG, // lets a client ask for any weapon
  log: console.log,
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  const conn = game.connect({ send: (s) => ws.send(s), open: () => ws.readyState === 1 });
  ws.on('message', (raw) => conn.message(raw.toString()));
  ws.on('close', () => conn.close());
});

setInterval(game.tick, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Boomboats server running at http://localhost:${PORT}`);
});
