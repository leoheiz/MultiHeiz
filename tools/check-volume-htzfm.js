'use strict';

/**
 * Check opcional (site real): volume em https://htzfm.com/ (offscreen).
 * Opt-in: MULTIHEIZ_SELFTEST_REAL_SITES=1 npm run check:volume-htzfm
 * Sem o flag → SKIP (exit 0). Rede falha → SKIP. Relatório: _local/check-volume-htzfm.json
 * Não faz parte do suite; selftest:volume cobre mocks locais.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const localDir = path.join(root, '_local');
const logPath = path.join(localDir, 'check-volume-htzfm.log');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-vol-htzfm-'));

fs.mkdirSync(localDir, { recursive: true });
fs.writeFileSync(logPath, '', 'utf8');

function append(line) {
  const s = typeof line === 'string' ? line : JSON.stringify(line);
  fs.appendFileSync(logPath, s + '\n', 'utf8');
  process.stdout.write(s + '\n');
}

async function main() {
  if (process.env.MULTIHEIZ_SELFTEST_REAL_SITES !== '1') {
    append('SKIP: check:volume-htzfm — defina MULTIHEIZ_SELFTEST_REAL_SITES=1 (site real)');
    process.exit(0);
  }
  append('check:volume-htzfm start');
  append('userdata: ' + userdata);
  const env = {
    ...process.env,
    MULTIHEIZ_USERDATA: userdata,
    MULTIHEIZ_SELFTEST: 'volume-htzfm',
    MULTIHEIZ_UI_WIDTH: '1280',
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
    fs.appendFileSync(logPath, s, 'utf8');
    process.stdout.write(s);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('volume-htzfm timed out'));
    }, 180000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });

  try {
    fs.rmSync(userdata, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  if (code === 0) {
    append('PASS/SKIP: check:volume-htzfm exit 0');
    process.exit(0);
  }
  append('FAIL: exit ' + code);
  process.exit(1);
}

main().catch((err) => {
  append('FAIL: ' + err.message);
  try {
    fs.rmSync(userdata, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
