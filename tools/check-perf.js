'use strict';

/**
 * Checagem de desempenho reutilizável.
 * Uso: npm run check:perf [-- --exe <caminho> --label <nome>]
 *
 * - Sem --exe: mede HEAD via `electron .` + MULTIHEIZ_SELFTEST=perf (média de 3).
 * - Com --exe: mide build empacotado (sem gancho → janela visível + árvore Get-Process).
 * - Compara com releases/1.2.1/*portable*.exe e _local/perf-baseline.json.
 * - Reaproveita lag-audit (fase check) quando disponível.
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const localDir = path.join(root, '_local');
const baselinePath = path.join(localDir, 'perf-baseline.json');
const lastPath = path.join(localDir, 'perf-last.json');
const REGRESSION_PCT = 15;
const RUNS = 3;
// Padrão 30s; MULTIHEIZ_PERF_IDLE_MS só se for número finito >= 5000
const IDLE_MS = (() => {
  const n = Number(process.env.MULTIHEIZ_PERF_IDLE_MS);
  if (Number.isFinite(n) && n >= 5000) return Math.floor(n);
  return 30000;
})();

function parseArgs(argv) {
  /** @type {{ exe: string|null, label: string|null, skipLag: boolean, skipBaseline121: boolean }} */
  const out = { exe: null, label: null, skipLag: false, skipBaseline121: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--exe' && argv[i + 1]) {
      out.exe = argv[++i];
    } else if (a.startsWith('--exe=')) {
      out.exe = a.slice(6);
    } else if (a === '--label' && argv[i + 1]) {
      out.label = argv[++i];
    } else if (a.startsWith('--label=')) {
      out.label = a.slice(8);
    } else if (a === '--skip-lag') {
      out.skipLag = true;
    } else if (a === '--skip-1.2.1') {
      out.skipBaseline121 = true;
    }
  }
  return out;
}

function avg(nums) {
  const xs = nums.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pctDiff(cur, base) {
  if (base == null || base === 0 || cur == null) return null;
  return ((cur - base) / Math.abs(base)) * 100;
}

function statusForPct(pct, higherIsWorse) {
  if (pct == null) return 'ATENÇÃO';
  const worse = higherIsWorse ? pct > REGRESSION_PCT : pct < -REGRESSION_PCT;
  if (worse) return 'FALHA';
  // Atenção só se aproximar de regressão (melhorias grandes = OK)
  const nearWorse = higherIsWorse
    ? pct > REGRESSION_PCT * 0.66
    : pct < -REGRESSION_PCT * 0.66;
  if (nearWorse) return 'ATENÇÃO';
  return 'OK';
}

function findPortable121() {
  const dir = path.join(root, 'releases', '1.2.1');
  if (!fs.existsSync(dir)) return null;
  const hits = fs
    .readdirSync(dir)
    .filter((n) => /portable/i.test(n) && /\.exe$/i.test(n))
    .map((n) => path.join(dir, n));
  return hits[0] || null;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts
 */
function spawnCapture(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    let out = '';
    const onData = (buf) => {
      const s = buf.toString();
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      try {
        killTree(child.pid);
      } catch {
        /* ignore */
      }
      reject(new Error('timeout: ' + cmd));
    }, opts.timeoutMs || 300000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, pid: child.pid });
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Soma WorkingSet da árvore do PID + processos MultiHeiz* (portable SFX).
 * @param {number} rootPid
 */
function sampleProcessTree(rootPid) {
  if (process.platform !== 'win32') {
    return { ramMb: null, cpuPct: null, count: 0 };
  }
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$root=${Number(rootPid) || 0}`,
    '$ids=New-Object System.Collections.Generic.HashSet[int]',
    'if($root -gt 0){ $q=[System.Collections.Generic.Queue[int]]::new(); $q.Enqueue($root); while($q.Count -gt 0){ $p=$q.Dequeue(); if(-not $ids.Add($p)){continue}; Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" | ForEach-Object { $q.Enqueue([int]$_.ProcessId) } } }',
    "Get-Process | Where-Object { $_.ProcessName -like 'MultiHeiz*' } | ForEach-Object { [void]$ids.Add([int]$_.Id) }",
    '$ram=0L; $cpu=0.0; $n=0',
    'foreach($id in $ids){ $proc=Get-Process -Id $id -ErrorAction SilentlyContinue; if($proc){ $ram+=[int64]$proc.WorkingSet64; if($proc.CPU){$cpu+=[double]$proc.CPU}; $n++ } }',
    'Write-Output ("RAM=$ram;CPU=$cpu;N=$n")',
  ].join('; ');
  try {
    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', ps],
      { encoding: 'utf8', timeout: 20000 }
    ).trim();
    const m = /RAM=(\d+);CPU=([\d.]+);N=(\d+)/.exec(raw);
    if (!m) return { ramMb: null, cpuPct: null, count: 0 };
    const ramBytes = Number(m[1]);
    return {
      ramMb: ramBytes > 0 ? Math.round((ramBytes / (1024 * 1024)) * 10) / 10 : null,
      cpuRaw: Number(m[2]),
      count: Number(m[3]),
    };
  } catch {
    return { ramMb: null, cpuPct: null, count: 0 };
  }
}

/**
 * Espera janela MultiHeiz visível (MainWindowHandle != 0).
 * Portable SFX: processos filhos podem não ficar na árvore do launcher — busca por nome.
 * @param {number} _rootPid
 * @param {number} timeoutMs
 */
function waitForVisibleWindow(_rootPid, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (process.platform !== 'win32') {
      break;
    }
    const ps =
      "$ErrorActionPreference='SilentlyContinue'; " +
      "$found=$false; " +
      "Get-Process | Where-Object { $_.ProcessName -like 'MultiHeiz*' } | ForEach-Object { " +
      "  if ($_.MainWindowHandle -ne 0) { $found=$true } " +
      "}; " +
      "if ($found) { 'VISIBLE' } else { 'NO' }";
    try {
      const raw = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', ps],
        { encoding: 'utf8', timeout: 15000 }
      ).trim();
      if (raw.includes('VISIBLE')) return Date.now() - t0;
    } catch {
      /* ignore */
    }
    const wake = Date.now() + 500;
    while (Date.now() < wake) {
      /* spin */
    }
  }
  return Date.now() - t0;
}

/** Encerra processos MultiHeiz* (portable) além da árvore do launcher. */
function killMultiHeizProcesses() {
  if (process.platform !== 'win32') return;
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-Process | Where-Object { $_.ProcessName -like 'MultiHeiz*' } | Stop-Process -Force -ErrorAction SilentlyContinue",
      ],
      { encoding: 'utf8', timeout: 15000 }
    );
  } catch {
    /* ignore */
  }
}

/**
 * Mede build empacotado sem gancho de selftest.
 * Método: spawn → janela visível (MainWindowHandle) + amostras Get-Process 30s.
 */
async function measurePackagedExternal(exePath, label) {
  const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-perf-pkg-'));
  const t0 = Date.now();
  // stdio ignore: pipes no portable SFX/Electron às vezes atrasam UI
  const child = spawn(exePath, [], {
    cwd: path.dirname(exePath),
    env: {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
    },
    stdio: 'ignore',
    windowsHide: false,
  });

  const visibleMs = waitForVisibleWindow(child.pid, 120000);
  const timedOut = visibleMs >= 119000;
  // margem para 1º painel carregar (sem hook — estimativa externa)
  await new Promise((r) => setTimeout(r, 4000));
  const startupMs = Date.now() - t0;

  const ramSamples = [];
  const cpuSamples = [];
  let lastCpuRaw = null;
  const idleStart = Date.now();
  while (Date.now() - idleStart < IDLE_MS) {
    const s = sampleProcessTree(child.pid);
    if (s.ramMb != null && s.ramMb > 0) ramSamples.push(s.ramMb);
    if (s.cpuRaw != null && lastCpuRaw != null) {
      const delta = s.cpuRaw - lastCpuRaw;
      const cores = os.cpus().length || 1;
      const pct = (delta / 1) * (100 / cores);
      cpuSamples.push(Math.max(0, pct));
    }
    lastCpuRaw = s.cpuRaw;
    await new Promise((r) => setTimeout(r, 1000));
  }

  try {
    killTree(child.pid);
  } catch {
    /* ignore */
  }
  killMultiHeizProcesses();
  await new Promise((r) => setTimeout(r, 800));
  try {
    fs.rmSync(userdata, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  return {
    method: 'external-window-visible+Get-Process',
    methodNote:
      'Build sem MULTIHEIZ_SELFTEST: startup = spawn→MainWindowHandle MultiHeiz* +~4s margem; RAM/CPU via Get-Process (nome MultiHeiz*). Não é did-finish-load.',
    label,
    startupMs,
    firstPanelDidFinishLoadMs: null,
    winVisibleMs: visibleMs,
    visibleTimedOut: timedOut,
    ramMb: avg(ramSamples),
    cpuAvgPct: avg(cpuSamples),
    idleMs: IDLE_MS,
    samples: ramSamples.length,
    panels: null,
    videoPanels: null,
    at: new Date().toISOString(),
  };
}

/**
 * Uma execução HEAD (electron . + selftest perf).
 */
async function measureDevOnce(label) {
  const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-perf-'));
  const t0 = Date.now();
  const env = {
    ...process.env,
    MULTIHEIZ_USERDATA: userdata,
    MULTIHEIZ_SELFTEST: 'perf',
    MULTIHEIZ_PERF_T0: String(t0),
    MULTIHEIZ_PERF_LABEL: label,
    MULTIHEIZ_PERF_IDLE_MS: String(IDLE_MS),
    MULTIHEIZ_UI_WIDTH: '1400',
    MULTIHEIZ_UI_HEIGHT: '900',
    MULTIHEIZ_MENU_INTERCEPT: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  };
  const { code, out } = await spawnCapture(electronBin, ['.'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: IDLE_MS + 120000,
  });
  try {
    fs.rmSync(userdata, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const m = /PERF_JSON=(\{.*\})/m.exec(out);
  if (!m) {
    throw new Error('PERF_JSON não encontrado (exit=' + code + ')');
  }
  const parsed = JSON.parse(m[1]);
  if (code !== 0) {
    throw new Error('selftest perf exit ' + code);
  }
  return parsed;
}

async function averageRuns(runFn, label, runs) {
  const results = [];
  for (let i = 0; i < runs; i++) {
    console.log(`\n=== ${label} run ${i + 1}/${runs} ===`);
    const r = await runFn(label);
    results.push(r);
    console.log(
      `  startup=${r.startupMs}ms ram=${r.ramMb}MB cpu=${r.cpuAvgPct}% method=${r.method}`
    );
  }
  const startupMs = avg(results.map((r) => r.startupMs));
  const ramMb = avg(results.map((r) => r.ramMb));
  const cpuAvgPct = avg(results.map((r) => r.cpuAvgPct));
  return {
    label,
    method: results[0] && results[0].method,
    methodNote: results[0] && results[0].methodNote,
    runs: results.length,
    startupMs: startupMs != null ? Math.round(startupMs) : null,
    winVisibleMs: avg(results.map((r) => r.winVisibleMs)),
    ramMb: ramMb != null ? Math.round(ramMb * 10) / 10 : null,
    cpuAvgPct: cpuAvgPct != null ? Math.round(cpuAvgPct * 10) / 10 : null,
    idleMs: IDLE_MS,
    individual: results,
  };
}

async function runLagAuditSummary() {
  const lagTool = path.join(root, 'tools', 'lag-audit.js');
  if (!fs.existsSync(lagTool)) {
    return { status: 'ATENÇÃO', note: 'tools/lag-audit.js ausente' };
  }
  console.log('\n=== lag-audit (fase check) ===');
  try {
    const { code, out } = await spawnCapture(process.execPath, [lagTool], {
      cwd: root,
      env: {
        ...process.env,
        MULTIHEIZ_LAG_PHASE: 'check',
        ELECTRON_ENABLE_LOGGING: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: 360000,
    });
    const jsonPath = path.join(localDir, 'lag-audit-results-check.json');
    let summary = { status: code === 0 ? 'OK' : 'FALHA', exitCode: code };
    if (fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const light = (data.rows || []).filter((r) => r.kind === 'light');
      const maxLag = light.length
        ? Math.max(...light.map((r) => Number(r.maxLagMs) || 0))
        : null;
      const meanLag = light.length
        ? avg(light.map((r) => Number(r.meanLagMs) || 0))
        : null;
      summary = {
        ...summary,
        lightMaxLagMs: maxLag,
        lightMeanLagMs: meanLag != null ? Math.round(meanLag * 10) / 10 : null,
        lightBudgetMs: data.lightBudgetMs,
        softTargetMs: data.softTargetMs,
        pass: data.pass,
        status:
          code === 0 && data.pass !== false
            ? maxLag != null && maxLag > (data.lightBudgetMs || 100)
              ? 'FALHA'
              : 'OK'
            : 'FALHA',
      };
    }
    void out;
    return summary;
  } catch (err) {
    return { status: 'FALHA', note: String(err && err.message ? err.message : err) };
  }
}

function compareBlock(name, current, reference) {
  if (!current || !reference) {
    return {
      name,
      status: 'ATENÇÃO',
      note: !reference ? 'referência ausente' : 'atual ausente',
    };
  }
  const items = [];
  for (const [key, worseHigh] of [
    ['startupMs', true],
    ['ramMb', true],
    ['cpuAvgPct', true],
  ]) {
    const cur = current[key];
    const base = reference[key];
    const pct = pctDiff(cur, base);
    items.push({
      metric: key,
      current: cur,
      reference: base,
      pctDiff: pct != null ? Math.round(pct * 10) / 10 : null,
      status: statusForPct(pct, worseHigh),
    });
  }
  const worst = items.some((i) => i.status === 'FALHA')
    ? 'FALHA'
    : items.some((i) => i.status === 'ATENÇÃO')
      ? 'ATENÇÃO'
      : 'OK';
  return { name, status: worst, items };
}

async function main() {
  fs.mkdirSync(localDir, { recursive: true });
  const args = parseArgs(process.argv.slice(2));
  const primaryLabel = args.label || (args.exe ? path.basename(args.exe) : 'HEAD');

  console.log('MultiHeiz check:perf');
  console.log('idleMs=', IDLE_MS, 'runs=', RUNS);

  let primary;
  if (args.exe) {
    if (!fs.existsSync(args.exe)) {
      throw new Error('exe não encontrado: ' + args.exe);
    }
    primary = await averageRuns(
      (label) => measurePackagedExternal(args.exe, label),
      primaryLabel,
      RUNS
    );
  } else {
    primary = await averageRuns(measureDevOnce, primaryLabel, RUNS);
  }

  let packaged121 = null;
  if (!args.skipBaseline121 && !args.exe) {
    const exe121 = findPortable121();
    if (exe121) {
      console.log('\n=== comparar 1.2.1 portable (somente leitura) ===');
      console.log(exe121);
      try {
        packaged121 = await averageRuns(
          (label) => measurePackagedExternal(exe121, label),
          '1.2.1-portable',
          RUNS
        );
      } catch (err) {
        console.warn('WARN: falha ao medir 1.2.1:', err.message);
        packaged121 = {
          label: '1.2.1-portable',
          error: err.message,
          method: 'external-failed',
        };
      }
    } else {
      console.warn('WARN: portable 1.2.1 não encontrado em releases/1.2.1');
    }
  }

  let lag = { status: 'ATENÇÃO', note: 'pulado' };
  if (!args.skipLag && !args.exe) {
    lag = await runLagAuditSummary();
  }

  let baseline = null;
  if (fs.existsSync(baselinePath)) {
    try {
      baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    } catch {
      baseline = null;
    }
  }

  const comparisons = [];
  if (
    packaged121 &&
    packaged121.startupMs != null &&
    packaged121.ramMb > 0 &&
    !(packaged121.individual || []).every((r) => r.visibleTimedOut)
  ) {
    // Métodos diferentes (selftest 3 painéis+vídeo vs cold-start portable):
    // startup é comparável com cautela; RAM/CPU não — no máximo ATENÇÃO.
    const cross = compareBlock('HEAD vs 1.2.1', primary, packaged121);
    cross.note =
      'Métodos distintos: HEAD=selftest-perf (3 painéis+vídeo, getAppMetrics); 1.2.1=janela visível+Get-Process (carga default). RAM Δ alto é esperado e não conta como regressão dura.';
    if (cross.items) {
      for (const it of cross.items) {
        if (it.metric === 'ramMb' || it.metric === 'cpuAvgPct') {
          if (it.status === 'FALHA') it.status = 'ATENÇÃO';
        }
      }
      cross.status = cross.items.some((i) => i.status === 'FALHA')
        ? 'FALHA'
        : cross.items.some((i) => i.status === 'ATENÇÃO')
          ? 'ATENÇÃO'
          : 'OK';
    }
    comparisons.push(cross);
  } else {
    comparisons.push({
      name: 'HEAD vs 1.2.1',
      status: 'ATENÇÃO',
      note:
        (packaged121 && packaged121.error) ||
        'Medição 1.2.1 incompleta ou timeout de janela; compare ao menos startup/RAM/CPU do HEAD e documente método externo vs did-finish-load.',
      items:
        packaged121 && packaged121.startupMs != null && primary
          ? [
              {
                metric: 'startupMs',
                current: primary.startupMs,
                reference: packaged121.startupMs,
                pctDiff:
                  pctDiff(primary.startupMs, packaged121.startupMs) != null
                    ? Math.round(pctDiff(primary.startupMs, packaged121.startupMs) * 10) / 10
                    : null,
                status: 'ATENÇÃO',
              },
            ]
          : undefined,
    });
  }
  const baselineCompatible =
    baseline &&
    baseline.primary &&
    Number(baseline.idleMs || 0) === IDLE_MS &&
    baseline.primary.method === primary.method;
  if (baselineCompatible) {
    comparisons.push(compareBlock('HEAD vs baseline', primary, baseline.primary));
  } else if (baseline && baseline.primary) {
    comparisons.push({
      name: 'HEAD vs baseline',
      status: 'ATENÇÃO',
      note:
        'Baseline anterior incompatível (idleMs/method). Será atualizado com o resultado atual.',
      items: compareBlock('HEAD vs baseline', primary, baseline.primary).items,
    });
  } else {
    comparisons.push({
      name: 'HEAD vs baseline',
      status: 'OK',
      note: 'baseline ausente — será criado com resultado atual',
    });
  }

  const report = {
    at: new Date().toISOString(),
    shortSha: (() => {
      try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
        }).trim();
      } catch {
        return 'unknown';
      }
    })(),
    primary,
    packaged121,
    lag,
    comparisons,
    regressionThresholdPct: REGRESSION_PCT,
    methodNotes: {
      HEAD: 'MULTIHEIZ_SELFTEST=perf — startup até did-finish-load do 1º painel local; RAM/CPU via app.getAppMetrics em repouso.',
      packaged:
        'Sem gancho: spawn → MainWindowHandle visível + ~4s; RAM/CPU via Get-Process na árvore. Diferenças de método documentadas na comparação.',
    },
  };

  fs.writeFileSync(lastPath, JSON.stringify(report, null, 2), 'utf8');

  const shouldWriteBaseline =
    !baseline ||
    Number(baseline.idleMs || 0) !== IDLE_MS ||
    (baseline.primary && baseline.primary.method !== primary.method);
  if (shouldWriteBaseline) {
    const fresh = {
      createdAt: report.at,
      updatedAt: report.at,
      shortSha: report.shortSha,
      idleMs: IDLE_MS,
      primary: {
        label: primary.label,
        startupMs: primary.startupMs,
        ramMb: primary.ramMb,
        cpuAvgPct: primary.cpuAvgPct,
        method: primary.method,
      },
      note: baseline
        ? 'Checkpoint atualizado (idleMs/method alinhados ao check:perf atual)'
        : 'Checkpoint inicial criado por check:perf',
    };
    fs.writeFileSync(baselinePath, JSON.stringify(fresh, null, 2), 'utf8');
    console.log((baseline ? 'Atualizado' : 'Criado') + ' baseline:', baselinePath);
    report.baselineCreated = !baseline;
    report.baselineUpdated = !!baseline;
  } else {
    report.baselineCreated = false;
    report.baselineUpdated = false;
  }

  // Exit ≠ 0 só em regressão dura (FALHA) no mesmo método, ou lag/security via check:release
  const hardFail =
    comparisons.some((c) => c.status === 'FALHA' && !/1\.2\.1/.test(c.name)) ||
    lag.status === 'FALHA';

  console.log('\n--- resumo check:perf ---');
  console.log(
    `HEAD startup=${primary.startupMs}ms ram=${primary.ramMb}MB cpu=${primary.cpuAvgPct}%`
  );
  if (packaged121 && packaged121.startupMs != null) {
    console.log(
      `1.2.1 startup=${packaged121.startupMs}ms ram=${packaged121.ramMb}MB cpu=${packaged121.cpuAvgPct}%`
    );
  }
  for (const c of comparisons) {
    console.log(`${c.name}: ${c.status}` + (c.note ? ' (' + c.note + ')' : ''));
    if (c.items) {
      for (const it of c.items) {
        console.log(
          `  ${it.metric}: ${it.current} vs ${it.reference} (${it.pctDiff}%) [${it.status}]`
        );
      }
    }
  }
  console.log('lag-audit:', lag.status, lag.lightMaxLagMs != null ? 'maxLight=' + lag.lightMaxLagMs + 'ms' : '');
  console.log('escrito:', lastPath);

  process.exitCode = hardFail ? 1 : 0;
}

main().catch((err) => {
  console.error('FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});
