'use strict';

/**
 * Orchestrates real OS mouse drag / click / double-click on the topbar.
 * Uso: npm run check:realdrag-topbar
 *
 * Starts Electron with MULTIHEIZ_SELFTEST=realdrag-topbar, waits for ready.json
 * steps, runs tools/realdrag.ps1, writes done.json, collects result.
 * Log: _local/realdrag-topbar.log (preserves BEFORE baseline if present).
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const localDir = path.join(root, '_local');
const logPath = path.join(localDir, 'realdrag-topbar.log');
const handshakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-realdrag-'));
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-realdrag-'));

fs.mkdirSync(localDir, { recursive: true });

/** @type {number | null} */
let electronExitCode = null;

function appendLog(line) {
  const s = typeof line === 'string' ? line : JSON.stringify(line);
  fs.appendFileSync(logPath, s + '\n', { encoding: 'utf8' });
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

/**
 * @param {object} ready
 */
function runPsAction(ready) {
  return new Promise((resolve, reject) => {
    const ps1 = path.join(root, 'tools', 'realdrag.ps1');
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ps1,
      '-Mode',
      String(ready.action || 'Click'),
      '-X',
      String(ready.physical.x),
      '-Y',
      String(ready.physical.y),
    ];
    if (ready.action === 'Drag') {
      args.push('-DeltaX', String(ready.deltaPhys.x), '-DeltaY', String(ready.deltaPhys.y));
      args.push('-Steps', String(ready.steps || 8));
    }
    const child = spawn('powershell.exe', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      else reject(new Error('realdrag.ps1 exited ' + code + ': ' + out));
    });
  });
}

async function main() {
  let beforeBlock = '';
  if (fs.existsSync(logPath)) {
    try {
      const prev = fs.readFileSync(logPath, 'utf8');
      const m = prev.match(/=== realdrag-topbar BEFORE[\s\S]*?(?==== realdrag-topbar AFTER|$)/);
      if (m) beforeBlock = m[0].trimEnd() + '\n';
      else if (/BEFORE|FAIL \(pre-correction/.test(prev)) beforeBlock = prev.trimEnd() + '\n';
    } catch {
      /* ignore */
    }
  }
  if (!beforeBlock) {
    beforeBlock =
      '=== realdrag-topbar BEFORE (missing baseline; inferred from e68678d) ===\n' +
      'Status: FAIL — #topbar was no-drag; only .spacer dragged\n';
  }

  fs.writeFileSync(logPath, beforeBlock + '\n', { encoding: 'utf8' });
  appendLog('=== realdrag-topbar AFTER ' + new Date().toISOString() + ' ===');
  appendLog('userdata: ' + userdata);
  appendLog('handshake: ' + handshakeDir);

  const env = {
    ...process.env,
    MULTIHEIZ_USERDATA: userdata,
    MULTIHEIZ_SELFTEST: 'realdrag-topbar',
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
  const maxSteps = 20;

  const actionLoop = (async () => {
    for (let i = 0; i < maxSteps; i++) {
      if (electronExitCode !== null) break;
      const ready = await waitForReady(120000, seenTokens);
      seenTokens.add(ready.token);
      if (ready.done) {
        appendLog('ready done=true (no more OS actions)');
        break;
      }
      appendLog(
        'ready step=' +
          ready.step +
          ' action=' +
          ready.action +
          ' mode=' +
          ready.mode +
          ' phys=' +
          ready.physical.x +
          ',' +
          ready.physical.y +
          (ready.deltaPhys ? ' delta=' + ready.deltaPhys.x + ',' + ready.deltaPhys.y : '')
      );
      try {
        fs.unlinkSync(path.join(handshakeDir, 'done.json'));
      } catch {
        /* ignore */
      }
      const psOut = await runPsAction(ready);
      appendLog('ps1: ' + psOut);
      fs.writeFileSync(
        path.join(handshakeDir, 'done.json'),
        JSON.stringify({ token: ready.token, at: new Date().toISOString() }, null, 2),
        'utf8'
      );
      await sleep(150);
    }
  })();

  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }, 240000);

  let actionErr = null;
  try {
    await actionLoop.catch((e) => {
      actionErr = e;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    });
    await Promise.race([childDone, sleep(60000)]);
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
  if (actionErr) appendLog('action loop error: ' + (actionErr && actionErr.message));

  try {
    fs.rmSync(userdata, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  if (actionErr) {
    process.exitCode = 1;
    return;
  }
  if (electronExitCode !== 0 || !result || !result.ok) {
    process.exitCode = 1;
    return;
  }
  appendLog('PASS: check:realdrag-topbar');
}

main().catch((err) => {
  appendLog('FATAL: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
