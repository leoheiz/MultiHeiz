'use strict';

/**
 * Selftest Planilha — MULTIHEIZ_SELFTEST=sheet
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * @param {object} ctx
 */
async function runSheetSelftest(ctx) {
  const { sleep, rendererEval, waitForLayoutSettle } = ctx;
  const planilha = require('./modules/planilha');
  const phase = String(process.env.MULTIHEIZ_SELFTEST_PHASE || '1');
  const userData = app.getPath('userData');

  console.log('SELFTEST sheet phase=' + phase);

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  function near(a, b, tol = 1) {
    return Math.abs(Number(a) - Number(b)) <= tol;
  }

  if (phase === '2') {
    const list = planilha.listWorkbooks();
    assert(list.length >= 1, 'workbook persisted');
    const wb = planilha.getEvaluatedWorkbook(list[0].id);
    assert(wb, 'load workbook');
    const sh = (wb.sheets || []).find((s) => s.name === 'Aba Renomeada') || wb.sheets[0];
    assert(sh && sh.name === 'Aba Renomeada', 'sheet rename persisted');
    const w0 = planilha.getColWidth(sh, 0);
    assert(w0 >= 120, 'col0 width persisted >=120 got ' + w0);
    console.log('PASS: persistence after restart');
    app.exit(0);
    return;
  }

  // Limpar pastas
  for (const w of planilha.listWorkbooks()) planilha.deleteWorkbook(w.id);

  let wb = planilha.createWorkbook('Pasta Sheet');
  const sheetId = wb.sheets[0].id;
  wb = planilha.applyCellsForTest(wb.id, sheetId, {
    A1: 'CabeçalhoA',
    B1: 'B',
    C1: 'ColunaC',
    A2: 'x',
    A50: 'Linha50',
    B50: 'yy',
    J1: 'JJ',
  });

  // Validação de nome
  const badEmpty = planilha.validateSheetName('  ', wb.sheets, null);
  assert(!badEmpty.ok, 'empty rejected');
  const badDup = planilha.validateSheetName(wb.sheets[0].name, wb.sheets, 'other');
  assert(!badDup.ok, 'dup rejected');
  const badLong = planilha.validateSheetName('x'.repeat(41), wb.sheets, null);
  assert(!badLong.ok, 'too long rejected');
  const badCtrl = planilha.validateSheetName('a\nb', wb.sheets, null);
  assert(!badCtrl.ok, 'control rejected');
  const okName = planilha.validateSheetName('Aba Renomeada', wb.sheets, sheetId);
  assert(okName.ok && okName.name === 'Aba Renomeada', 'valid name');

  const renamed = planilha.renameSheet(wb.id, sheetId, 'Aba Renomeada');
  assert(renamed && renamed.sheets && renamed.sheets[0].name === 'Aba Renomeada', 'rename ok');
  const failRename = planilha.renameSheet(wb.id, sheetId, '');
  assert(failRename && failRename.ok === false, 'empty rename fails');
  console.log('PASS: sheet name validation + rename');

  // Abrir UI
  await rendererEval(`(async () => {
    const ui = window.MultiHeizV16;
    await ui.openModule('planilha');
    await new Promise((r) => setTimeout(r, 300));
    return true;
  })()`);
  await sleep(400);
  await waitForLayoutSettle();

  // Alinhamento cabeçalhos × células
  let align = await rendererEval(`(() => {
    const t = window.MultiHeizV16 && window.MultiHeizV16._planilhaTest;
    return t && t.measureAlign ? t.measureAlign() : null;
  })()`);
  assert(align && align.cols && align.cols.length >= 10, 'measureAlign cols: ' + JSON.stringify(align));
  for (const c of align.cols) {
    assert(near(c.head.x, c.r1.x), `col ${c.col} x head vs r1: ${c.head.x} vs ${c.r1.x}`);
    assert(near(c.head.w, c.r1.w), `col ${c.col} w head vs r1: ${c.head.w} vs ${c.r1.w}`);
    assert(near(c.head.x, c.r50.x), `col ${c.col} x head vs r50`);
    assert(near(c.head.w, c.r50.w), `col ${c.col} w head vs r50`);
  }
  for (const r of align.rows) {
    assert(near(r.head.y, r.cell.y), `row ${r.row} y`);
    assert(near(r.head.h, r.cell.h), `row ${r.row} h`);
  }
  console.log('PASS: header/cell alignment ±1px');

  // Scroll e realinhar
  await rendererEval(`(() => {
    const g = document.querySelector('[data-role="sheet-grid"]');
    if (g) {
      g.scrollLeft = 120;
      g.scrollTop = 200;
    }
    return g ? { l: g.scrollLeft, t: g.scrollTop } : null;
  })()`);
  await sleep(200);
  align = await rendererEval(`(() => {
    const t = window.MultiHeizV16 && window.MultiHeizV16._planilhaTest;
    return t && t.measureAlign ? t.measureAlign() : null;
  })()`);
  assert(align && align.cols.length, 'align after scroll');
  for (const c of align.cols) {
    assert(near(c.head.x, c.r1.x), `scroll col ${c.col} x`);
    assert(near(c.head.w, c.r1.w), `scroll col ${c.col} w`);
  }
  for (const r of align.rows) {
    assert(near(r.head.y, r.cell.y), `scroll row ${r.row} y`);
  }
  console.log('PASS: alignment after scroll');

  // Reset scroll
  await rendererEval(`(() => {
    const g = document.querySelector('[data-role="sheet-grid"]');
    if (g) { g.scrollLeft = 0; g.scrollTop = 0; }
    return true;
  })()`);
  await sleep(100);

  // Redimensionar coluna via simulação
  const resized = await rendererEval(`(async () => {
    const t = window.MultiHeizV16._planilhaTest;
    const before = t.measureAlign().cols[0];
    const w = await t.simulateColResize(0, 40);
    await new Promise((r) => setTimeout(r, 200));
    // re-open to refresh measure after persist (simulateColResize updates local + persist without full remount)
    const after = t.measureAlign().cols[0];
    return { w, before, after };
  })()`);
  assert(resized && resized.w >= 120, 'resized width ' + JSON.stringify(resized));
  assert(
    near(resized.after.head.w, resized.after.r1.w),
    'header+cell same after resize'
  );
  assert(resized.after.head.w > resized.before.head.w + 20, 'width grew');
  console.log('PASS: column resize moves header+cells');

  // Autofit
  await rendererEval(`(async () => {
    const t = window.MultiHeizV16._planilhaTest;
    await t.autofitCol(0);
    await new Promise((r) => setTimeout(r, 300));
    return true;
  })()`);
  await sleep(200);
  // After autofit, module re-rendered — reopen measure
  await rendererEval(`(async () => {
    await window.MultiHeizV16.openModule('planilha');
    await new Promise((r) => setTimeout(r, 200));
    return true;
  })()`);
  await sleep(200);
  const afterFit = await rendererEval(`(() => {
    const t = window.MultiHeizV16._planilhaTest;
    return t.measureAlign().cols[0];
  })()`);
  assert(afterFit && near(afterFit.head.w, afterFit.r1.w), 'autofit still aligned');
  console.log('PASS: autofit column');

  // Renomear aba via UI (inline)
  const renameUi = await rendererEval(`(async () => {
    window.alert = () => {};
    const tab = document.querySelector('[data-role="sheet-tab"]');
    if (!tab) return { ok: false, reason: 'no tab' };
    tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const inp = document.querySelector('[data-role="sheet-tab-rename"]');
    if (!inp) return { ok: false, reason: 'no input' };
    inp.value = 'Aba Renomeada';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const tab2 = document.querySelector('[data-role="sheet-tab"]');
    return { ok: true, text: tab2 ? tab2.textContent : null };
  })()`);
  assert(renameUi && renameUi.ok, 'rename ui: ' + JSON.stringify(renameUi));

  // Validação UI: nome vazio
  const badUi = await rendererEval(`(async () => {
    let alerted = null;
    window.alert = (m) => { alerted = String(m || ''); };
    const t = window.MultiHeizV16._planilhaTest;
    const sh = (await window.multiheiz.planilhaList())[0];
    // get active sheet via DOM
    const tab = document.querySelector('[data-role="sheet-tab"].active') || document.querySelector('[data-role="sheet-tab"]');
    const id = tab && tab.dataset.sheetId;
    const wbList = await window.multiheiz.planilhaList();
    const wb = await window.multiheiz.planilhaGet(wbList[0].id);
    const sheet = (wb.sheets || []).find((s) => s.id === id) || wb.sheets[0];
    const r = await t.renameSheetUi(sheet, '   ');
    return { r, alerted };
  })()`);
  assert(badUi && badUi.r && badUi.r.ok === false, 'empty rename blocked in UI');

  // Ensure width persisted on disk
  const fresh = planilha.loadWorkbook(wb.id);
  const sh = (fresh.sheets || []).find((s) => s.name === 'Aba Renomeada') || fresh.sheets[0];
  // resize may have been overwritten by autofit — ensure a wide col for phase 2
  planilha.setColWidth(wb.id, sh.id, 0, 140);
  const check = planilha.loadWorkbook(wb.id);
  const sh2 = check.sheets.find((s) => s.id === sh.id);
  assert(planilha.getColWidth(sh2, 0) >= 140, 'persisted width on disk');
  // Keep name
  if (sh2.name !== 'Aba Renomeada') {
    planilha.renameSheet(wb.id, sh2.id, 'Aba Renomeada');
  }

  console.log('PASS: sheet phase 1');
  app.exit(0);
}

module.exports = { runSheetSelftest };
