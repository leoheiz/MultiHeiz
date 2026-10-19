'use strict';

/**
 * Self-test UI MultiHeiz v1.2 — bounds, overlays, scale.
 * Uso: npm run selftest:ui
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');

const SCALES = ['1', '1.25', '1.5'];

function runScale(scale) {
  return new Promise((resolve, reject) => {
    const userdata = fs.mkdtempSync(path.join(os.tmpdir(), `multiheiz-uitest-${scale}-`));
    const electronArgs = ['.'];
    if (scale !== '1') {
      electronArgs.unshift(`--force-device-scale-factor=${scale}`);
    }

    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'ui',
      MULTIHEIZ_UI_SCALE: scale,
      MULTIHEIZ_UI_WIDTH: '1600',
      MULTIHEIZ_UI_HEIGHT: '900',
      ELECTRON_ENABLE_LOGGING: '1',
    };

    console.log(`\n=== selftest:ui scale=${scale} ===`);
    const child = spawn(electronBin, electronArgs, {
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
      reject(new Error(`ui selftest scale=${scale} timed out`));
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
      if (code === 0) resolve({ scale, out });
      else reject(new Error(`ui selftest scale=${scale} exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:ui');
  const results = [];
  try {
    for (const scale of SCALES) {
      try {
        await runScale(scale);
        results.push({ scale, ok: true });
      } catch (err) {
        results.push({ scale, ok: false, error: err.message });
        console.error(`FAIL scale=${scale}:`, err.message);
      }
    }

    const shots = path.join(root, 'docs', 'screenshots');
    const needed = ['v1.2-layout4-one.png', 'v1.2-modal-open.png'];
    for (const f of needed) {
      const p = path.join(shots, f);
      if (!fs.existsSync(p) || fs.statSync(p).size < 100) {
        console.log(`FAIL: missing screenshot ${f}`);
        process.exit(1);
      }
    }
    console.log('PASS: v1.2 screenshots present');

    console.log('\n=== Scale summary ===');
    for (const r of results) {
      console.log(r.ok ? `PASS: scale ${r.scale}` : `FAIL: scale ${r.scale} — ${r.error}`);
    }

    if (results.some((r) => !r.ok)) {
      console.log('FAIL: selftest:ui (some scales failed)');
      process.exit(1);
    }
    console.log('PASS: selftest:ui complete');
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  }
}

main();
