// Servidor estático mínimo para probar Free Player en local.
// Además expone /__log para que la página enviarme errores y estado (diagnóstico).
// Uso: node server.mjs [puerto]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 8087;
const LOG = path.join(root, 'test-log.ndjson');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json',
};

http
  .createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();

    // --- Diagnóstico ---
    if (req.url === '/__log' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          fs.appendFileSync(LOG, body + '\n');
        } catch (e) {
          console.log('log write error', e.message);
        }
        console.log('LOG>>', body.slice(0, 1200));
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end('{"ok":1}');
      });
      return;
    }
    if (req.url === '/__log' && req.method === 'GET') {
      const data = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
      res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' }).end(data);
      return;
    }
    if (req.url === '/__log/clear') {
      if (fs.existsSync(LOG)) fs.writeFileSync(LOG, '');
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end('{"ok":1}');
      return;
    }

    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('403');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 Not Found');
        return;
      }
      res.writeHead(200, {
        ...cors,
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        // siempre versión fresca: evita sirvea JS/CSS antiguos tras una edición
        'Cache-Control': 'no-store, max-age=0',
      });
      res.end(data);
    });
  })
  .listen(port, () => console.log(`Free Player en http://localhost:${port}`));
