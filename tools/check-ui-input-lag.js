'use strict';

/**
 * Mede lag de digitação na UI com vídeo “YouTube-like”.
 * Uso: npm run check:ui-input-lag
 * Roda before (legado) + after (otimizado) e grava _local/ui-input-lag.md
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const logDir = path.join(root, '_local');

function runPhase(legacy) {
  const userdata = fs.mkdtempSync(
    path.join(os.tmpdir(), legacy ? 'multiheiz-uil-before-' : 'multiheiz-uil-after-')
  );
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'ui-input-lag',
      MULTIHEIZ_UI_LAG_LEGACY: legacy ? '1' : '0',
      MULTIHEIZ_UI_WIDTH: '1280',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    // Antes: sonda FPS ligada (comportamento antigo). Depois: só SELFTEST, sem PROFILE.
    if (legacy) env.MULTIHEIZ_PROFILE = '1';
    else delete env.MULTIHEIZ_PROFILE;
    console.log('check:ui-input-lag phase=' + (legacy ? 'before' : 'after'));
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
      reject(new Error((legacy ? 'before' : 'after') + ' timed out'));
    }, 240000);
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
      else reject(new Error((legacy ? 'before' : 'after') + ' exited ' + code));
    });
  });
}

function readJson(name) {
  const p = path.join(logDir, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function fmt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return (Math.round(Number(n) * 10) / 10).toFixed(1);
}

async function main() {
  fs.mkdirSync(logDir, { recursive: true });
  await runPhase(true);
  await runPhase(false);

  const before = readJson('ui-input-lag-before.json');
  const after = readJson('ui-input-lag-after.json');
  assert(before && before.stats, 'missing before json');
  assert(after && after.stats, 'missing after json');

  const b = before.stats;
  const a = after.stats;
  const md = `# UI input lag (vídeo tocando)

Medição local — página simulando YouTube (vídeo + title/history + favicon + mídia).
Latência keydown→input no \`<input>\` da UI do app; long tasks via PerformanceObserver.

## Antes (legado: renderSidebar em metrics/favicon + status bar sem throttle + sonda FPS)

| Métrica | Valor |
|---|---|
| amostras | ${b.n} |
| p50 (ms) | ${fmt(b.p50)} |
| p95 (ms) | ${fmt(b.p95)} |
| max (ms) | ${fmt(b.max)} |
| long tasks > 50 ms | ${b.longTasksOver50} |
| long task max (ms) | ${fmt(b.longTaskMaxMs)} |

## Depois (throttle status ≤1/s, updates incrementais, FPS só em SELFTEST/PROFILE, nav coalescido)

| Métrica | Valor |
|---|---|
| amostras | ${a.n} |
| p50 (ms) | ${fmt(a.p50)} |
| p95 (ms) | ${fmt(a.p95)} |
| max (ms) | ${fmt(a.max)} |
| long tasks > 50 ms | ${a.longTasksOver50} |
| long task max (ms) | ${fmt(a.longTaskMaxMs)} |

## Metas

- Nenhum long task > 50 ms (fase after)
- Latência de input p95 < 16–30 ms (fase after: < 30 ms)

Gerado em ${new Date().toISOString()}
`;

  const mdPath = path.join(logDir, 'ui-input-lag.md');
  fs.writeFileSync(mdPath, md, 'utf8');
  console.log('Wrote', mdPath);
  console.log('PASS: check:ui-input-lag');
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
