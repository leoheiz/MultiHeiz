'use strict';

/**
 * Packaged adblock selftest: electron-builder --dir, then run MultiHeiz.exe
 * with MULTIHEIZ_SELFTEST=adblock-packaged.
 */

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const exe = path.join(root, 'dist', 'win-unpacked', 'MultiHeiz.exe');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-packaged-'));

function buildDir() {
  console.log('Building win-unpacked (electron-builder --win --dir)…');
  execSync('npx electron-builder --win --dir', {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
}

function runPackaged() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(exe)) {
      reject(new Error('Missing ' + exe + ' — build failed?'));
      return;
    }
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'adblock-packaged',
      MULTIHEIZ_ADBLOCK_TEST: '1',
      MULTIHEIZ_ADBLOCK_DEBUG: '1',
      MULTIHEIZ_UI_WIDTH: '1200',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    const child = spawn(exe, [], {
      cwd: path.dirname(exe),
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
      reject(new Error('packaged adblock selftest timed out'));
    }, 240000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`packaged selftest exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:packaged');
  console.log('userData:', userdata);
  try {
    buildDir();
    // Verify asar contains cosmetic preload and excludes selftests
    const asarPath = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
    const unpackedCosmetic = path.join(
      root,
      'dist',
      'win-unpacked',
      'resources',
      'app.asar.unpacked',
      'src',
      'main',
      'adblock',
      'cosmetic-preload.js'
    );
    const unpackedPanel = path.join(
      root,
      'dist',
      'win-unpacked',
      'resources',
      'app.asar.unpacked',
      'src',
      'preload',
      'panel-preload.js'
    );
    if (!fs.existsSync(asarPath)) throw new Error('app.asar missing');
    if (!fs.existsSync(unpackedCosmetic)) {
      throw new Error('asarUnpack missing cosmetic-preload.js at ' + unpackedCosmetic);
    }
    if (!fs.existsSync(unpackedPanel)) {
      throw new Error('asarUnpack missing panel-preload.js at ' + unpackedPanel);
    }
    console.log('PASS: asarUnpack preloads present');
    await runPackaged();
    console.log('PASS: selftest:packaged complete');
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
