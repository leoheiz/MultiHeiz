'use strict';

/**
 * Tiny local mock of GitHub releases/latest + asset downloads.
 * Usage:
 *   node tools/mock-github-release-server.js --port 18123 --root <dir> --latest <jsonfile>
 *   Optional: --bad-latest <jsonfile> served at /releases/latest-bad
 * Prints: MOCK_READY port=<n>
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

const port = Number(arg('port', '0')) || 0;
const root = path.resolve(arg('root', '.'));
const latestPath = path.resolve(arg('latest', path.join(root, 'latest.json')));
const badLatestPath = arg('bad-latest', '')
  ? path.resolve(arg('bad-latest', ''))
  : '';

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  let file = null;
  let type = 'application/octet-stream';
  if (url.pathname === '/releases/latest' || url.pathname === '/repos/leoheiz/MultiHeiz/releases/latest') {
    file = latestPath;
    type = 'application/json; charset=utf-8';
  } else if (url.pathname === '/releases/latest-bad' && badLatestPath) {
    file = badLatestPath;
    type = 'application/json; charset=utf-8';
  } else if (url.pathname.startsWith('/assets/')) {
    file = path.join(root, url.pathname.replace(/^\//, '').replace(/\//g, path.sep));
  }
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const data = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
  res.end(data);
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  const p = typeof addr === 'object' && addr ? addr.port : port;
  console.log('MOCK_READY port=' + p);
});

function shutdown() {
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
