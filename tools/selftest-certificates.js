'use strict';

/**
 * Self-test certificados (picker, erro HTTPS, continuar só em privado).
 * Uso: npm run selftest:certificates
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const electronBin = require('electron');

function assert(cond, msg) {
  if (!cond) {
    console.log('FAIL:', msg);
    process.exit(1);
  }
}

function installElectronStub(opts = {}) {
  const electronPath = require.resolve('electron');
  const stub = {
    app: {
      isPackaged: false,
      getVersion: () => '1.3.0',
      getPath: (name) => {
        if (name === 'userData') return opts.userData || opts.tempDir || os.tmpdir();
        return opts.tempDir || os.tmpdir();
      },
      on() {},
      quit() {},
    },
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
    shell: { openPath: async () => '' },
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
  return stub;
}

function clearModuleMatch(re) {
  for (const key of Object.keys(require.cache)) {
    if (re.test(key.replace(/\\/g, '/'))) delete require.cache[key];
  }
}

function opensslBins() {
  const list = ['openssl'];
  if (process.platform === 'win32') {
    list.push(
      'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe'
    );
  }
  return list;
}

function ensureSelfSigned(dir, cn) {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  fs.mkdirSync(dir, { recursive: true });
  let lastErr = null;
  for (const bin of opensslBins()) {
    try {
      execFileSync(
        bin,
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-days',
          '2',
          '-nodes',
          '-subj',
          `/CN=${cn}`,
        ],
        { stdio: 'pipe' }
      );
      if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    'selftest-certificates: need openssl' +
      (lastErr && lastErr.message ? ' (' + lastErr.message + ')' : '')
  );
}

function startHttpsServer() {
  const certDir = path.join(os.tmpdir(), 'multiheiz-cert-selftest');
  const { key, cert } = ensureSelfSigned(certDir, '127.0.0.1');
  return new Promise((resolve, reject) => {
    const server = https.createServer({ key, cert }, (req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<!doctype html><html><body><p id="ok">cert-local-ok</p><p>' +
          String(req.headers.host || '') +
          '</p></body></html>'
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        localUrl: `https://127.0.0.1:${addr.port}/`,
        publicUrl: `https://mh-public.example.com:${addr.port}/`,
      });
    });
    server.on('error', reject);
  });
}

function runNodeChecks() {
  console.log('MultiHeiz selftest:certificates (node)');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-cert-node-'));
  const userData = path.join(tempDir, 'ud');
  fs.mkdirSync(userData, { recursive: true });
  installElectronStub({ tempDir, userData });
  clearModuleMatch(/\/src\/main\/certificates\.js$/);
  const certificates = require('../src/main/certificates');

  assert(certificates.isPrivateOrLocalHost('127.0.0.1'), '127');
  assert(certificates.isPrivateOrLocalHost('10.1.2.3'), '10');
  assert(certificates.isPrivateOrLocalHost('172.20.0.1'), '172.20');
  assert(certificates.isPrivateOrLocalHost('192.168.0.1'), '192.168');
  assert(certificates.isPrivateOrLocalHost('localhost'), 'localhost');
  assert(certificates.isPrivateOrLocalHost('foo.local'), '.local');
  assert(certificates.isPrivateOrLocalHost('::1'), '::1');
  assert(!certificates.isPrivateOrLocalHost('mh-public.example.com'), 'public name');
  assert(!certificates.isPrivateOrLocalHost('1.1.1.1'), 'public ip');

  const reason = certificates.certErrorReasonPt('ERR_CERT_AUTHORITY_INVALID');
  assert(/emissor|autoassinado|confiável/i.test(reason), 'reason pt-BR: ' + reason);

  console.log('PASS: node certificates helpers');
}

async function main() {
  runNodeChecks();

  const { server, localUrl, publicUrl } = await startHttpsServer();
  const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-cert-'));
  console.log('userData:', userdata);
  console.log('local:', localUrl);
  console.log('public:', publicUrl);

  await new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'certificates',
      MULTIHEIZ_CERT_LOCAL_URL: localUrl,
      MULTIHEIZ_CERT_PUBLIC_URL: publicUrl,
      MULTIHEIZ_UI_WIDTH: '1100',
      MULTIHEIZ_UI_HEIGHT: '800',
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
      reject(new Error('certificates selftest timed out'));
    }, 180000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error('certificates selftest exited ' + code));
    });
  });

  server.close();
  console.log('PASS: selftest:certificates complete');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});
