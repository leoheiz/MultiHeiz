'use strict';

/**
 * Selftest: top-bar memory pill + monitor (no bottom status bar).
 * MULTIHEIZ_SELFTEST=memory-monitor
 */

const { app } = require('electron');

async function runMemoryMonitorSelftest(ctx) {
  const {
    mainWindow,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForLayoutSettle,
    getState,
  } = ctx;

  console.log('SELFTEST memory-monitor');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  updateState((s) => {
    s.workspaces = [{ id: 'ws-mm', name: 'MM' }];
    s.activeWorkspaceId = 'ws-mm';
    s.layout = '1';
    s.page = 0;
    s.accounts = [
      {
        id: 'acc-mm-1',
        name: 'MM',
        color: '#2bb8a6',
        startUrl: 'about:blank',
        workspaceId: 'ws-mm',
        muted: false,
        lastUrl: null,
      },
    ];
    if (!s.settings) s.settings = {};
    s.settings.suspendHidden = false;
    s.settings.suspendDelayMs = 0;
    s.settings.memoryCleanupEnabled = false;
    s.settings.memoryCleanupIntervalMin = 30;
    s.ui = { ...(s.ui || {}), sidebarCollapsed: false, layoutLocked: true };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  await waitForLayoutSettle();

  // Inject metrics so the pill shows a number quickly.
  await mainWindow.webContents.executeJavaScript(
    `(() => {
      if (window.__multiheizUi && window.__multiheizUi.openMemPopover) {
        /* ensure UI hooks exist */
      }
      const fake = {
        totalRamMb: 512,
        totalCpu: 3,
        processCount: 2,
        metric: 'workingSet',
        panels: [
          {
            accountId: 'acc-mm-1',
            name: 'MM',
            workspaceName: 'MM',
            state: 'ativo',
            ramMb: 128,
            cpu: 1,
            active: true,
            focused: true,
            shared: false,
          },
        ],
      };
      window.dispatchEvent(new CustomEvent('multiheiz-test-metrics', { detail: fake }));
      return true;
    })()`,
    true
  ).catch(() => false);

  // Prefer sending via onEvent path used by the app
  emitToRenderer({
    type: 'memory:metrics',
    metrics: {
      totalRamMb: 512,
      totalCpu: 3,
      processCount: 2,
      workingSetMb: 512,
      privateMb: 400,
      panels: [
        {
          accountId: 'acc-mm-1',
          name: 'MM',
          workspaceName: 'MM',
          state: 'ativo',
          ramMb: 128,
          cpu: 1,
          active: true,
          focused: true,
          shared: false,
        },
      ],
    },
  });
  await sleep(500);

  const chrome = await mainWindow.webContents.executeJavaScript(
    `(() => {
      const status = document.getElementById('statusbar');
      const pill = document.getElementById('btn-mem-total');
      const free = document.getElementById('btn-free-mem');
      const pr = pill ? pill.getBoundingClientRect() : null;
      return {
        hasStatusbar: !!status,
        statusH: status ? status.getBoundingClientRect().height : 0,
        statusDisplay: status ? getComputedStyle(status).display : 'none',
        pillText: pill ? String(pill.textContent || '') : '',
        pillVisible: !!(pr && pr.width > 0 && pr.height > 0),
        hasFreeMemBtn: !!free,
        insets: window.__multiheizUi && window.__multiheizUi.getChromeInsets
          ? window.__multiheizUi.getChromeInsets()
          : null,
      };
    })()`,
    true
  );
  assert(!chrome.hasStatusbar || chrome.statusH === 0, 'no bottom status bar', chrome);
  assert(chrome.insets && chrome.insets.statusbar === 0, 'statusbar inset 0', chrome.insets);
  assert(!chrome.hasFreeMemBtn, 'Liberar memória top button removed', chrome);
  assert(chrome.pillVisible, 'memory pill visible', chrome);
  assert(/\d+\s*MB/i.test(chrome.pillText), 'pill shows NNN MB', chrome.pillText);
  console.log('PASS: no status bar; top pill shows MB');

  await mainWindow.webContents.executeJavaScript(
    `(() => {
      if (window.__multiheizUi && window.__multiheizUi.openMemPopover) {
        window.__multiheizUi.openMemPopover();
        return true;
      }
      const pill = document.getElementById('btn-mem-total');
      if (pill) pill.click();
      return !!pill;
    })()`,
    true
  );
  await sleep(800);

  // Overlay lives in a separate WebContents — probe via getMemPopoverData + overlay DOM if available
  const data = await mainWindow.webContents.executeJavaScript(
    `(() => {
      const d =
        window.__multiheizUi && window.__multiheizUi.getMemPopoverData
          ? window.__multiheizUi.getMemPopoverData()
          : null;
      return d;
    })()`,
    true
  );
  assert(data && data.stats, 'monitor data has stats', data);
  assert(data.stats.cpu && data.stats.ram, 'CPU/RAM in stats', data.stats);
  assert(data.stats.fps != null && data.stats.uptime, 'FPS/Uptime in stats', data.stats);
  assert(data.settings && 'suspendHidden' in data.settings, 'suspend settings', data.settings);
  assert(
    data.settings && 'memoryCleanupEnabled' in data.settings,
    'cleanup settings',
    data.settings
  );
  console.log('PASS: monitor payload has CPU/RAM/FPS/Uptime + settings');

  // Change setting from monitor path (same IPC as mem-settings action)
  const updated = await mainWindow.webContents.executeJavaScript(
    `(() => {
      return window.multiheiz.updateSettings({
        suspendHidden: true,
        memoryCleanupEnabled: true,
        memoryCleanupIntervalMin: 10,
      });
    })()`,
    true
  );
  assert(updated && updated.settings && updated.settings.suspendHidden === true, 'updateSettings ok', updated);
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  assert(getState().settings.suspendHidden === true, 'suspendHidden persisted');
  assert(getState().settings.memoryCleanupEnabled === true, 'cleanup enabled persisted');
  assert(getState().settings.memoryCleanupIntervalMin === 10, 'interval 10 persisted');

  // Open settings and verify form mirrors
  await mainWindow.webContents.executeJavaScript(
    `(() => {
      if (window.__multiheizUi && window.__multiheizUi.openSettings) {
        window.__multiheizUi.openSettings();
      } else if (window.MultiHeizV16 && window.MultiHeizV16.openSettingsSection) {
        window.MultiHeizV16.openSettingsSection('memoria');
      }
      return true;
    })()`,
    true
  );
  await sleep(400);
  await mainWindow.webContents.executeJavaScript(
    `(() => {
      const navM = document.querySelector('.settings-nav-btn[data-section="memoria"]');
      if (navM) navM.click();
      const navG = document.querySelector('.settings-nav-btn[data-section="geral"]');
      if (navG) navG.click();
      if (window.MultiHeizV16 && window.MultiHeizV16.fillSettingsForm) {
        return window.MultiHeizV16.fillSettingsForm();
      }
      return true;
    })()`,
    true
  );
  await sleep(500);

  const form = await mainWindow.webContents.executeJavaScript(
    `(() => {
      const f = document.getElementById('form-settings');
      return {
        suspendHidden: !!(f && f.suspendHidden && f.suspendHidden.checked),
        cleanup: !!(f && f.memoryCleanupEnabled && f.memoryCleanupEnabled.checked),
        interval: f && f.memoryCleanupIntervalMin ? String(f.memoryCleanupIntervalMin.value) : '',
      };
    })()`,
    true
  );
  assert(form.suspendHidden === true, 'settings form suspendHidden', form);
  assert(form.cleanup === true, 'settings form cleanup', form);
  assert(form.interval === '10', 'settings form interval', form);

  await mainWindow.webContents.executeJavaScript(
    `(() => {
      const navSobre = document.querySelector('.settings-nav-btn[data-section="sobre"]');
      if (navSobre) navSobre.click();
      if (window.MultiHeizV16 && window.MultiHeizV16.refreshAbout) {
        return window.MultiHeizV16.refreshAbout();
      }
      return true;
    })()`,
    true
  );
  await sleep(400);
  const about = await mainWindow.webContents.executeJavaScript(
    `(() => {
      const aboutVer = document.getElementById('about-version');
      return aboutVer ? String(aboutVer.textContent || '') : '';
    })()`,
    true
  );
  assert(/\d/.test(about), 'version in Sobre', about);
  console.log('PASS: settings sync + version in Sobre');

  // Flip from settings back (updateSettings — same source of truth as the form)
  await mainWindow.webContents.executeJavaScript(
    `(() => {
      const nav = document.querySelector('.settings-nav-btn[data-section="geral"]');
      if (nav) nav.click();
      return window.multiheiz.updateSettings({ suspendHidden: false }).then((st) => {
        return !!(st && st.settings && st.settings.suspendHidden === false);
      });
    })()`,
    true
  );
  await sleep(400);
  assert(getState().settings.suspendHidden === false, 'form → state suspendHidden false');
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  const mirrored = await mainWindow.webContents.executeJavaScript(
    `(() => {
      const d =
        window.__multiheizUi && window.__multiheizUi.getMemPopoverData
          ? window.__multiheizUi.getMemPopoverData()
          : null;
      return d && d.settings ? !!d.settings.suspendHidden : null;
    })()`,
    true
  );
  assert(mirrored === false, 'monitor mirrors settings', mirrored);

  console.log('PASS: selftest memory-monitor');
  app.exit(0);
}

module.exports = { runMemoryMonitorSelftest };
