'use strict';

/**
 * Self-test módulo de IA experimental.
 * Uso: npm run selftest:ai
 *
 * Servidor HTTP local FAKE (OpenAI /v1/chat/completions + Gemini-like).
 * Página local com textarea / password / OTP / data-mh-no-ai.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-ai-'));

const PAGE_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<title>MH AI Test</title>
<style>
body{font-family:sans-serif;padding:16px;}
label{display:block;margin:10px 0 4px;}
input,textarea{width:90%;padding:8px;font-size:16px;}
</style>
</head>
<body>
<h1>AI selftest</h1>
<label>textarea</label>
<textarea id="ta" rows="3">texto original para melhorar</textarea>
<label>password</label>
<input id="in-pass" type="password" autocomplete="current-password" value="segredo"/>
<label>otp</label>
<input id="in-otp" type="text" autocomplete="one-time-code" inputmode="numeric" maxlength="6"/>
<label>no-ai</label>
<textarea id="ta-no" data-mh-no-ai rows="2">não enviar</textarea>
<script>window.__aiPage = { ready: true };</script>
</body>
</html>`;

/**
 * @returns {Promise<{ server: import('http').Server, baseUrl: string, stats: object }>}
 */
function startFakeAiServer() {
  const stats = {
    requests: 0,
    openai: 0,
    gemini: 0,
    lastAuth: '',
    lastBody: '',
    forceTimeout: false,
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
    if (u.pathname === '/force-timeout') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          stats.forceTimeout = !!j.on;
        } catch {
          stats.forceTimeout = true;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ forceTimeout: stats.forceTimeout }));
      });
      return;
    }

    const isOpenAi = u.pathname === '/v1/chat/completions';
    const isGemini =
      /\/v1beta\/models\/[^/]+:generateContent$/.test(u.pathname) ||
      u.pathname === '/gemini/generate';

    if ((isOpenAi || isGemini) && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        stats.requests += 1;
        stats.lastBody = body;
        stats.lastAuth = String(req.headers.authorization || req.headers['x-goog-api-key'] || '');
        if (isOpenAi) stats.openai += 1;
        if (isGemini) stats.gemini += 1;

        if (stats.forceTimeout) {
          // Atraso longo — o cliente deve abortar por timeout
          setTimeout(() => {
            try {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ choices: [{ message: { content: 'tarde demais' } }] }));
            } catch {
              /* ignore */
            }
          }, 60000);
          return;
        }

        let userText = '';
        try {
          const j = JSON.parse(body || '{}');
          if (isOpenAi) {
            const msgs = Array.isArray(j.messages) ? j.messages : [];
            const user = msgs.find((m) => m && m.role === 'user');
            userText = String((user && user.content) || '');
          } else {
            const parts =
              j.contents && j.contents[0] && j.contents[0].parts ? j.contents[0].parts : [];
            userText = parts.map((p) => String((p && p.text) || '')).join('');
          }
        } catch {
          userText = body;
        }

        const improved = String(userText || '').trim() + ' [melhorado]';
        if (isGemini) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: improved }] } }],
            })
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: improved } }],
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
      MULTIHEIZ_SELFTEST: 'ai',
      MULTIHEIZ_MENU_INTERCEPT: '1',
      MULTIHEIZ_UI_WIDTH: '1200',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
      ...envExtra,
    };
    console.log('\n=== selftest:ai ===');
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
      reject(new Error('ai selftest timed out'));
    }, 180000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`ai selftest exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:ai');
  console.log('userdata:', userdata);
  const fake = await startFakeAiServer();
  console.log('fake AI:', fake.baseUrl);
  try {
    await runElectron({
      MULTIHEIZ_AI_SERVER: fake.baseUrl,
      MULTIHEIZ_AI_PAGE_URL: fake.baseUrl + '/page',
      MULTIHEIZ_AI_STATS_URL: fake.baseUrl + '/stats',
      MULTIHEIZ_AI_TIMEOUT_URL: fake.baseUrl + '/force-timeout',
      MULTIHEIZ_AI_TEST_KEY: 'mh-selftest-secret-key-xyz',
    });
    console.log('PASS: selftest:ai complete');
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
