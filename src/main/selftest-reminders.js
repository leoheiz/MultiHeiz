'use strict';

/**
 * Selftest Alarmes/Lembretes layout — MULTIHEIZ_SELFTEST=reminders
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * @param {object} ctx
 */
async function runRemindersSelftest(ctx) {
  const { mainWindow, sleep, rendererEval, waitForLayoutSettle } = ctx;
  const alarmes = require('./modules/alarmes');
  const phase = String(process.env.MULTIHEIZ_SELFTEST_PHASE || '1');
  const userData = app.getPath('userData');

  console.log('SELFTEST reminders phase=' + phase);

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  if (phase === '2') {
    const list = alarmes.list().reminders || [];
    const found = list.find((r) => r.title === 'Lembrete Persistido UI');
    assert(found, 'persisted reminder missing');
    assert(found.enabled !== false, 'persisted enabled');
    assert(found.kind === 'recurring' && found.recur === 'weekly', 'persisted weekly');
    console.log('PASS: persistence after restart');
    app.exit(0);
    return;
  }

  // Limpar
  for (const r of [...(alarmes.list().reminders || [])]) alarmes.removeReminder(r.id);
  for (const t of [...(alarmes.list().timers || [])]) alarmes.removeTimer(t.id);
  alarmes.flush();

  await rendererEval(`(async () => {
    const ui = window.MultiHeizV16;
    await ui.openModule('alarmes');
    return true;
  })()`);
  await sleep(400);
  await waitForLayoutSettle();

  // Garantir 800x600
  try {
    mainWindow.setMinimumSize(800, 500);
    mainWindow.setSize(800, 600);
  } catch {
    /* ignore */
  }
  await sleep(300);
  await waitForLayoutSettle();

  // Criar via formulário UI (gancho)
  const created = await rendererEval(`(async () => {
    const form = document.querySelector('[data-role="alarmes-form"]');
    if (!form) return { ok: false, reason: 'no form' };
    const title = form.querySelector('[data-field="title"]');
    const kind = form.querySelector('[data-field="kindMode"]');
    const time = form.querySelector('[data-field="time"]');
    title.value = 'Lembrete Persistido UI';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    kind.value = 'weekly';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    time.value = '10:30';
    time.dispatchEvent(new Event('input', { bubbles: true }));
    // Seg, Qua, Sex
    for (const d of [1, 3, 5]) {
      const cb = form.querySelector('[data-weekday="' + d + '"]');
      if (cb) cb.checked = true;
    }
    for (const d of [0, 2, 4, 6]) {
      const cb = form.querySelector('[data-weekday="' + d + '"]');
      if (cb) cb.checked = false;
    }
    const t = window.MultiHeizV16._alarmesTest;
    const r = t && t.submitForm ? await t.submitForm() : { ok: false };
    return r;
  })()`);
  assert(created && created.ok, 'create via form: ' + JSON.stringify(created));
  await sleep(400);

  let rem = (alarmes.list().reminders || []).find((r) => r.title === 'Lembrete Persistido UI');
  assert(rem, 'reminder created in store');
  assert(
    Array.isArray(rem.weekdays) && rem.weekdays.includes(1) && rem.weekdays.includes(5),
    'weekdays Seg/Sex'
  );
  console.log('PASS: create via UI form');

  // Vista recorrentes para ver o item
  await rendererEval(`(() => {
    const t = window.MultiHeizV16._alarmesTest;
    if (t) t.setView('recorrentes');
    return window.MultiHeizV16.openModule('alarmes');
  })()`);
  await sleep(400);

  // Checagem de layout DOM
  const layout = await rendererEval(`(() => {
    const list = document.querySelector('[data-role="alarmes-list"]');
    const form = document.querySelector('[data-role="alarmes-form"]');
    function overflowKids(root) {
      if (!root) return [];
      const bad = [];
      const seen = new Set();
      const check = (el) => {
        if (!el || seen.has(el)) return;
        seen.add(el);
        if (el.scrollWidth > el.clientWidth + 1) {
          bad.push({
            tag: el.tagName,
            cls: typeof el.className === 'string' ? el.className : '',
            sw: el.scrollWidth,
            cw: el.clientWidth,
          });
        }
      };
      check(root);
      for (const el of root.children) check(el);
      for (const el of root.querySelectorAll('.alarmes-item, .alarmes-form-grid, .alarmes-item-actions, .alarmes-item-main, .alarmes-item-meta')) {
        check(el);
      }
      return bad;
    }
    function overlaps(a, b) {
      return !(
        a.right <= b.left ||
        a.left >= b.right ||
        a.bottom <= b.top ||
        a.top >= b.bottom
      );
    }
    const items = [...document.querySelectorAll('[data-role="alarmes-item"]')];
    const rowIssues = [];
    for (const row of items) {
      const main = row.querySelector('.alarmes-item-main');
      const actions = row.querySelector('.alarmes-item-actions');
      if (!main || !actions) continue;
      const ctrls = [...actions.children].map((el) => el.getBoundingClientRect());
      for (let i = 0; i < ctrls.length; i++) {
        for (let j = i + 1; j < ctrls.length; j++) {
          if (overlaps(ctrls[i], ctrls[j])) {
            rowIssues.push({ id: row.dataset.id, i, j, type: 'overlap' });
          }
        }
      }
      // vertical alignment of controls (centers within 8px)
      if (ctrls.length >= 2) {
        const mids = ctrls.map((r) => (r.top + r.bottom) / 2);
        const avg = mids.reduce((a, b) => a + b, 0) / mids.length;
        for (const m of mids) {
          if (Math.abs(m - avg) > 8) rowIssues.push({ id: row.dataset.id, type: 'valign', m, avg });
        }
      }
    }
    const recurText = items.map((el) => {
      const r = el.querySelector('.alarmes-item-recur');
      return r ? (r.textContent || '').trim() : '';
    });
    return {
      listOverflow: overflowKids(list),
      formOverflow: overflowKids(form),
      rowIssues,
      itemCount: items.length,
      recurText,
      viewsHorizontal: (() => {
        const v = document.querySelector('[data-role="alarmes-views"]');
        if (!v) return false;
        const cs = getComputedStyle(v);
        return cs.display === 'flex' && cs.flexDirection !== 'column';
      })(),
    };
  })()`);

  assert(layout.itemCount >= 1, 'items visible: ' + JSON.stringify(layout));
  assert(layout.viewsHorizontal, 'views should be horizontal flex');
  assert(
    layout.listOverflow.length === 0,
    'list overflow: ' + JSON.stringify(layout.listOverflow.slice(0, 5))
  );
  assert(
    layout.formOverflow.length === 0,
    'form overflow: ' + JSON.stringify(layout.formOverflow.slice(0, 5))
  );
  assert(layout.rowIssues.length === 0, 'row layout issues: ' + JSON.stringify(layout.rowIssues));
  assert(
    layout.recurText.some((t) => /Seg/.test(t) && /Qua/.test(t) && /Sex/.test(t)),
    'readable recurrence Seg, Qua, Sex: ' + JSON.stringify(layout.recurText)
  );
  console.log('PASS: layout DOM checks at 800x600');

  // Editar via UI
  const edited = await rendererEval(`(async () => {
    const btn = document.querySelector('[data-role="alarmes-edit"]');
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 200));
    const form = document.querySelector('[data-role="alarmes-form"]');
    const title = form.querySelector('[data-field="title"]');
    title.value = 'Lembrete Persistido UI';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    const time = form.querySelector('[data-field="time"]');
    time.value = '11:00';
    const t = window.MultiHeizV16._alarmesTest;
    return t.submitForm();
  })()`);
  assert(edited && edited.ok, 'edit via form');
  rem = (alarmes.list().reminders || []).find((r) => r.title === 'Lembrete Persistido UI');
  assert(rem && rem.timeOfDay === '11:00', 'edited time 11:00 got ' + (rem && rem.timeOfDay));
  console.log('PASS: edit via UI');

  // Alternar (garantir item visível na vista recorrentes)
  await rendererEval(`(async () => {
    const t = window.MultiHeizV16._alarmesTest;
    if (t) t.setView('recorrentes');
    await window.MultiHeizV16.openModule('alarmes');
    await new Promise((r) => setTimeout(r, 250));
    const tgl = document.querySelector('[data-role="alarmes-toggle"]');
    if (!tgl) return { ok: false, reason: 'no toggle' };
    tgl.checked = false;
    tgl.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true };
  })()`);
  await sleep(200);
  rem = (alarmes.list().reminders || []).find((r) => r.title === 'Lembrete Persistido UI');
  assert(rem && rem.enabled === false, 'toggled off, enabled=' + (rem && rem.enabled));

  // Reativar para persistir na fase 2
  alarmes.updateReminder(rem.id, { enabled: true });
  alarmes.flush();

  // Excluir um extra e manter o persistido (amanhã → vista Próximos)
  const extraAt = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const extra = alarmes.addReminder({
    title: 'Para excluir',
    kind: 'one-off',
    at: extraAt,
  });
  const delResult = await rendererEval(`(async () => {
    const t = window.MultiHeizV16._alarmesTest;
    if (t) t.setView('proximos');
    await window.MultiHeizV16.openModule('alarmes');
    await new Promise((r) => setTimeout(r, 250));
    window.confirm = () => true;
    const rows = [...document.querySelectorAll('[data-role="alarmes-item"]')];
    const row = rows.find((el) => (el.textContent || '').includes('Para excluir'));
    const del = row && row.querySelector('[data-role="alarmes-delete"]');
    if (del) del.click();
    await new Promise((r) => setTimeout(r, 200));
    return { ok: !!del, rows: rows.length };
  })()`);
  assert(delResult && delResult.ok, 'delete button found: ' + JSON.stringify(delResult));
  await sleep(200);
  assert(
    !(alarmes.list().reminders || []).some((r) => r.id === extra.id),
    'deleted via UI'
  );
  console.log('PASS: toggle + delete via UI');

  alarmes.flush();
  const storePath = path.join(userData, 'modules', 'alarmes.json');
  assert(fs.existsSync(storePath), 'alarmes.json exists');
  console.log('PASS: reminders phase 1');
  app.exit(0);
}

module.exports = { runRemindersSelftest };
