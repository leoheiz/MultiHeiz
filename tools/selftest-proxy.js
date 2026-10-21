'use strict';

/**
 * Self-test proxy por janela.
 * Uso: npm run selftest:proxy
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

const root = path.join(__dirname, '..');
const electronBin = require('electron');

function assert(cond, msg) {
  if (!cond) {
    console.log('FAIL:', msg);
    process.exit(1);
  }
}

function runNodeChecks() {
  console.log('MultiHeiz selftest:proxy (node validation)');
  // Stub electron mínimo para carregar proxy.js fora do Electron
  const Module = require('node:module');
  const electronPath = require.resolve('electron');
  const stub = {
    session: { fromPartition: () => ({ setProxy: async () => {}, fetch: async () => {} }) },
    safeStorage: {
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => 'basic_text',
      encryptString: () => Buffer.from('x'),
      decryptString: () => '',
    },
    app: { on() {}, getPath: () => os.tmpdir() },
  };
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: stub,
  };
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'electron') return electronPath;
    return orig.call(this, request, parent, isMain, options);
  };

  for (const key of Object.keys(require.cache)) {
    if (/proxy\.js$/.test(key.replace(/\\/g, '/'))) delete require.cache[key];
  }
  const proxy = require('../src/main/proxy');

  assert(proxy.validateProxyInput({ type: 'http', host: '127.0.0.1', port: 8080 }).ok, 'valid http');
  assert(!proxy.validateProxyInput({ type: 'ftp', host: 'x', port: 1 }).ok, 'bad type');
  assert(!proxy.validateProxyInput({ type: 'http', host: 'http://x', port: 80 }).ok, 'scheme in host');
  assert(!proxy.validateProxyInput({ type: 'http', host: 'a b', port: 80 }).ok, 'space in host');
  assert(!proxy.validateProxyInput({ type: 'http', host: 'x', port: 0 }).ok, 'port 0');
  assert(!proxy.validateProxyInput({ type: 'http', host: 'x', port: 70000 }).ok, 'port high');
  assert(proxy.buildProxyRules({ type: 'socks5', host: '10.0.0.1', port: 1080 }) === 'socks5://10.0.0.1:1080', 'socks5 rules');
  assert(proxy.buildProxyRules({ type: 'none' }) == null, 'none rules');
  const pub = proxy.publicProxyView({
    type: 'http',
    host: 'h',
    port: 1,
    passwordEnc: 'abc',
  });
  assert(pub.passwordSaved === true && !pub.passwordEnc, 'public view');
  console.log('PASS: node proxy validation');
}

/**
 * Eco HTTP: responde JSON com marker conforme veio pelo proxy (X-MH-Proxy) ou direto.
 */
function startEchoServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const viaProxy = String(req.headers['x-mh-proxy'] || '') === '1';
      const body = JSON.stringify({
        ip: viaProxy ? 'via-proxy' : 'no-proxy',
        marker: viaProxy ? 'proxy-ok' : 'direct-ok',
        path: req.url,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
    server.on('error', reject);
  });
}

/**
 * Proxy HTTP mínimo: absolute-form + CONNECT; Basic auth opcional; conta hits.
 * @param {{ user: string, pass: string, hitsFile: string }} opts
 */
function startHttpProxy(opts) {
  const { user, pass, hitsFile } = opts;
  let hits = 0;
  const writeHits = () => {
    try {
      fs.writeFileSync(hitsFile, String(hits), 'utf8');
    } catch {
      /* ignore */
    }
  };
  writeHits();

  function unauthorized(res) {
    res.writeHead(407, {
      'Proxy-Authenticate': 'Basic realm="MultiHeizSelftest"',
      'Content-Type': 'text/plain',
    });
    res.end('proxy auth required');
  }

  function checkAuth(req) {
    const h = req.headers['proxy-authorization'] || '';
    if (!h.startsWith('Basic ')) return false;
    try {
      const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const u = idx >= 0 ? decoded.slice(0, idx) : decoded;
      const p = idx >= 0 ? decoded.slice(idx + 1) : '';
      return u === user && p === pass;
    } catch {
      return false;
    }
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!checkAuth(req)) {
        unauthorized(res);
        return;
      }
      hits += 1;
      writeHits();
      let target;
      try {
        target = new URL(req.url);
      } catch {
        res.writeHead(400);
        res.end('bad url');
        return;
      }
      const headers = { ...req.headers };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      headers['x-mh-proxy'] = '1';
      const preq = http.request(
        {
          hostname: target.hostname,
          port: target.port || 80,
          path: target.pathname + target.search,
          method: req.method,
          headers,
        },
        (pres) => {
          res.writeHead(pres.statusCode || 502, pres.headers);
          pres.pipe(res);
        }
      );
      preq.on('error', () => {
        res.writeHead(502);
        res.end('bad gateway');
      });
      req.pipe(preq);
    });

    server.on('connect', (req, clientSocket, head) => {
      if (!checkAuth(req)) {
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n');
        clientSocket.write('Proxy-Authenticate: Basic realm="MultiHeizSelftest"\r\n\r\n');
        clientSocket.end();
        return;
      }
      hits += 1;
      writeHits();
      const [host, portStr] = String(req.url || '').split(':');
      const port = Number(portStr) || 443;
      const upstream = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => {
        try {
          clientSocket.end();
        } catch {
          /* ignore */
        }
      });
      clientSocket.on('error', () => {
        try {
          upstream.end();
        } catch {
          /* ignore */
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        getHits: () => hits,
      });
    });
    server.on('error', reject);
  });
}

/**
 * SOCKS5 mínimo (sem auth) — opcional / best-effort.
 */
function startSocks5Minimal() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      let stage = 'greeting';
      let remote = null;

      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          const nmethods = buf[1];
          if (buf.length < 2 + nmethods) return;
          socket.write(Buffer.from([0x05, 0x00])); // no auth
          buf = buf.slice(2 + nmethods);
          stage = 'request';
        }
        if (stage === 'request') {
          if (buf.length < 7) return;
          const atyp = buf[3];
          let host;
          let port;
          let need;
          if (atyp === 0x01) {
            need = 4 + 4 + 2;
            if (buf.length < need) return;
            host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
            port = buf.readUInt16BE(8);
          } else if (atyp === 0x03) {
            const len = buf[4];
            need = 5 + len + 2;
            if (buf.length < need) return;
            host = buf.slice(5, 5 + len).toString('utf8');
            port = buf.readUInt16BE(5 + len);
          } else {
            socket.end();
            return;
          }
          const rest = buf.slice(need);
          buf = Buffer.alloc(0);
          stage = 'tunnel';
          remote = net.connect(port, host, () => {
            const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            socket.write(reply);
            if (rest.length) remote.write(rest);
            socket.pipe(remote);
            remote.pipe(socket);
          });
          remote.on('error', () => socket.end());
        }
      };
      socket.on('data', onData);
      socket.on('error', () => {
        try {
          if (remote) remote.end();
        } catch {
          /* ignore */
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
    server.on('error', reject);
  });
}

function runElectron(envExtra) {
  const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-proxy-'));
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...envExtra,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'proxy',
      ELECTRON_ENABLE_LOGGING: '1',
    };
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
      try {
        fs.rmSync(userdata, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      reject(new Error('selftest:proxy timed out'));
    }, 180000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        fs.rmSync(userdata, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      if (code === 0) resolve(out);
      else reject(new Error(`selftest:proxy exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:proxy');
  let echo;
  let httpProxy;
  let socks;
  const hitsFile = path.join(os.tmpdir(), `mh-proxy-hits-${Date.now()}.txt`);
  try {
    runNodeChecks();

    echo = await startEchoServer();
    httpProxy = await startHttpProxy({
      user: 'mhuser',
      pass: 'mhpass',
      hitsFile,
    });
    try {
      socks = await startSocks5Minimal();
      console.log('PASS: SOCKS5 local mínimo escutando', socks.port);
    } catch (err) {
      console.log('NOTE: SOCKS5 local não iniciado:', err.message);
    }

    const echoUrl = `http://127.0.0.1:${echo.port}/ip`;
    console.log('echo', echoUrl, 'httpProxy', httpProxy.port);

    await runElectron({
      MULTIHEIZ_PROXY_TEST_URL: echoUrl,
      MULTIHEIZ_PROXY_HOST: '127.0.0.1',
      MULTIHEIZ_PROXY_PORT: String(httpProxy.port),
      MULTIHEIZ_PROXY_USER: 'mhuser',
      MULTIHEIZ_PROXY_PASS: 'mhpass',
      MULTIHEIZ_PROXY_HITS_FILE: hitsFile,
      MULTIHEIZ_PROXY_HITS: '0',
      MULTIHEIZ_PROXY_SOCKS_PORT: socks ? String(socks.port) : '',
    });

    console.log('PASS: selftest:proxy complete');
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  } finally {
    try {
      if (echo && echo.server) echo.server.close();
    } catch {
      /* ignore */
    }
    try {
      if (httpProxy && httpProxy.server) httpProxy.server.close();
    } catch {
      /* ignore */
    }
    try {
      if (socks && socks.server) socks.server.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(hitsFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

main();
