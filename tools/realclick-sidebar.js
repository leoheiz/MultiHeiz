'use strict';

/**
 * Orchestrates a real OS mouse click against #btn-sidebar-toggle.
 * Uso: npm run check:realclick-sidebar
 *
 * Starts Electron with MULTIHEIZ_SELFTEST=realclick-sidebar, waits for ready.json
 * (button screen coords), runs tools/realclick.ps1, writes done.json, collects result.
 * Log: _local/realclick-sidebar.log
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const localDir = path.join(root, '_local');
const logPath = path.join(localDir, 'realclick-sidebar.log');
const handshakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-realclick-'));
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-realclick-'));

fs.mkdirSync(localDir, { recursive: true });

/** @type {number | null} */
let electronExitCode = null;

function appendLog(line) {
  const s = typeof line === 'string' ? line : JSON.stringify(line);
  fs.appendFileSync(logPath, s + '\n', 'utf8');
  process.stdout.write(s + '\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {number} timeoutMs
 * @param {Set<string>} seenTokens
 */
async function waitForReady(timeoutMs, seenTokens) {
  const readyPath = path.join(handshakeDir, 'ready.json');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (electronExitCode !== null) {
      throw new Error('electron exited while waiting for ready');
    }
    if (fs.existsSync(readyPath)) {
      try {
        const raw = fs.readFileSync(readyPath, 'utf8');
        const obj = JSON.parse(raw);
        if (obj && obj.token && !seenTokens.has(obj.token)) {
          return obj;
        }
      } catch {
        /* retry */
      }
    }
    await sleep(40);
  }
  throw new Error('timeout waiting for ready.json');
}

function runPsClick(physX, physY) {
  return new Promise((resolve, reject) => {
    const ps1 = path.join(root, 'tools', 'realclick.ps1');
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        ps1,
        '-X',
        String(physX),
        '-Y',
        String(physY),
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    child.stdout.on('data', (b) => {
      out += b.toString();
    });
    child.stderr.on('data', (b) => {
      out += b.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error('realclick.ps1 exited ' + code + ': ' + out));
    });
  });
}

async function main() {
  fs.writeFileSync(logPath, '', 'utf8');
  appendLog('=== check:realclick-sidebar ' + new Date().toISOString() + ' ===');
  appendLog('userdata: ' + userdata);
  appendLog('handshake: ' + handshakeDir);
  appendLog(
    process.env.MULTIHEIZ_REALCLICK_PHASE === 'before'
      ? 'fase: BEFORE (CSS HEAD 0f923d2 — topbar drag)'
      : 'fase: AFTER (topbar no-drag, spacer drag, sidebar no-drag)'
  );

  const env = {
    ...process.env,
    MULTIHEIZ_USERDATA: userdata,
    MULTIHEIZ_SELFTEST: 'realclick-sidebar',
    MULTIHEIZ_REALCLICK_DIR: handshakeDir,
    MULTIHEIZ_UI_WIDTH: '1400',
    MULTIHEIZ_UI_HEIGHT: '900',
    ELECTRON_ENABLE_LOGGING: '1',
  };

  const child = spawn(electronBin, ['.'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onData = (buf) => {
    process.stdout.write(buf.toString());
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const childDone = new Promise((resolve) => {
    child.on('close', (code) => {
      electronExitCode = code;
      resolve(code);
    });
  });

  const seenTokens = new Set();
  const expectedModes = 4;

  const clickLoop = (async () => {
    for (let i = 0; i < expectedModes; i++) {
      if (electronExitCode !== null) break;
      const ready = await waitForReady(120000, seenTokens);
      seenTokens.add(ready.token);
      appendLog(
        'ready mode=' +
          ready.mode +
          ' phys=' +
          ready.physical.x +
          ',' +
          ready.physical.y +
          ' scale=' +
          ready.scaleFactor +
          ' covering=' +
          (ready.coveringViews || []).length +
          ' topbarRegion=' +
          (ready.hit && ready.hit.topbarRegion) +
          ' spacerRegion=' +
          (ready.hit && ready.hit.spacerRegion) +
          ' elementFromPoint=' +
          (ready.hit && ready.hit.elementFromPoint)
      );
      // Drop stale done before acknowledging
      try {
        fs.unlinkSync(path.join(handshakeDir, 'done.json'));
      } catch {
        /* ignore */
      }
      const clickOut = await runPsClick(ready.physical.x, ready.physical.y);
      appendLog('ps1: ' + clickOut);
      fs.writeFileSync(
        path.join(handshakeDir, 'done.json'),
        JSON.stringify({ token: ready.token, at: new Date().toISOString() }, null, 2),
        'utf8'
      );
      await sleep(200);
    }
  })();

  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }, 180000);

  let clickErr = null;
  try {
    await clickLoop.catch((e) => {
      clickErr = e;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    });
    await Promise.race([childDone, sleep(45000)]);
  } finally {
    clearTimeout(timer);
    if (electronExitCode === null) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      await sleep(500);
    }
  }

  const resultPath = path.join(handshakeDir, 'result.json');
  let result = null;
  if (fs.existsSync(resultPath)) {
    try {
      result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      appendLog('result: ' + JSON.stringify(result, null, 2));
    } catch (e) {
      appendLog('result parse error: ' + e.message);
    }
  } else {
    appendLog('no result.json (electron may have failed early)');
  }
  appendLog('electron exit: ' + electronExitCode);
  if (clickErr) appendLog('click loop error: ' + (clickErr && clickErr.message));

  try {
    fs.rmSync(userdata, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  if (clickErr) {
    process.exitCode = 1;
    return;
  }
  if (electronExitCode !== 0 || !result || !result.ok) {
    process.exitCode = 1;
    return;
  }
  appendLog('PASS: check:realclick-sidebar');
}

main().catch((err) => {
  appendLog('FATAL: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
