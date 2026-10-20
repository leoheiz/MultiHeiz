'use strict';

/**
 * Captura screenshots dos módulos (perfil descartável, janela oculta).
 * MULTIHEIZ_SELFTEST=shots-tools
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * @param {object} ctx
 */
async function runShotsToolsSelftest(ctx) {
  const { mainWindow, sleep, rendererEval, waitForLayoutSettle } = ctx;
  const notas = require('./modules/notas');
  const alarmes = require('./modules/alarmes');
  const planilha = require('./modules/planilha');

  const outDir =
    process.env.MULTIHEIZ_SHOTS_OUT ||
    path.join(__dirname, '..', '..', '_local', 'shots-tools');
  const phaseEnv = String(process.env.MULTIHEIZ_SHOTS_PHASE || 'all').toLowerCase();
  const modules = String(process.env.MULTIHEIZ_SHOTS_MODULES || 'notas,alarmes,planilha')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let phases =
    phaseEnv === 'all'
      ? ['before', 'after']
      : phaseEnv === 'before' || phaseEnv === 'after'
        ? [phaseEnv]
        : ['after'];
  // Não sobrescrever ANTES já capturados quando phase=all
  if (phases.includes('before') && phaseEnv === 'all') {
    const probe = path.join(outDir, 'before-notas-default.png');
    if (fs.existsSync(probe)) {
      console.log('shots-tools: before-* já existem — pulando fase before (use MULTIHEIZ_SHOTS_PHASE=before para forçar)');
      phases = phases.filter((p) => p !== 'before');
    }
  }

  console.log('SELFTEST shots-tools');
  console.log('outDir:', outDir);
  console.log('phases:', phases.join(','));
  console.log('modules:', modules.join(','));
  fs.mkdirSync(outDir, { recursive: true });

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  function seedSampleData() {
    // Notas (formato antigo v1 — migração cobre no item 1)
    const notes = [
      {
        id: 'note-seed-1',
        title: 'Lista de compras',
        body: 'Pão\nLeite\nCafé\nOvos',
        createdAt: Date.now() - 86400000,
        updatedAt: Date.now() - 3600000,
      },
      {
        id: 'note-seed-2',
        title: '',
        body: 'Ideia rápida para o MultiHeiz\nCores e fixar',
        createdAt: Date.now() - 7200000,
        updatedAt: Date.now() - 7200000,
      },
      {
        id: 'note-seed-3',
        title: 'Reunião',
        body: '## Pauta\n- Status\n- Próximos passos',
        createdAt: Date.now() - 172800000,
        updatedAt: Date.now() - 100000,
      },
    ];
    const notasPath = path.join(app.getPath('userData'), 'modules', 'notas.json');
    fs.mkdirSync(path.dirname(notasPath), { recursive: true });
    fs.writeFileSync(
      notasPath,
      JSON.stringify({ version: 1, notes }, null, 2),
      'utf8'
    );
    notas.load();

    // Limpar lembretes existentes e criar amostra
    for (const r of [...(alarmes.list().reminders || [])]) alarmes.removeReminder(r.id);
    for (const t of [...(alarmes.list().timers || [])]) alarmes.removeTimer(t.id);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 30, 0, 0);
    alarmes.addReminder({
      title: 'Tomar remédio',
      kind: 'recurring',
      recur: 'daily',
      timeOfDay: '08:00',
      priority: 'alta',
    });
    alarmes.addReminder({
      title: 'Stand-up',
      kind: 'recurring',
      recur: 'weekly',
      weekdays: [1, 3, 5],
      timeOfDay: '10:00',
      priority: 'normal',
    });
    alarmes.addReminder({
      title: 'Entregar relatório',
      kind: 'one-off',
      at: tomorrow.getTime(),
      priority: 'normal',
    });
    alarmes.addReminder({
      title: 'Pausa café',
      kind: 'recurring',
      recur: 'interval',
      intervalMinutes: 90,
      at: Date.now() + 30 * 60 * 1000,
      priority: 'baixa',
    });
    alarmes.addTimer({ title: 'Timer exemplo', durationMs: 300000 });
    alarmes.flush();

    // Planilha com conteúdo e várias linhas
    for (const wb of planilha.listWorkbooks()) planilha.deleteWorkbook(wb.id);
    let wb = planilha.createWorkbook('Orçamento');
    const sheet0 = wb.sheets[0];
    wb = planilha.renameSheet(wb.id, sheet0.id, 'Janeiro');
    wb = planilha.addSheet(wb.id, 'Fevereiro');
    const cells = {
      A1: 'Item',
      B1: 'Qtd',
      C1: 'Preço',
      D1: 'Total',
      A2: 'Caderno',
      B2: '3',
      C2: '12.5',
      D2: '=B2*C2',
      A3: 'Caneta',
      B3: '10',
      C3: '2.5',
      D3: '=B3*C3',
      A50: 'Linha 50',
      B50: '1',
      C50: '99',
      D50: '=B50*C50',
      J1: 'Col J',
      J2: 'fim',
    };
    planilha.applyCellsForTest(wb.id, sheet0.id, cells);
    console.log('PASS: sample data seeded');
  }

  async function setWindowSize(w, h) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setMinimumSize(Math.min(800, w), Math.min(500, h));
    } catch {
      /* ignore */
    }
    mainWindow.setSize(w, h);
    await sleep(350);
    await waitForLayoutSettle();
  }

  async function setTheme(preset) {
    await rendererEval(`(() => {
      const ui = window.__multiheizUi;
      if (ui && ui.updateAppearanceLive) {
        ui.updateAppearanceLive({ preset: ${JSON.stringify(preset)} });
      } else {
        document.documentElement.setAttribute('data-theme', ${JSON.stringify(preset)});
      }
      return document.documentElement.getAttribute('data-theme');
    })()`);
    await sleep(200);
  }

  async function openModule(id) {
    await rendererEval(`(async () => {
      const ui = window.MultiHeizV16 || window.__multiheizUi;
      if (!ui || !ui.openModule) return false;
      await ui.openModule(${JSON.stringify(id)});
      return true;
    })()`);
    await sleep(500);
    await waitForLayoutSettle();
  }

  async function captureTo(fileName) {
    const dest = path.join(outDir, fileName);
    // Hidden window: paintWhenInitiallyHidden keeps capturePage working
    const img = await mainWindow.webContents.capturePage();
    const png = img.toPNG();
    fs.writeFileSync(dest, png);
    console.log('SHOT:', dest, `(${png.length} bytes)`);
    assert(fs.existsSync(dest) && fs.statSync(dest).size > 500, 'shot too small: ' + fileName);
    return dest;
  }

  seedSampleData();

  const sizes = [
    { key: 'default', w: 1280, h: 800 },
    { key: 'narrow', w: 800, h: 600 },
  ];

  for (const phase of phases) {
    for (const mod of modules) {
      const moduleId = mod === 'reminders' || mod === 'alarmes' ? 'alarmes' : mod === 'sheet' || mod === 'planilha' ? 'planilha' : 'notas';
      const label = moduleId === 'alarmes' ? 'alarmes' : moduleId === 'planilha' ? 'planilha' : 'notas';

      await openModule(moduleId);

      for (const sz of sizes) {
        await setWindowSize(sz.w, sz.h);
        await sleep(200);
        await captureTo(`${phase}-${label}-${sz.key}.png`);

        if (phase === 'after' && label === 'notas') {
          await setTheme('claro');
          await sleep(150);
          await captureTo(`${phase}-${label}-${sz.key}-claro.png`);
          await setTheme('escuro');
          await sleep(150);
          await captureTo(`${phase}-${label}-${sz.key}-escuro.png`);
        }
      }
    }
  }

  await rendererEval(`(() => {
    const ui = window.MultiHeizV16;
    if (ui && ui.closeModule) ui.closeModule();
    return true;
  })()`);

  console.log('PASS: shots-tools complete');
  app.exit(0);
}

module.exports = { runShotsToolsSelftest };
