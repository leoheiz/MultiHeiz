'use strict';

/**
 * Self-test permissões de site (prompt in-app, mic/câmera, popover).
 * Uso: npm run selftest:permissions
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
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
    ipcMain: {
      handle() {},
      on() {},
      removeHandler() {},
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
        setDevicePermissionHandler() {},
      },
      fromPartition() {
        return {
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {},
          setDevicePermissionHandler() {},
        };
      },
    },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
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

function runNodeChecks() {
  console.log('MultiHeiz selftest:permissions (node)');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-perm-node-'));
  const userData = path.join(tempDir, 'ud');
  fs.mkdirSync(userData, { recursive: true });
  installElectronStub({ tempDir, userData });
  clearModuleMatch(/\/src\/main\/permissions\.js$/);
  const permissions = require('../src/main/permissions');

  assert(permissions.ASK_PERMISSIONS.has('notifications'), 'notifications ask');
  assert(permissions.ASK_PERMISSIONS.has('clipboard-read'), 'clipboard-read ask');
  assert(!permissions.AUTO_ALLOW.has('clipboard-read'), 'clipboard-read not auto');
  assert(permissions.AUTO_ALLOW.has('clipboard-sanitized-write'), 'sanitized write auto');
  assert(permissions.AUTO_ALLOW.has('fullscreen'), 'fullscreen auto');

  permissions.clearDecisionsForTest();
  const origin = 'https://web.whatsapp.com';
  assert(
    permissions.checkPermission('a', 'media', origin, { mediaTypes: ['audio'] }) === false,
    'mic ask -> check false'
  );
  assert(
    permissions.checkPermission('a', 'media', origin, { mediaTypes: ['video'] }) === false,
    'cam ask -> check false'
  );
  assert(permissions.checkPermission('a', 'notifications', origin) === false, 'notif ask');
  assert(permissions.checkPermission('a', 'usb', origin) === false, 'usb deny');
  assert(permissions.checkPermission('a', 'display-capture', origin) === false, 'display ask/false');

  permissions.setDecisionForTest('a', origin, 'microphone', 'allow');
  assert(
    permissions.checkPermission('a', 'media', origin, { mediaTypes: ['audio'] }) === true,
    'mic allow'
  );
  assert(
    permissions.checkPermission('a', 'media', origin, { mediaTypes: ['video'] }) === false,
    'cam still ask'
  );

  const migrated = permissions.migrateRawDecisions({
    'acc|https://x.com|media': 'deny',
    'acc|https://x.com|geolocation': 'allow',
  });
  assert(migrated['acc|https://x.com|microphone'] === 'deny', 'migrate mic');
  assert(migrated['acc|https://x.com|camera'] === 'deny', 'migrate cam');
  assert(migrated['acc|https://x.com|media'] === 'deny', 'keep legacy media');
  assert(migrated['acc|https://x.com|geolocation'] === 'allow', 'geo kept');

  const keys = permissions.expandPermissionKeys('media', { mediaTypes: ['audio', 'video'] });
  assert(keys.includes('microphone') && keys.includes('camera'), 'both keys');
  const msg = permissions.promptMessage(origin, ['microphone']);
  assert(/microfone/i.test(msg), 'prompt text mic: ' + msg);

  console.log('PASS: node permissions policy + migrate');
}

/**
 * Página local: getUserMedia audio, notifications, permissions.query.
 */
function startLocalPageServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (u.pathname === '/cam') {
        res.end(`<!doctype html><html><body>
<script>
window.__mh = { err: null, stream: null, perm: null };
window.addEventListener('load', function () {
  setTimeout(function () {
    navigator.mediaDevices.getUserMedia({ video: true }).then(s => {
      window.__mh.stream = s;
    }).catch(e => { window.__mh.err = e && e.name; });
  }, 150);
});
</script>câmera</body></html>`);
        return;
      }
      if (u.pathname === '/notif') {
        res.end(`<!doctype html><html><body>
<script>
window.__mh = { notif: null, err: null };
window.addEventListener('load', function () {
  setTimeout(function () {
    Notification.requestPermission().then(r => { window.__mh.notif = r; })
      .catch(e => { window.__mh.err = String(e); });
  }, 150);
});
</script>notif</body></html>`);
        return;
      }
      res.end(`<!doctype html><html><body>
<script>
window.__mh = { err: null, stream: null, perm: null, tracksEnded: false, ready: false };
async function run() {
  window.__mh.ready = true;
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const st = await navigator.permissions.query({ name: 'microphone' });
      window.__mh.perm = st.state;
    }
  } catch (e0) { window.__mh.perm = 'query-err'; }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    window.__mh.stream = s;
    const t = s.getAudioTracks()[0];
    if (t) {
      t.addEventListener('ended', () => { window.__mh.tracksEnded = true; });
    }
  } catch (e) {
    window.__mh.err = e && e.name ? e.name : String(e);
  }
}
// Atraso para o preload reaplicar o hook getUserMedia após a navegação
window.addEventListener('load', function () { setTimeout(run, 150); });
window.__mhStop = function () {
  try {
    if (window.__mh.stream) {
      window.__mh.stream.getTracks().forEach(t => t.stop());
    }
  } catch (e) {}
};
</script>mic test</body></html>`);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}/` });
    });
    server.on('error', reject);
  });
}

async function main() {
  runNodeChecks();

  const { server, url } = await startLocalPageServer();
  const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-perm-'));
  console.log('userData:', userdata);
  console.log('page:', url);

  await new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'permissions',
      MULTIHEIZ_PERM_TEST_URL: url,
      MULTIHEIZ_UI_WIDTH: '1200',
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
      reject(new Error('permissions selftest timed out'));
    }, 180000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error('permissions selftest exited ' + code));
    });
  });

  server.close();
  console.log('PASS: selftest:permissions complete');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});
