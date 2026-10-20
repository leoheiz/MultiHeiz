'use strict';

/**
 * Self-test MultiHeiz — store bar install (fake CWS/Edge + optional ABU CRX)
 * Uso: npm run selftest:store
 *
 * Env:
 *   MULTIHEIZ_ABU_CRX — path to ABU CRX (default _local/abu-youtube/fixtures/abu-4.4.3.crx)
 * If CRX missing: Electron selftest SKIPs fixture cases and uses a generated CRX for UI/parse.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-store-'));

const defaultCrx = path.join(
  root,
  '_local',
  'abu-youtube',
  'fixtures',
  'abu-4.4.3.crx'
);
const crxPath = process.env.MULTIHEIZ_ABU_CRX
  ? path.resolve(process.env.MULTIHEIZ_ABU_CRX)
  : defaultCrx;

function run() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'store',
      MULTIHEIZ_ABU_CRX: crxPath,
      MULTIHEIZ_UI_WIDTH: '1100',
      MULTIHEIZ_UI_HEIGHT: '720',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log('\n=== selftest:store ===');
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
      reject(new Error('store selftest timed out'));
    }, 600000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`store selftest exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:store');
  console.log('userdata:', userdata);
  console.log('CRX:', crxPath, fs.existsSync(crxPath) ? '(present)' : '(missing → SKIP fixture cases)');
  try {
    const out = await run();
    const passM = out.match(/SELFTEST store OK — PASS=(\d+) SKIP=(\d+)/);
    if (passM) {
      console.log('PASS: selftest:store complete (PASS=' + passM[1] + ' SKIP=' + passM[2] + ')');
    } else {
      console.log('PASS: selftest:store complete');
    }
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  } finally {
    try {
      fs.rmSync(userdata, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main();
