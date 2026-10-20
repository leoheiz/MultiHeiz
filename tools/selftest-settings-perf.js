'use strict';

/**
 * Self-test latência de aplicar configurações.
 * Uso: npm run selftest:settings-perf
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-settings-perf-'));

function run() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'settings-perf',
      MULTIHEIZ_PROFILE: '1',
      MULTIHEIZ_UI_WIDTH: '1400',
      MULTIHEIZ_UI_HEIGHT: '900',
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
      reject(new Error('settings-perf timed out'));
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
      else reject(new Error('settings-perf exited ' + code));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:settings-perf');
  console.log('userdata:', userdata);
  await run();
  const logPath = path.join(root, '_local', 'settings-apply-profile.log');
  if (fs.existsSync(logPath)) {
    console.log('--- profile log ---');
    process.stdout.write(fs.readFileSync(logPath, 'utf8'));
  }
  console.log('PASS: selftest:settings-perf complete');
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
