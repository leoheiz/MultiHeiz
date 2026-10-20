'use strict';

/**
 * Real OS mouse hover for volume popover overlay.
 * Uso: npm run check:realhover-volume
 * Log: _local/realhover-volume.log
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const localDir = path.join(root, '_local');
const logPath = path.join(localDir, 'realhover-volume.log');
const handshakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-realhover-vol-'));
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-realhover-vol-'));

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

function runPsHover(physX, physY, click) {
  return new Promise((resolve, reject) => {
    const ps1 = path.join(root, 'tools', 'realhover.ps1');
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
    if (click) args.push('-Click');
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
      else reject(new Error('realhover.ps1 exited ' + code + ': ' + out));
    });
  });
}

async function main() {
  fs.writeFileSync(logPath, '', 'utf8');
  appendLog('=== check:realhover-volume ' + new Date().toISOString() + ' ===');
  appendLog('userdata: ' + userdata);
  appendLog('handshake: ' + handshakeDir);

  const env = {
    ...process.env,
    MULTIHEIZ_USERDATA: userdata,
    MULTIHEIZ_SELFTEST: 'realhover-volume',
    MULTIHEIZ_REALCLICK_DIR: handshakeDir,
    MULTIHEIZ_UI_WIDTH: '1280',
    MULTIHEIZ_UI_HEIGHT: '800',
    ELECTRON_ENABLE_LOGGING: '1',
  };

  const child = spawn(electronBin, ['.'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (buf) => process.stdout.write(buf.toString()));
  child.stderr.on('data', (buf) => process.stdout.write(buf.toString()));

  const childDone = new Promise((resolve) => {
    child.on('close', (code) => {
      electronExitCode = code;
      resolve(code);
    });
  });

  const seenTokens = new Set();
  const maxSteps = 8;

  const hoverLoop = (async () => {
    for (let i = 0; i < maxSteps; i++) {
      if (electronExitCode !== null) break;
      if (fs.existsSync(path.join(handshakeDir, 'result.json'))) {
        appendLog('result.json present — stop hover loop');
        break;
      }
      let ready;
      try {
        ready = await waitForReady(120000, seenTokens);
      } catch (err) {
        if (electronExitCode !== null) break;
        throw err;
      }
      seenTokens.add(ready.token);
      if (ready.done) {
        appendLog('selftest signaled done');
        break;
      }
      const px = ready.physX != null ? ready.physX : ready.physical && ready.physical.x;
      const py = ready.physY != null ? ready.physY : ready.physical && ready.physical.y;
      appendLog(
        'ready step=' + ready.step + ' phys=' + px + ',' + py + ' click=' + !!ready.click
      );
      try {
        fs.unlinkSync(path.join(handshakeDir, 'done.json'));
      } catch {
        /* ignore */
      }
      const out = await runPsHover(px, py, !!ready.click);
      appendLog('ps1: ' + out);
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

  let hoverErr = null;
  try {
    await hoverLoop.catch((e) => {
      hoverErr = e;
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
    appendLog('no result.json');
  }
  appendLog('electron exit: ' + electronExitCode);
  if (hoverErr) appendLog('hover loop error: ' + (hoverErr && hoverErr.message));

  try {
    fs.rmSync(userdata, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // Hover loop may see electron exit while waiting for a 4th ready — ignore if result ok.
  if (electronExitCode !== 0 || !result || !result.ok) {
    process.exitCode = 1;
    return;
  }
  if (hoverErr && !/exited while waiting for ready/.test(String(hoverErr.message || ''))) {
    process.exitCode = 1;
    return;
  }
  appendLog('PASS: check:realhover-volume');
}

main().catch((err) => {
  appendLog('FATAL: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
