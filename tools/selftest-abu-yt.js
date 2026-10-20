'use strict';

/**
 * Self-test MultiHeiz — ABU YouTube (PLAN 3.A, offline HTTPS)
 * Uso: npm run selftest:abu-yt
 *
 * Env:
 *   MULTIHEIZ_ABU_CRX — path to ABU CRX (default _local/abu-youtube/fixtures/abu-4.4.3.crx)
 * If CRX missing: prints SKIP and exits 0.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-abu-yt-'));

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
      MULTIHEIZ_SELFTEST: 'abu-yt',
      MULTIHEIZ_ABU_CRX: crxPath,
      MULTIHEIZ_UI_WIDTH: '400',
      MULTIHEIZ_UI_HEIGHT: '300',
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
      reject(new Error('abu-yt selftest timed out'));
    }, 420000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`abu-yt selftest exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:abu-yt');
  console.log('userData:', userdata);
  console.log('CRX:', crxPath);
  if (!fs.existsSync(crxPath)) {
    console.log('SKIP: ABU CRX missing —', crxPath);
    process.exit(0);
  }
  try {
    await run();
    console.log('PASS: selftest:abu-yt complete');
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
