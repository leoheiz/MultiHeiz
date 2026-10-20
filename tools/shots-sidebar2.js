'use strict';

/**
 * Screenshots da barra lateral com seta + pino.
 * Uso: npm run shots:sidebar2
 * Saída: _local/shots-sidebar2/*.png
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const outDir = path.join(root, '_local', 'shots-sidebar2');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-shots-sb2-'));

function run() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'shots-sidebar2',
      MULTIHEIZ_SHOTS_OUT: outDir,
      MULTIHEIZ_UI_WIDTH: '1280',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log('MultiHeiz shots:sidebar2');
    console.log('userdata:', userdata);
    console.log('out:', outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const child = spawn(electronBin, ['.'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (buf) => process.stdout.write(buf.toString());
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('shots:sidebar2 timed out'));
    }, 240000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('shots:sidebar2 exited with code ' + code));
    });
  });
}

async function main() {
  try {
    await run();
    console.log('PASS: shots:sidebar2 complete');
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
