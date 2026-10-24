'use strict';

/**
 * Selftest: scheduled memory cleanup setting UI + timer (MULTIHEIZ_SELFTEST=memory-schedule).
 */

const { app } = require('electron');

async function runMemoryScheduleSelftest(ctx) {
  const {
    mainWindow,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForLayoutSettle,
    getState,
    memory,
  } = ctx;

  console.log('SELFTEST memory-schedule');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  // Report what existed before: setting lived under Desempenho with options 15/30/60/120,
  // interval always enabled; now under Memória with toggle + 5/10/15/30/60, interval disabled while off.
  console.log(
    'NOTE: before FIX-8 — memoryCleanup under Desempenho (15/30/60/120), select always enabled; default OFF'
  );

  updateState((s) => {
    if (!s.settings) s.settings = {};
    s.settings.memoryCleanupEnabled = false;
    s.settings.memoryCleanupIntervalMin = 30;
  });
  flushSave();
  memory.resyncCleanupTimer();
  assert(!memory.isCleanupTimerRunning(), 'timer off by default');
  assert(getState().settings.memoryCleanupEnabled === false, 'default OFF in state');
  console.log('PASS: off by default, timer not running');

  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  await waitForLayoutSettle();

  // Open settings → Memória pane and inspect controls
  await mainWindow.webContents.executeJavaScript(
    `(() => {
      if (window.multiheiz && window.__multiheizUi && window.__multiheizUi.openSettings) {
        window.__multiheizUi.openSettings();
      } else if (window.MultiHeizV16 && window.MultiHeizV16.openSettingsSection) {
        window.MultiHeizV16.openSettingsSection('memoria');
      }
      const nav = document.querySelector('.settings-nav-btn[data-section="memoria"]');
      if (nav) nav.click();
      return true;
    })()`,
    true
  );
  await sleep(500);

  const ui = await mainWindow.webContents.executeJavaScript(
    `(() => {
      const pane = document.querySelector('.settings-pane[data-pane="memoria"]');
      const toggle = document.getElementById('memory-cleanup-enabled');
      const sel = document.getElementById('memory-cleanup-interval');
      const hint = document.getElementById('memory-cleanup-hint');
      const label = document.getElementById('memory-cleanup-interval-label');
      function sizeOk(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      const opts = sel ? [...sel.options].map((o) => o.value) : [];
      return {
        paneVisible: sizeOk(pane),
        toggleVisible: sizeOk(toggle),
        selVisible: sizeOk(sel) || sizeOk(label),
        toggleChecked: !!(toggle && toggle.checked),
        selDisabled: !!(sel && sel.disabled),
        opts,
        hintText: hint ? String(hint.textContent || '') : '',
        inDesempenho: !!document.querySelector(
          '.settings-pane[data-pane="desempenho"] #memory-cleanup-enabled'
        ),
      };
    })()`,
    true
  );
  assert(ui && ui.toggleVisible, 'toggle visible (non-zero size)', ui);
  assert(ui.selVisible, 'interval control visible', ui);
  assert(ui.toggleChecked === false, 'toggle unchecked by default', ui);
  assert(ui.selDisabled === true, 'interval disabled while off', ui);
  assert(!ui.inDesempenho, 'no longer only under Desempenho', ui);
  for (const v of ['5', '10', '15', '30', '60']) {
    assert(ui.opts.includes(v), 'interval option ' + v, ui.opts);
  }
  assert(
    /áudio|video|vídeo|chamada/i.test(ui.hintText),
    'description mentions audio/video/call',
    ui.hintText
  );
  console.log('PASS: setting visible in Memória, off, interval disabled');

  // Enable + set 10 min → persists and reschedules
  await mainWindow.webContents.executeJavaScript(
    `(() => {
      const toggle = document.getElementById('memory-cleanup-enabled');
      const sel = document.getElementById('memory-cleanup-interval');
      if (toggle) {
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (sel) {
        sel.disabled = false;
        sel.value = '10';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { checked: toggle && toggle.checked, val: sel && sel.value, disabled: sel && sel.disabled };
    })()`,
    true
  );
  await sleep(800);

  const st = getState().settings || {};
  assert(st.memoryCleanupEnabled === true, 'enabled saved', st);
  assert(Number(st.memoryCleanupIntervalMin) === 10, 'interval 10 saved', st);
  assert(memory.isCleanupTimerRunning(), 'timer running after enable');
  console.log('PASS: saved interval persists, timer rescheduled');

  // Turn off again
  updateState((s) => {
    s.settings.memoryCleanupEnabled = false;
  });
  flushSave();
  memory.resyncCleanupTimer();
  assert(!memory.isCleanupTimerRunning(), 'timer stopped when off');
  console.log('PASS: timer stops when toggle off');

  // Settings search: none present — report that
  const hasSearch = await mainWindow.webContents.executeJavaScript(
    `!!(document.querySelector('#settings-search, [data-role="settings-search"], input[name="settingsSearch"]'))`,
    true
  );
  assert(hasSearch === false, 'no settings search (skipped findability via search)');
  console.log('PASS: no settings search present (N/A)');

  console.log('PASS: selftest:memory-schedule complete');
  app.exit(0);
}

module.exports = { runMemoryScheduleSelftest };
