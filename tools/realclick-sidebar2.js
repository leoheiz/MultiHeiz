'use strict';

/**
 * Orchestrates real OS mouse for dual-button sidebar.
 * Uso: npm run check:realclick-sidebar2
 *
 * Phase 1: MULTIHEIZ_SELFTEST=realclick-sidebar2 — clicks + edge hover.
 * Phase 2: same MULTIHEIZ_USERDATA — persistence (autohide+compact).
 * Log: _local/realclick-sidebar2.log
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const localDir = path.join(root, '_local');
const logPath = path.join(localDir, 'realclick-sidebar2.log');
const handshakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-realclick2-'));
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-realclick2-'));

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

/**
 * @param {number} physX
 * @param {number} physY
 * @param {'click' | 'hover'} kind
 */
function runPsInput(physX, physY, kind) {
  return new Promise((resolve, reject) => {
    const ps1 = path.join(root, 'tools', kind === 'hover' ? 'realhover.ps1' : 'realclick.ps1');
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ps1,
      '-X',
      String(physX),
      '-Y',
      String(physY),
    ];
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
      else reject(new Error(path.basename(ps1) + ' exited ' + code + ': ' + out));
    });
  });
}

/**
 * @param {string} phase
 */
function spawnPhase(phase) {
  electronExitCode = null;
  const env = {
    ...process.env,
    MULTIHEIZ_USERDATA: userdata,
    MULTIHEIZ_SELFTEST: 'realclick-sidebar2',
    MULTIHEIZ_SELFTEST_PHASE: String(phase),
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
  return { child, childDone };
}

async function main() {
  fs.writeFileSync(logPath, '', 'utf8');
  appendLog('=== check:realclick-sidebar2 ' + new Date().toISOString() + ' ===');
  appendLog('userdata: ' + userdata);
  appendLog('handshake: ' + handshakeDir);

  appendLog('--- phase 1 ---');
  const p1 = spawnPhase('1');
  const seenTokens = new Set();
  // Enough slots for all ready handshakes in phase 1 (clicks + hovers).
  const maxHandshakes = 20;

  const inputLoop = (async () => {
    for (let i = 0; i < maxHandshakes; i++) {
      if (electronExitCode !== null) break;
      let ready;
      try {
        ready = await waitForReady(electronExitCode !== null ? 2000 : 120000, seenTokens);
      } catch (e) {
        if (electronExitCode !== null) break;
        throw e;
      }
      seenTokens.add(ready.token);
      appendLog(
        'ready mode=' +
          ready.mode +
          ' action=' +
          ready.action +
          ' kind=' +
          ready.kind +
          ' phys=' +
          ready.physical.x +
          ',' +
          ready.physical.y +
          ' scale=' +
          ready.scaleFactor
      );
      try {
        fs.unlinkSync(path.join(handshakeDir, 'done.json'));
      } catch {
        /* ignore */
      }
      const kind = ready.kind === 'hover' ? 'hover' : 'click';
      const out = await runPsInput(ready.physical.x, ready.physical.y, kind);
      appendLog('ps1: ' + out);
      fs.writeFileSync(
        path.join(handshakeDir, 'done.json'),
        JSON.stringify({ token: ready.token, at: new Date().toISOString() }, null, 2),
        'utf8'
      );
      await sleep(200);
    }
  })();

  const timer1 = setTimeout(() => {
    try {
      p1.child.kill();
    } catch {
      /* ignore */
    }
  }, 300000);

  let loopErr = null;
  try {
    await inputLoop.catch((e) => {
      loopErr = e;
      try {
        p1.child.kill();
      } catch {
        /* ignore */
      }
    });
    await Promise.race([p1.childDone, sleep(60000)]);
  } finally {
    clearTimeout(timer1);
    if (electronExitCode === null) {
      try {
        p1.child.kill();
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
  appendLog('phase1 electron exit: ' + electronExitCode);
  if (loopErr) appendLog('input loop error: ' + (loopErr && loopErr.message));

  if (loopErr || electronExitCode !== 0 || !result || !result.ok) {
    appendLog('FAIL: phase1');
    process.exitCode = 1;
    try {
      fs.rmSync(userdata, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return;
  }

  appendLog('--- phase 2 ---');
  const p2 = spawnPhase('2');
  const timer2 = setTimeout(() => {
    try {
      p2.child.kill();
    } catch {
      /* ignore */
    }
  }, 120000);
  const code2 = await p2.childDone;
  clearTimeout(timer2);
  appendLog('phase2 electron exit: ' + code2);

  try {
    fs.rmSync(userdata, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  if (code2 !== 0) {
    appendLog('FAIL: phase2');
    process.exitCode = 1;
    return;
  }
  appendLog('PASS: check:realclick-sidebar2');
}

main().catch((err) => {
  appendLog('FATAL: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
