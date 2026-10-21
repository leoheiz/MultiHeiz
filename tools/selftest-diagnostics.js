'use strict';

/**
 * Launcher: npm run selftest:diagnostics
 * Throwaway MULTIHEIZ_USERDATA; no dialogs (fixed MULTIHEIZ_DIAG_OUT).
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-diag-'));
const diagOut = path.join(userdata, 'report-out.txt');

function run() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'diagnostics',
      MULTIHEIZ_DIAG_OUT: diagOut,
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
      reject(new Error('diagnostics selftest timed out'));
    }, 120000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error('diagnostics selftest exited with code ' + code));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:diagnostics');
  console.log('userData:', userdata);
  console.log('diagOut:', diagOut);
  try {
    await run();
    if (fs.existsSync(diagOut)) {
      const text = fs.readFileSync(diagOut, 'utf8');
      const banned = [
        'fulano.teste@example.com',
        'secret.example.org',
        'sk-test-1234567890abcdef',
        'ProxyPass-Segredo-999',
        'LeoFakeDiagUser',
      ];
      for (const b of banned) {
        if (text.includes(b)) {
          console.log('FAIL: launcher found banned string in report:', b);
          process.exit(1);
        }
      }
      console.log('PASS: launcher re-check of saved report');
    }
    console.log('PASS: selftest:diagnostics complete');
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
