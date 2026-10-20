'use strict';

/**
 * Roda check:perf e check:security-review em sequência e grava
 * _local/CHECK-1.3.0-<shortsha>.md
 *
 * Uso: npm run check:release
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const localDir = path.join(root, '_local');

function runNode(script, extraArgs = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...extraArgs], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (b) => {
      const s = b.toString();
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => resolve({ code: code || 0, out }));
  });
}

function shortSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|');
}

function buildMarkdown(perf, sec, sha) {
  const lines = [];
  lines.push('# MultiHeiz 1.3.0 — checagem de desempenho e segurança');
  lines.push('');
  lines.push(`- **HEAD:** \`${sha}\``);
  lines.push(`- **Gerado em:** ${new Date().toISOString()}`);
  lines.push('- **Ferramentas:** `npm run check:perf`, `npm run check:security-review`');
  lines.push('');
  lines.push('## Tabela resumo');
  lines.push('');
  lines.push('| Item | Resultado | Status |');
  lines.push('| --- | --- | --- |');

  /** @type {{ item: string, result: string, status: string }[]} */
  const rows = [];

  if (perf && perf.primary) {
    const p = perf.primary;
    rows.push({
      item: 'Desempenho HEAD (startup / RAM / CPU)',
      result: `${p.startupMs} ms / ${p.ramMb} MB / ${p.cpuAvgPct}% (${p.method})`,
      status: 'OK',
    });
  } else {
    rows.push({
      item: 'Desempenho HEAD',
      result: 'sem dados',
      status: 'FALHA',
    });
  }

  if (perf && perf.packaged121 && perf.packaged121.startupMs != null) {
    const p = perf.packaged121;
    rows.push({
      item: 'Desempenho 1.2.1 portable',
      result: `${p.startupMs} ms / ${p.ramMb} MB / ${p.cpuAvgPct}% (${p.method})`,
      status: 'OK',
    });
  } else {
    rows.push({
      item: 'Desempenho 1.2.1 portable',
      result: (perf && perf.packaged121 && perf.packaged121.error) || 'não medido / falhou',
      status: 'ATENÇÃO',
    });
  }

  if (perf && perf.comparisons) {
    for (const c of perf.comparisons) {
      rows.push({
        item: c.name,
        result: c.note || (c.items || []).map((i) => `${i.metric} ${i.pctDiff}%`).join('; '),
        status: c.status,
      });
    }
  }

  if (perf && perf.lag) {
    rows.push({
      item: 'Lag event-loop (lag-audit)',
      result:
        perf.lag.lightMaxLagMs != null
          ? `max light ${perf.lag.lightMaxLagMs} ms (budget ${perf.lag.lightBudgetMs || '?'})`
          : perf.lag.note || perf.lag.status,
      status: perf.lag.status || 'ATENÇÃO',
    });
  }

  if (sec && sec.findings) {
    for (const f of sec.findings) {
      rows.push({
        item: 'Segurança: ' + f.id,
        result: f.result,
        status: f.status,
      });
    }
  }

  for (const r of rows) {
    lines.push(
      `| ${mdEscape(r.item)} | ${mdEscape(r.result)} | **${mdEscape(r.status)}** |`
    );
  }

  lines.push('');
  lines.push('## Números de desempenho');
  lines.push('');
  if (perf && perf.primary) {
    lines.push('### HEAD');
    lines.push('');
    lines.push(`- Método: ${perf.methodNotes ? perf.methodNotes.HEAD : perf.primary.method}`);
    lines.push(`- Startup (1º painel did-finish-load): **${perf.primary.startupMs} ms**`);
    lines.push(`- RAM média (repouso): **${perf.primary.ramMb} MB**`);
    lines.push(`- CPU médio (repouso ${perf.primary.idleMs} ms): **${perf.primary.cpuAvgPct}%**`);
    lines.push('');
  }
  if (perf && perf.packaged121 && perf.packaged121.startupMs != null) {
    lines.push('### 1.2.1 portable');
    lines.push('');
    lines.push(
      `- Método: ${perf.methodNotes ? perf.methodNotes.packaged : perf.packaged121.method}`
    );
    lines.push(`- Startup (janela visível + margem): **${perf.packaged121.startupMs} ms**`);
    lines.push(`- RAM média: **${perf.packaged121.ramMb} MB**`);
    lines.push(`- CPU médio: **${perf.packaged121.cpuAvgPct}%**`);
    lines.push('');
  }
  if (perf && perf.comparisons) {
    lines.push('### Diferenças percentuais (regressão > 15% = FALHA)');
    lines.push('');
    lines.push('| Comparação | Métrica | Atual | Ref | Δ% | Status |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const c of perf.comparisons) {
      if (!c.items) {
        lines.push(
          `| ${mdEscape(c.name)} | — | — | — | — | **${mdEscape(c.status)}** |`
        );
        continue;
      }
      for (const it of c.items) {
        lines.push(
          `| ${mdEscape(c.name)} | ${it.metric} | ${it.current} | ${it.reference} | ${it.pctDiff}% | **${it.status}** |`
        );
      }
    }
    lines.push('');
  }

  lines.push('## Achados de segurança e correções');
  lines.push('');
  if (sec && sec.corrections && sec.corrections.length) {
    lines.push('### Correções aplicadas nesta rodada');
    lines.push('');
    for (const c of sec.corrections) lines.push(`- ${c}`);
    lines.push('');
  } else {
    lines.push('- Nenhuma correção automática necessária nesta rodada (ou já aplicadas).');
    lines.push('');
  }
  if (sec && sec.findings) {
    for (const f of sec.findings) {
      lines.push(`### ${f.id} — ${f.status}`);
      lines.push('');
      lines.push(f.result);
      lines.push('');
      if (f.details && f.details.length) {
        for (const d of f.details) lines.push(`- ${d}`);
        lines.push('');
      }
    }
  }

  lines.push('## Notas de método');
  lines.push('');
  lines.push(
    '- HEAD (`electron .` + `MULTIHEIZ_SELFTEST=perf`): tempo até `did-finish-load` do primeiro painel com página local; RAM/CPU via `app.getAppMetrics` com 3 painéis (1 `<video>` local) em repouso.'
  );
  lines.push(
    '- 1.2.1 portable (sem gancho de teste): tempo até `MainWindowHandle` visível + ~4 s de margem; RAM/CPU via árvore `Get-Process`. Não é o mesmo ponto de medição que did-finish-load — diferenças absolutas devem ser lidas com cautela; Δ% ainda sinaliza regressões grossas.'
  );
  lines.push('- Baseline: `_local/perf-baseline.json` (criado na primeira execução).');
  lines.push('- Lag: `tools/lag-audit.js` (fase check).');
  lines.push('');

  return lines.join('\n');
}

async function main() {
  fs.mkdirSync(localDir, { recursive: true });
  const sha = shortSha();
  console.log('MultiHeiz check:release sha=' + sha);

  console.log('\n######## check:perf ########\n');
  const perfRun = await runNode(path.join(root, 'tools', 'check-perf.js'));

  console.log('\n######## check:security-review ########\n');
  const secRun = await runNode(path.join(root, 'tools', 'check-security.js'));

  const perf = loadJson(path.join(localDir, 'perf-last.json'));
  const sec = loadJson(path.join(localDir, 'security-last.json'));
  const md = buildMarkdown(perf, sec, sha);
  const outPath = path.join(localDir, `CHECK-1.3.0-${sha}.md`);
  fs.writeFileSync(outPath, md, 'utf8');
  console.log('\nRelatório:', outPath);

  // Imprime tabela resumo
  console.log('\n======== RESUMO ========');
  const tableLines = md.split('\n').filter((l) => l.startsWith('|'));
  for (const l of tableLines.slice(0, 40)) console.log(l);

  const failed = perfRun.code !== 0 || secRun.code !== 0;
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});
