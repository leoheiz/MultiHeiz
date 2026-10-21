'use strict';

/**
 * Self-test MultiHeiz 1.3.0 — Iniciar com o sistema
 * Uso: npm run selftest:autostart
 *
 * Throwaway MULTIHEIZ_USERDATA. Uses Run name MultiHeizSelftest (never Leo's MultiHeiz).
 * Always cleans up the selftest Run / desktop entry.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-autostart-'));
const xdgConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-xdg-'));

function cleanupHost() {
  if (process.platform === 'win32') {
    try {
      execFileSync(
        'reg',
        [
          'delete',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
          '/v',
          'MultiHeizSelftest',
          '/f',
        ],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }
      );
    } catch {
      /* absent is fine */
    }
  } else if (process.platform === 'linux') {
    try {
      const f = path.join(xdgConfig, 'autostart', 'multiheiz-selftest.desktop');
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

function run() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'autostart',
      MULTIHEIZ_SELFTEST_PHASE: '1',
      XDG_CONFIG_HOME: xdgConfig,
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log('MultiHeiz selftest:autostart');
    console.log('userdata:', userdata);
    if (process.platform === 'linux') console.log('XDG_CONFIG_HOME:', xdgConfig);

    cleanupHost();

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
      reject(new Error('autostart selftest timed out'));
    }, 90000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`autostart selftest exited with code ${code}`));
    });
  });
}

async function main() {
  try {
    await run();
    cleanupHost();
    // Verify host is clean
    if (process.platform === 'win32') {
      try {
        execFileSync(
          'reg',
          [
            'query',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
            '/v',
            'MultiHeizSelftest',
          ],
          { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        console.error('FAIL: MultiHeizSelftest Run value still present after test');
        process.exit(1);
      } catch {
        console.log('PASS: MultiHeizSelftest Run absent after cleanup');
      }
    }
    console.log('PASS: selftest:autostart complete');
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    cleanupHost();
    try {
      fs.rmSync(userdata, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(xdgConfig, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main();
