'use strict';

/**
 * Screenshots locais dos módulos Notas / Alarmes / Planilha.
 * Uso: npm run shots:tools
 * Env:
 *   MULTIHEIZ_SHOTS_PHASE=before|after|all (default: all)
 *   MULTIHEIZ_SHOTS_MODULES=notas,alarmes,planilha (default: todos)
 * Saída: _local/shots-tools/<phase>-<modulo>-<default|narrow>[-claro|-escuro].png
 * LOCAL: perfil descartável; nunca push/tag/release.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const outDir = path.join(root, '_local', 'shots-tools');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-shots-tools-'));

function run() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'shots-tools',
      MULTIHEIZ_SHOTS_OUT: outDir,
      MULTIHEIZ_SHOTS_PHASE: process.env.MULTIHEIZ_SHOTS_PHASE || 'all',
      MULTIHEIZ_SHOTS_MODULES: process.env.MULTIHEIZ_SHOTS_MODULES || 'notas,alarmes,planilha',
      MULTIHEIZ_UI_WIDTH: '1280',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log('MultiHeiz shots:tools');
    console.log('userdata:', userdata);
    console.log('out:', outDir);
    console.log('phase:', env.MULTIHEIZ_SHOTS_PHASE);
    fs.mkdirSync(outDir, { recursive: true });
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
      reject(new Error('shots:tools timed out'));
    }, 300000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error('shots:tools exited with code ' + code));
    });
  });
}

async function main() {
  try {
    await run();
    console.log('PASS: shots:tools complete');
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
