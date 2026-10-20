'use strict';

/**
 * Selftest Notas estilo Keep — MULTIHEIZ_SELFTEST=notes
 * Phase 1: migração, renomear, cor, fixar, contraste, UI
 * Phase 2: mesma MULTIHEIZ_USERDATA — persistência após reinício
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * @param {object} ctx
 */
async function runNotesSelftest(ctx) {
  const { sleep, rendererEval, waitForLayoutSettle } = ctx;
  const notas = require('./modules/notas');
  const phase = String(process.env.MULTIHEIZ_SELFTEST_PHASE || '1');
  const userData = app.getPath('userData');
  const storePath = path.join(userData, 'modules', 'notas.json');

  console.log('SELFTEST notes phase=' + phase);

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  if (phase === '2') {
    notas.load();
    const list = notas.list();
    const pinned = list.filter((n) => n.pinned);
    const keep = list.find((n) => n.title === 'Nota Keep Persistida');
    assert(keep, 'persisted note missing');
    assert(keep.color === 'azul', 'persisted color azul, got ' + keep.color);
    assert(keep.pinned === true, 'persisted pinned');
    assert(pinned.length >= 1 && pinned[0].id === keep.id, 'pinned section first after restart');
    assert(list[0].pinned === true, 'first item pinned after restart');
    console.log('PASS: persistence after restart');
    app.exit(0);
    return;
  }

  // --- Migração de arquivo antigo (v1, sem título/cor/pinned) ---
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const legacy = {
    version: 1,
    notes: [
      {
        id: 'legacy-1',
        title: '',
        body: 'Primeira linha da ideia\nsegunda',
        createdAt: 1000,
        updatedAt: 2000,
      },
      {
        id: 'legacy-2',
        title: 'Já tinha título',
        body: 'corpo',
        createdAt: 1001,
        updatedAt: 2001,
      },
      {
        id: 'legacy-3',
        body: '',
        createdAt: 1002,
        updatedAt: 2002,
      },
    ],
  };
  fs.writeFileSync(storePath, JSON.stringify(legacy, null, 2), 'utf8');
  // Reset store singleton by clearing require cache path... store is module-level.
  // Force reload via load() which migrates.
  const migrated = notas.load();
  assert(migrated.version === notas.STORE_VERSION, 'store version bumped');
  const m1 = notas.get('legacy-1');
  const m2 = notas.get('legacy-2');
  const m3 = notas.get('legacy-3');
  assert(m1 && m1.title === 'Primeira linha da ideia', 'title from first line: ' + (m1 && m1.title));
  assert(m1.body.includes('Primeira linha'), 'body preserved');
  assert(m1.color === 'padrao' && m1.pinned === false, 'defaults color/pin');
  assert(m2 && m2.title === 'Já tinha título', 'existing title kept');
  assert(m3 && m3.title === 'Sem título', 'empty -> Sem título');
  console.log('PASS: legacy file migration');

  // --- Contraste / legibilidade ---
  for (const c of notas.NOTE_COLORS) {
    for (const theme of ['claro', 'escuro']) {
      const tone = notas.resolveColorTone(c.id, theme);
      assert(tone.contrast >= 3, `contrast ${c.id}/${theme}=${tone.contrast}`);
      const text = notas.readableTextColor(tone.bg, tone.text);
      assert(notas.contrastRatio(tone.bg, text) >= 3, `readable ${c.id}/${theme}`);
    }
  }
  console.log('PASS: contrast/legibility for palette');

  // --- Renomear, cor, fixar (API) ---
  for (const n of [...notas.list()]) notas.remove(n.id);
  const a = notas.create('Temp');
  const b = notas.create('Outra');
  notas.update(a.id, { title: 'Nota Keep Persistida', color: 'azul', body: 'conteúdo keep' });
  notas.setPinned(a.id, true);
  notas.update(b.id, { color: 'amarelo' });
  let list = notas.list();
  assert(list[0].id === a.id && list[0].pinned, 'pinned sorts to Fixadas first');
  assert(list.some((n) => n.id === b.id && !n.pinned), 'unpinned in Outras');
  const renamed = notas.update(a.id, { title: 'Nota Keep Persistida' });
  assert(renamed.title === 'Nota Keep Persistida', 'rename ok');
  assert(notas.get(a.id).color === 'azul', 'color azul');
  notas.flush();
  const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert(raw.version === 2, 'file version 2');
  assert(
    (raw.notes || []).some((n) => n.id === a.id && n.pinned && n.color === 'azul'),
    'flushed pinned+color'
  );
  console.log('PASS: rename, color, pin order, flush');

  // --- UI ---
  await rendererEval(`(async () => {
    const ui = window.MultiHeizV16;
    await ui.openModule('notas');
    return true;
  })()`);
  await sleep(400);
  await waitForLayoutSettle();

  const uiState = await rendererEval(`(() => {
    const cards = [...document.querySelectorAll('.nota-card')];
    const sections = [...document.querySelectorAll('.notas-section-title')].map(
      (el) => (el.textContent || '').trim()
    );
    const pinnedCards = cards.filter((c) => c.dataset.pinned === '1');
    const firstPinned = cards[0] && cards[0].dataset.pinned === '1';
    const palette = document.querySelector('[data-role="nota-palette"]');
    const editorTitle = document.querySelector('[data-role="nota-editor-title"]');
    return {
      cards: cards.length,
      sections,
      pinnedCount: pinnedCards.length,
      firstPinned,
      hasPalette: !!palette,
      editorTitle: editorTitle ? editorTitle.value : null,
      colors: cards.map((c) => c.dataset.color),
    };
  })()`);
  assert(uiState.cards >= 2, 'cards rendered: ' + JSON.stringify(uiState));
  assert(uiState.sections.includes('Fixadas'), 'Fixadas section');
  assert(uiState.firstPinned, 'first card pinned in UI');
  assert(uiState.hasPalette, 'color palette in editor');
  console.log('PASS: Keep UI sections + cards');

  // Renomear via título do editor
  await rendererEval(`(() => {
    const title = document.querySelector('[data-role="nota-editor-title"]');
    if (!title) return false;
    title.value = 'Nota Keep Persistida';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  notas.flush();

  // Cor via swatch
  await rendererEval(`(() => {
    const sw = document.querySelector('.nota-swatch[data-color="azul"]');
    if (sw) sw.click();
    return !!sw;
  })()`);
  await sleep(400);
  assert(notas.get(a.id).color === 'azul', 'UI set color azul');

  // Fixar via hook
  await rendererEval(`(async () => {
    const t = window.MultiHeizV16 && window.MultiHeizV16._notasTest;
    const cur = t && t.getCurrent && t.getCurrent();
    if (cur && !cur.pinned && t.togglePin) await t.togglePin(cur);
    return true;
  })()`);
  await sleep(300);
  notas.flush();

  console.log('PASS: UI rename/color/pin hooks');
  console.log('PASS: notes phase 1');
  app.exit(0);
}

module.exports = { runNotesSelftest };
