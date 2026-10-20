'use strict';

/**
 * Self-test corretor LanguageTool.
 * Uso: npm run selftest:languagetool
 *
 * Sobe servidor HTTP fake /v2/check + página local com campos
 * (textarea, text, contenteditable, password, OTP, cc-number).
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-lt-'));

const PAGE_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<title>MH LanguageTool Test</title>
<style>
body{font-family:sans-serif;padding:16px;}
label{display:block;margin:10px 0 4px;}
input,textarea,[contenteditable]{width:90%;padding:8px;font-size:16px;}
[contenteditable]{border:1px solid #888;min-height:48px;}
</style>
</head>
<body>
<h1>LanguageTool selftest</h1>
<label>textarea</label>
<textarea id="ta" rows="3"></textarea>
<label>input text</label>
<input id="in-text" type="text"/>
<label>contenteditable</label>
<div id="ce" contenteditable="true"></div>
<label>password</label>
<input id="in-pass" type="password" autocomplete="current-password"/>
<label>otp</label>
<input id="in-otp" type="text" autocomplete="one-time-code" inputmode="numeric" maxlength="6"/>
<label>cc</label>
<input id="in-cc" type="text" autocomplete="cc-number"/>
<script>
window.__ltPage = { ready: true };
</script>
</body>
</html>`;

/**
 * Fake LanguageTool /v2/check
 * @returns {Promise<{ server: import('http').Server, baseUrl: string, stats: object }>}
 */
function startFakeLtServer() {
  const stats = {
    requests: 0,
    texts: [],
    force429: false,
    lastStatus: 0,
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }
    if (u.pathname === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(stats));
      return;
    }
    if (u.pathname === '/force-429') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          stats.force429 = !!j.on;
        } catch {
          stats.force429 = true;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ force429: stats.force429 }));
      });
      return;
    }
    if (u.pathname === '/v2/check' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        stats.requests += 1;
        let text = '';
        try {
          const params = new URLSearchParams(body);
          text = params.get('text') || '';
        } catch {
          text = body;
        }
        stats.texts.push(text);
        if (stats.force429) {
          stats.lastStatus = 429;
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '1',
          });
          res.end(JSON.stringify({ error: 'Too Many Requests' }));
          return;
        }
        /** @type {object[]} */
        const matches = [];
        const needle = 'errod';
        let idx = text.indexOf(needle);
        while (idx >= 0) {
          matches.push({
            offset: idx,
            length: needle.length,
            message: 'Possível erro ortográfico.',
            shortMessage: 'Ortografia',
            replacements: [{ value: 'erro' }, { value: 'errado' }],
            context: { text: text.slice(Math.max(0, idx - 5), idx + needle.length + 5), offset: Math.min(5, idx), length: needle.length },
          });
          idx = text.indexOf(needle, idx + 1);
        }
        stats.lastStatus = 200;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            matches,
            language: { code: 'pt-BR', name: 'Portuguese (Brazil)' },
          })
        );
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        stats,
      });
    });
    server.on('error', reject);
  });
}

function runElectron(envExtra) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'languagetool',
      MULTIHEIZ_MENU_INTERCEPT: '1',
      MULTIHEIZ_UI_WIDTH: '1200',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
      ...envExtra,
    };
    console.log('\n=== selftest:languagetool ===');
    const child = spawn(electronBin, ['.'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (buf) => {
      const s = buf.toString();
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('languagetool selftest timed out'));
    }, 180000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`languagetool selftest exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:languagetool');
  console.log('userdata:', userdata);
  const fake = await startFakeLtServer();
  console.log('fake LT:', fake.baseUrl);
  try {
    await runElectron({
      MULTIHEIZ_LT_SERVER: fake.baseUrl,
      MULTIHEIZ_LT_PAGE_URL: fake.baseUrl + '/page',
      MULTIHEIZ_LT_STATS_URL: fake.baseUrl + '/stats',
      MULTIHEIZ_LT_FORCE429_URL: fake.baseUrl + '/force-429',
    });
    console.log('PASS: selftest:languagetool complete');
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  } finally {
    try {
      fake.server.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(userdata, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main();
