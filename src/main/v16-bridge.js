'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, shell, dialog, BrowserWindow } = require('electron');
const { getState, updateState, flushSave } = require('./state');
const bookmarks = require('./bookmarks');
const history = require('./history');
const omnibox = require('./omnibox');
const downloads = require('./downloads');
const logger = require('./logger');
const diagnostics = require('./diagnostics');
const config = require('./config');
const { SEARCH_ENGINES } = config;
const planilha = require('./modules/planilha');
const alarmes = require('./modules/alarmes');
const notas = require('./modules/notas');
const memory = require('./memory');
const { sanitizeUserStartUrl, isNavigableUrl } = require('./url-policy');

const openExternalLog = [];

/**
 * @param {{
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   emitToRenderer: (payload: object) => void,
 *   publicState: () => object,
 *   panels: typeof import('./panels'),
 * }} ctx
 */
function initV16(ctx) {
  const { getMainWindow, emitToRenderer, publicState, panels } = ctx;
  const inSelftest = !!process.env.MULTIHEIZ_SELFTEST;

  bookmarks.load();
  history.load();
  downloads.load();
  downloads.init(emitToRenderer);
  notas.load();
  alarmes.init(emitToRenderer);

  logger.info('MultiHeiz v1.6 bridge ready', { version: app.getVersion() });

  const missed = alarmes.detectMissed();
  if (missed.length) {
    alarmes.notifyMissedGroup(missed);
    setTimeout(() => {
      emitToRenderer({ type: 'alarmes:missed', missed });
    }, 1500);
  }
  alarmes.markStarted();

  function register() {
    /* ---- Favorites ---- */
    ipcMain.handle('bookmarks:list', () => bookmarks.list());
    ipcMain.handle('bookmarks:find-url', (_e, url) => bookmarks.findByUrl(url));
    ipcMain.handle('bookmarks:add', (_e, data) => {
      const item = bookmarks.addFavorite(data || {});
      emitToRenderer({ type: 'bookmarks:changed', ...bookmarks.list() });
      return item;
    });
    ipcMain.handle('bookmarks:update', (_e, { id, ...fields }) => {
      const item = bookmarks.updateFavorite(id, fields);
      emitToRenderer({ type: 'bookmarks:changed', ...bookmarks.list() });
      return item;
    });
    ipcMain.handle('bookmarks:remove', (_e, id) => {
      bookmarks.removeFavorite(id);
      emitToRenderer({ type: 'bookmarks:changed', ...bookmarks.list() });
      return true;
    });
    ipcMain.handle('bookmarks:folder-create', (_e, nameOrOpts) => {
      const name =
        typeof nameOrOpts === 'string'
          ? nameOrOpts
          : nameOrOpts && nameOrOpts.name;
      const parentId =
        nameOrOpts && typeof nameOrOpts === 'object' ? nameOrOpts.parentId : null;
      const f = bookmarks.createFolder(name, parentId);
      emitToRenderer({ type: 'bookmarks:changed', ...bookmarks.list() });
      return f;
    });
    ipcMain.handle('bookmarks:folder-rename', (_e, { id, name }) => {
      const f = bookmarks.renameFolder(id, name);
      emitToRenderer({ type: 'bookmarks:changed', ...bookmarks.list() });
      return f;
    });
    ipcMain.handle('bookmarks:folder-delete', (_e, id) => {
      const r = bookmarks.deleteFolder(id);
      emitToRenderer({ type: 'bookmarks:changed', ...bookmarks.list() });
      return r;
    });
    ipcMain.handle('bookmarks:move', (_e, { id, folderId }) => {
      const item = bookmarks.moveFavorite(id, folderId);
      emitToRenderer({ type: 'bookmarks:changed', ...bookmarks.list() });
      return item;
    });
    ipcMain.handle('bookmarks:set-expanded', (_e, ids) => {
      const list = bookmarks.setExpandedFolders(ids);
      emitToRenderer({ type: 'bookmarks:changed', ...list });
      return list;
    });
    ipcMain.handle('bookmarks:export', () => bookmarks.exportJson());
    ipcMain.handle('bookmarks:import', (_e, raw) => {
      const r = bookmarks.importJson(raw);
      emitToRenderer({ type: 'bookmarks:changed', ...bookmarks.list() });
      return r;
    });
    ipcMain.handle('bookmarks:open', (_e, { url, mode, windowId }) => {
      return openUrlInWindow(url, mode, windowId);
    });

    /* ---- History ---- */
    ipcMain.handle('history:query', (_e, opts) => history.query(opts || {}));
    ipcMain.handle('omnibox:suggest', async (_e, opts) => {
      const o = opts || {};
      const st = getState();
      const settings = (st && st.settings) || {};
      const bm = bookmarks.list();
      const local = omnibox.suggest({
        query: String(o.query || ''),
        windowId: o.windowId || null,
        accounts: (st && st.accounts) || [],
        bookmarkItems: (bm && bm.items) || [],
        settings,
      });
      // Remote suggestions only when explicitly enabled (privacy default OFF).
      if (settings.searchEngineSuggestions && String(o.query || '').trim().length >= 2) {
        try {
          const remote = await omnibox.remoteSuggestions(String(o.query || ''), settings);
          for (const phrase of remote) {
            if (local.items.length >= omnibox.MAX_ITEMS) break;
            if (!phrase || local.items.some((it) => it.kind === 'search' && it.query === phrase)) {
              continue;
            }
            local.items.push({
              kind: 'remote',
              id: `remote-${local.items.length}`,
              title: String(phrase),
              url: '',
              subtitle: 'Sugestão',
              query: String(phrase),
            });
          }
          local.items = local.items.slice(0, omnibox.MAX_ITEMS);
        } catch {
          /* ignore */
        }
      }
      return local;
    });
    ipcMain.handle('history:delete', (_e, id) => {
      history.deleteEntry(id);
      emitToRenderer({ type: 'history:changed' });
      return true;
    });
    ipcMain.handle('history:delete-many', (_e, ids) => {
      history.deleteEntries(ids || []);
      emitToRenderer({ type: 'history:changed' });
      return true;
    });
    ipcMain.handle('history:clear', (_e, opts) => {
      const o = opts || {};
      if (o.windowId) history.clearByWindow(o.windowId);
      else if (o.range) history.clearByRange(o.range);
      else history.clearAll();
      emitToRenderer({ type: 'history:changed' });
      return true;
    });
    ipcMain.handle('history:open', (_e, { url, mode, windowId }) => {
      return openUrlInWindow(url, mode, windowId);
    });

    /* ---- Downloads ---- */
    ipcMain.handle('downloads:list', () => ({
      items: downloads.list(),
      activeCount: downloads.activeCount(),
      settings: downloads.getSettings(),
    }));
    ipcMain.handle('downloads:settings', (_e, partial) => {
      const s = downloads.updateSettings(partial || {});
      emitToRenderer({
        type: 'downloads:changed',
        items: downloads.list(),
        activeCount: downloads.activeCount(),
      });
      return s;
    });
    ipcMain.handle('downloads:pick-folder', async () => {
      const win = getMainWindow();
      const r = await dialog.showOpenDialog(win || undefined, {
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return downloads.getSettings();
      return downloads.updateSettings({ defaultFolder: r.filePaths[0] });
    });
    ipcMain.handle('downloads:pause', (_e, id) => downloads.pause(id));
    ipcMain.handle('downloads:resume', (_e, id) => downloads.resume(id));
    ipcMain.handle('downloads:cancel', (_e, id) => downloads.cancel(id));
    ipcMain.handle('downloads:open', (_e, id) => downloads.openFile(id));
    ipcMain.handle('downloads:show', (_e, id) => downloads.showInFolder(id));
    ipcMain.handle('downloads:remove', (_e, id) => downloads.removeFromList(id));

    /* ---- Settings extras / about / diagnostics ---- */
    ipcMain.handle('app:about', () => ({
      name: 'MultiHeiz',
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      kofiUrl: config.KOFI_URL,
      searchEngines: SEARCH_ENGINES,
    }));
    ipcMain.handle('app:open-external', (_e, url) => {
      const allowed = config.KOFI_URL;
      if (!allowed || url !== allowed) return { ok: false };
      if (inSelftest) {
        openExternalLog.push(url);
        return { ok: true, stubbed: true };
      }
      shell.openExternal(url);
      return { ok: true };
    });
    ipcMain.handle('app:open-data-folder', () => diagnostics.openDataFolder());
    ipcMain.handle('diagnostics:logs', () => logger.readRecent(300));
    ipcMain.handle('diagnostics:preview', () => {
      const metrics = memory.getLatestMetrics();
      return diagnostics.previewDiagnostics({ metrics });
    });
    ipcMain.handle('diagnostics:export', async () => {
      const metrics = memory.getLatestMetrics();
      return diagnostics.exportDiagnostics(getMainWindow(), { metrics });
    });
    ipcMain.handle('diagnostics:github-issue', () => diagnostics.openGithubIssue());
    ipcMain.handle('diagnostics:process-info', () => {
      const metrics = memory.getLatestMetrics();
      return {
        metrics,
        memoryUsage: process.memoryUsage(),
        versions: process.versions,
        pid: process.pid,
        crashCount: require('./diag-log').getCrashCount(),
      };
    });
    // updates:* handlers registered by src/main/updater.js (initUpdater)

    const changelog = require('./changelog');
    changelog.setEmit(emitToRenderer);
    ipcMain.handle('changelog:get', () => {
      try {
        const data = changelog.loadChangelog();
        return {
          ok: true,
          data,
          view: changelog.getNovidadesViewModel(data),
          version: app.getVersion(),
        };
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
    });
    ipcMain.handle('changelog:should-show', () => {
      const lastSeen = changelog.getLastSeen(getState);
      const version = app.getVersion();
      return {
        ok: true,
        show: changelog.shouldShowNovidades(lastSeen, version),
        lastSeen,
        version,
      };
    });
    ipcMain.handle('changelog:mark-seen', (_e, version) => {
      const v = version || app.getVersion();
      changelog.markChangelogSeen(v, updateState);
      return { ok: true, version: v, state: publicState() };
    });
    ipcMain.handle('changelog:clock-skew', () => ({
      ok: true,
      ...changelog.getClockSkew(),
      message: changelog.getClockSkew().skewed
        ? 'Relógio do sistema incorreto — logins e certificados podem falhar'
        : null,
    }));

    /* ---- Planilha ---- */
    ipcMain.handle('planilha:list', () => planilha.listWorkbooks());
    ipcMain.handle('planilha:get', (_e, id) => planilha.getEvaluatedWorkbook(id));
    ipcMain.handle('planilha:create', (_e, name) => planilha.createWorkbook(name));
    ipcMain.handle('planilha:delete', (_e, id) => planilha.deleteWorkbook(id));
    ipcMain.handle('planilha:rename', (_e, { id, name }) => planilha.renameWorkbook(id, name));
    ipcMain.handle('planilha:set-cell', (_e, { workbookId, sheetId, ref, raw }) =>
      planilha.updateCell(workbookId, sheetId, ref, raw)
    );
    ipcMain.handle('planilha:add-sheet', (_e, { workbookId, name }) =>
      planilha.addSheet(workbookId, name)
    );
    ipcMain.handle('planilha:rename-sheet', (_e, { workbookId, sheetId, name }) =>
      planilha.renameSheet(workbookId, sheetId, name)
    );
    ipcMain.handle('planilha:delete-sheet', (_e, { workbookId, sheetId }) =>
      planilha.deleteSheet(workbookId, sheetId)
    );
    ipcMain.handle('planilha:set-active-sheet', (_e, { workbookId, sheetId }) =>
      planilha.setActiveSheet(workbookId, sheetId)
    );
    ipcMain.handle('planilha:set-col-width', (_e, { workbookId, sheetId, col, width }) =>
      planilha.setColWidth(workbookId, sheetId, col, width)
    );
    ipcMain.handle('planilha:set-row-height', (_e, { workbookId, sheetId, row, height }) =>
      planilha.setRowHeight(workbookId, sheetId, row, height)
    );
    ipcMain.handle('planilha:autofit-col', (_e, { workbookId, sheetId, col }) =>
      planilha.autoFitColWidth(workbookId, sheetId, col)
    );
    ipcMain.handle('planilha:autofit-row', (_e, { workbookId, sheetId, row }) =>
      planilha.autoFitRowHeight(workbookId, sheetId, row)
    );
    ipcMain.handle('planilha:validate-sheet-name', (_e, { name, workbookId, excludeId }) => {
      const wb = workbookId ? planilha.loadWorkbook(workbookId) : null;
      return planilha.validateSheetName(name, (wb && wb.sheets) || [], excludeId);
    });
    ipcMain.handle('planilha:export', (_e, workbookId) =>
      planilha.exportXlsx(workbookId, getMainWindow())
    );
    ipcMain.handle('planilha:import', () => planilha.importXlsx(getMainWindow()));

    /* ---- Alarmes ---- */
    ipcMain.handle('alarmes:list', () => alarmes.list());
    ipcMain.handle('alarmes:add-reminder', (_e, data) => alarmes.addReminder(data));
    ipcMain.handle('alarmes:update-reminder', (_e, { id, ...fields }) =>
      alarmes.updateReminder(id, fields)
    );
    ipcMain.handle('alarmes:remove-reminder', (_e, id) => alarmes.removeReminder(id));
    ipcMain.handle('alarmes:complete-reminder', (_e, id) => alarmes.completeReminder(id));
    ipcMain.handle('alarmes:snooze', (_e, { id, minutes }) => alarmes.snooze(id, minutes));
    ipcMain.handle('alarmes:add-timer', (_e, data) => alarmes.addTimer(data));
    ipcMain.handle('alarmes:start-timer', (_e, id) => alarmes.startTimer(id));
    ipcMain.handle('alarmes:pause-timer', (_e, id) => alarmes.pauseTimer(id));
    ipcMain.handle('alarmes:reset-timer', (_e, id) => alarmes.resetTimer(id));
    ipcMain.handle('alarmes:remove-timer', (_e, id) => alarmes.removeTimer(id));
    ipcMain.handle('alarmes:filter', (_e, { view, now }) => {
      const data = alarmes.list();
      return alarmes.sortByPriorityThenNext(
        alarmes.filterByView(data.reminders, view, now),
        now
      );
    });
    ipcMain.handle('alarmes:test-log', () => alarmes.getTestNotificationLog());
    ipcMain.handle('alarmes:test-log-clear', () => {
      alarmes.clearTestNotificationLog();
      return true;
    });
    ipcMain.handle('alarmes:test-notify-missed', (_e, items) =>
      alarmes.notifyMissedGroup(items || [])
    );

    /* ---- Notas ---- */
    ipcMain.handle('notas:list', () => notas.list());
    ipcMain.handle('notas:get', (_e, id) => notas.get(id));
    ipcMain.handle('notas:create', (_e, title) => notas.create(title));
    ipcMain.handle('notas:update', (_e, { id, ...fields }) => notas.update(id, fields));
    ipcMain.handle('notas:remove', (_e, id) => notas.remove(id));
    ipcMain.handle('notas:preview', (_e, body) => notas.sanitizeAndRender(body));

    /* ---- Selftest helpers ---- */
    ipcMain.handle('selftest:planilha-set', (_e, { workbookId, sheetId, cells }) =>
      planilha.applyCellsForTest(workbookId, sheetId, cells)
    );
    ipcMain.handle('selftest:planilha-export-path', (_e, { workbookId, filePath }) =>
      planilha.exportXlsxToPath(workbookId, filePath)
    );
    ipcMain.handle('selftest:planilha-import-path', (_e, { filePath, name }) =>
      planilha.importXlsxFromPath(filePath, name)
    );
    ipcMain.handle('selftest:history-record', (_e, data) => history.record(data || {}));
    ipcMain.handle('selftest:alarmes-missed-sim', (_e, lastRunAt) => {
      getStoreAlarmesLastRun(lastRunAt);
      return alarmes.detectMissed();
    });
    ipcMain.handle('selftest:next-occurrence', (_e, reminder) =>
      alarmes.nextOccurrence(reminder, Date.now())
    );
    ipcMain.handle('selftest:diag-sanitize', () => diagnostics.sanitizeState(getState()));
    ipcMain.handle('selftest:flush-all', () => {
      flushSave();
      bookmarks.flush();
      history.flush();
      downloads.flush();
      notas.flush();
      alarmes.flush();
      return true;
    });
  }

  function getStoreAlarmesLastRun(lastRunAt) {
    const { createJsonStore } = require('./json-store');
    // Directly mutate via updateReminder path — use alarmes internal by simulating
    const storePath = path.join(app.getPath('userData'), 'modules', 'alarmes.json');
    try {
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      raw.lastRunAt = lastRunAt;
      fs.writeFileSync(storePath, JSON.stringify(raw, null, 2), 'utf8');
      // reload
      alarmes.stopAll();
      alarmes.init(emitToRenderer);
    } catch {
      /* ignore */
    }
  }

  function openUrlInWindow(url, mode, windowId) {
    const raw = String(url || '').trim();
    // Favoritos/histórico: só http(s); demais esquemas não navegam
    if (!isNavigableUrl(raw)) {
      return { ok: false, reason: 'blocked-scheme' };
    }
    const st = getState();
    let targetId = windowId;
    if (mode === 'new' || (!targetId && mode !== 'current')) {
      // create new account/window
      const id = `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const colors = ['#2bb8a6', '#3d8bfd', '#e8a54b', '#e83e8c', '#6f42c1', '#20c997'];
      const account = {
        id,
        name: 'Janela',
        color: colors[st.accounts.length % colors.length],
        startUrl: sanitizeUserStartUrl(raw, 'https://www.google.com'),
        workspaceId: st.activeWorkspaceId,
        muted: false,
        pauseInBackground: false,
        keepAliveInBackground: false,
        privateHistory: false,
        lastUrl: null,
      };
      updateState((s) => {
        s.accounts.push(account);
      });
      emitToRenderer({ type: 'state:changed', state: publicState() });
      panels.panelNavigate(id, raw);
      return { ok: true, windowId: id, state: publicState() };
    }
    if (mode === 'current' || !targetId) {
      targetId = panels.getFocusedAccountId() || (st.accounts[0] && st.accounts[0].id);
    }
    if (!targetId) return { ok: false, reason: 'no-window' };
    panels.panelNavigate(targetId, raw);
    return { ok: true, windowId: targetId, state: publicState() };
  }

  function flushAll() {
    bookmarks.flush();
    history.flush();
    downloads.flush();
    notas.flush();
    alarmes.flush();
    logger.close();
    alarmes.stopAll();
  }

  return {
    register,
    flushAll,
    bookmarks,
    history,
    downloads,
    alarmes,
    notas,
    planilha,
    get KOFI_URL() {
      return config.KOFI_URL;
    },
    setKofiUrlForTest: config.setKofiUrlForTest,
    getOpenExternalLog: () => [...openExternalLog],
    clearOpenExternalLog: () => {
      openExternalLog.length = 0;
    },
  };
}

module.exports = { initV16 };
