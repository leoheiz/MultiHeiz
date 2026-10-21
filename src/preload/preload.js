'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('multiheiz', {
  getState: () => ipcRenderer.invoke('state:get'),
  setLayout: (layout) => ipcRenderer.invoke('state:set-layout', layout),
  setPage: (page) => ipcRenderer.invoke('state:set-page', page),
  setWorkspace: (id) => ipcRenderer.invoke('state:set-workspace', id),
  setMaximized: (accountId) => ipcRenderer.invoke('state:set-maximized', accountId),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  languagetoolFocusedOrigin: () => ipcRenderer.invoke('languagetool:focused-origin'),
  aiGetPublic: () => ipcRenderer.invoke('ai:get-public'),
  aiSetApiKey: (key) => ipcRenderer.invoke('ai:set-api-key', { key: key || '' }),
  aiClearApiKey: () => ipcRenderer.invoke('ai:clear-api-key'),
  aiTestConnection: () => ipcRenderer.invoke('ai:test-connection'),
  aiProbeLocal: () => ipcRenderer.invoke('ai:probe-local'),
  aiRewrite: (payload) => ipcRenderer.invoke('ai:rewrite', payload || {}),
  aiCancel: () => ipcRenderer.invoke('ai:cancel'),
  aiOpen: (payload) => ipcRenderer.invoke('ai:open', payload || {}),
  aiSessionAction: (action) => ipcRenderer.invoke('ai:session-action', { action }),
  aiSessionReplace: () => ipcRenderer.invoke('ai:session-replace'),
  aiSessionCopy: () => ipcRenderer.invoke('ai:session-copy'),
  updateUi: (partial) => ipcRenderer.invoke('ui:update', partial),
  updateAppearance: (partial) => ipcRenderer.invoke('appearance:update', partial),
  resetAppearance: () => ipcRenderer.invoke('appearance:reset'),
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  windowChromeInfo: () => ipcRenderer.invoke('window:chrome-info'),
  setFreeTiles: (workspaceId, tiles) =>
    ipcRenderer.invoke('free-tiles:set', { workspaceId, tiles }),
  createWorkspace: (name) => ipcRenderer.invoke('workspace:create', name),
  renameWorkspace: (id, name) => ipcRenderer.invoke('workspace:rename', { id, name }),
  deleteWorkspace: (id) => ipcRenderer.invoke('workspace:delete', id),
  createAccount: (data) => ipcRenderer.invoke('account:create', data),
  updateAccount: (data) => ipcRenderer.invoke('account:update', data),
  removeAccount: (id) => ipcRenderer.invoke('account:remove', id),
  openAccountSameSession: (id) => ipcRenderer.invoke('account:open-same-session', id),
  catalogList: () => ipcRenderer.invoke('catalog:list'),
  syncLayout: (slots) => ipcRenderer.invoke('layout:sync', slots),
  setSidebarOverlay: (widthPx) => ipcRenderer.invoke('sidebar:set-overlay', widthPx),
  setSidebarAutoHideTracking: (opts) =>
    ipcRenderer.invoke('sidebar:set-auto-hide-tracking', opts || {}),
  /** Subscribe to main-process cursor poll ({ inside }) for sidebar auto-hide. */
  onSidebarCursor: (handler) => {
    const listener = (_e, payload) => {
      if (payload && payload.type === 'sidebar:cursor') handler(payload);
    };
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  },
  setOverlay: (id, active) => ipcRenderer.invoke('overlay:set', { id, active }),
  setOverlayIds: (ids) => ipcRenderer.invoke('overlay:set-ids', ids),
  getOverlayCount: () => ipcRenderer.invoke('overlay:count'),
  /** Small popovers/menus: dedicated transparent WebContentsView (no panel freeze). */
  popoverShow: (opts) => ipcRenderer.invoke('popover:show', opts || {}),
  popoverHide: (reason) => ipcRenderer.invoke('popover:hide', reason || ''),
  popoverUpdate: (data) => ipcRenderer.invoke('popover:update', data || {}),
  popoverGet: () => ipcRenderer.invoke('popover:get'),
  popoverSelftestDebug: () => ipcRenderer.invoke('popover:selftest-debug'),
  popupAccountMenu: (accountId, x, y) =>
    ipcRenderer.invoke('menu:account', { accountId, x, y }),
  popupTopMenu: (x, y) => ipcRenderer.invoke('menu:top', { x, y }),
  panelZoom: (accountId, delta) => ipcRenderer.invoke('panel:zoom', { accountId, delta }),
  panelNavigate: (accountId, url) => ipcRenderer.invoke('panel:navigate', { accountId, url }),
  panelHome: (accountId) => ipcRenderer.invoke('panel:home', accountId),
  panelBack: (accountId) => ipcRenderer.invoke('panel:back', accountId),
  panelForward: (accountId) => ipcRenderer.invoke('panel:forward', accountId),
  panelReload: (accountId) => ipcRenderer.invoke('panel:reload', accountId),
  panelSetMuted: (accountId, muted) =>
    ipcRenderer.invoke('panel:set-muted', { accountId, muted }),
  panelSetVolume: (accountId, percent) =>
    ipcRenderer.invoke('panel:set-volume', { accountId, percent }),
  panelGetVolume: (accountId) => ipcRenderer.invoke('panel:get-volume', accountId),
  panelFocus: (accountId) => ipcRenderer.invoke('panel:focus', accountId),
  panelReactivate: (accountId) => ipcRenderer.invoke('panel:reactivate', accountId),
  panelSuspend: (accountId) => ipcRenderer.invoke('panel:suspend', accountId),
  panelOpenLoginBrowser: (accountId) => ipcRenderer.invoke('panel:open-login-browser', accountId),
  proxyGet: (accountId) => ipcRenderer.invoke('proxy:get', accountId),
  proxySet: (payload) => ipcRenderer.invoke('proxy:set', payload),
  proxyRemove: (accountId) => ipcRenderer.invoke('proxy:remove', accountId),
  proxyTest: (accountId) => ipcRenderer.invoke('proxy:test', accountId),
  dohSet: (partial) => ipcRenderer.invoke('doh:set', partial),
  dohGetSelftestCalls: () => ipcRenderer.invoke('doh:get-selftest-calls'),
  permissionsRespond: (payload) => ipcRenderer.invoke('permissions:respond', payload),
  permissionsGet: (accountId, origin) =>
    ipcRenderer.invoke('permissions:get', { accountId, origin }),
  permissionsSet: (accountId, origin, permission, value) =>
    ipcRenderer.invoke('permissions:set', { accountId, origin, permission, value }),
  permissionsReset: (accountId, origin) =>
    ipcRenderer.invoke('permissions:reset', { accountId, origin }),
  permissionsMediaUseGet: (accountId) =>
    ipcRenderer.invoke('permissions:media-use-get', accountId),
  getMemoryMetrics: () => ipcRenderer.invoke('memory:metrics'),
  freeMemory: () => ipcRenderer.invoke('memory:free'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getAbout: () => ipcRenderer.invoke('app:about'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  openPath: (target) => ipcRenderer.invoke('app:open-path', target),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),

  adblockStatus: () => ipcRenderer.invoke('adblock:status'),
  adblockDiagnostics: () => ipcRenderer.invoke('adblock:diagnostics'),
  adblockFocusedDiagnostics: (accountId, url) =>
    ipcRenderer.invoke('adblock:focused-diagnostics', { accountId, url }),
  adblockStats: (accountId) => ipcRenderer.invoke('adblock:stats', accountId),
  adblockRecent: (accountId) => ipcRenderer.invoke('adblock:recent', accountId),
  adblockUpdateLists: () => ipcRenderer.invoke('adblock:update-lists'),
  adblockSetWindow: (accountId, enabled) =>
    ipcRenderer.invoke('adblock:set-window', { accountId, enabled }),
  adblockAllowlistAdd: (domain) => ipcRenderer.invoke('adblock:allowlist-add', domain),
  adblockAllowlistRemove: (domain) => ipcRenderer.invoke('adblock:allowlist-remove', domain),
  adblockAllowSite: (accountId, url) =>
    ipcRenderer.invoke('adblock:allow-site', { accountId, url }),
  adblockPopupMenu: (accountId, x, y, url) =>
    ipcRenderer.invoke('adblock:popup-menu', { accountId, x, y, url }),
  adblockReport: (accountId, url) => ipcRenderer.invoke('adblock:report', { accountId, url }),
  adblockCustomListAdd: (url) => ipcRenderer.invoke('adblock:custom-list-add', url),
  adblockCustomListRemove: (id) => ipcRenderer.invoke('adblock:custom-list-remove', id),
  adblockSetUserRules: (text) => ipcRenderer.invoke('adblock:set-user-rules', text),

  extensionsList: () => ipcRenderer.invoke('extensions:list'),
  extensionsCoexistence: () => ipcRenderer.invoke('extensions:coexistence'),
  extensionsDnrStats: () => ipcRenderer.invoke('extensions:dnr-stats'),
  extensionsInstallUnpacked: () => ipcRenderer.invoke('extensions:install-unpacked'),
  extensionsInstallCrx: () => ipcRenderer.invoke('extensions:install-crx'),
  extensionsInstallStore: (input) => ipcRenderer.invoke('extensions:install-store', input),
  extensionsStoreBarInstall: (accountId, store, id) =>
    ipcRenderer.invoke('extensions:store-bar-install', { accountId, store, id }),
  extensionsStoreBarRemove: (accountId, id) =>
    ipcRenderer.invoke('extensions:store-bar-remove', { accountId, id }),
  extensionsStoreBarOffer: (accountId) =>
    ipcRenderer.invoke('extensions:store-bar-offer', accountId),
  extensionsOpenWebstore: (which) => ipcRenderer.invoke('extensions:open-webstore', which),
  extensionsSetEnabled: (id, enabled) =>
    ipcRenderer.invoke('extensions:set-enabled', { id, enabled }),
  extensionsSetApplyTo: (id, applyTo) =>
    ipcRenderer.invoke('extensions:set-apply-to', { id, applyTo }),
  extensionsRemove: (id) => ipcRenderer.invoke('extensions:remove', id),
  extensionsOpenOptions: (id, accountId) =>
    ipcRenderer.invoke('extensions:open-options', { id, accountId }),
  extensionsOpenAction: (id, accountId, x, y) =>
    ipcRenderer.invoke('extensions:open-action', { id, accountId, x, y }),
  extensionsActionsFor: (accountId) => ipcRenderer.invoke('extensions:actions-for', accountId),
  extensionsForPanel: (accountId) => ipcRenderer.invoke('extensions:for-panel', accountId),
  extensionsSetActiveOnPanel: (id, accountId, active) =>
    ipcRenderer.invoke('extensions:set-active-on-panel', { id, accountId, active }),

  bookmarksList: () => ipcRenderer.invoke('bookmarks:list'),
  bookmarksFindUrl: (url) => ipcRenderer.invoke('bookmarks:find-url', url),
  bookmarksAdd: (data) => ipcRenderer.invoke('bookmarks:add', data),
  bookmarksUpdate: (data) => ipcRenderer.invoke('bookmarks:update', data),
  bookmarksRemove: (id) => ipcRenderer.invoke('bookmarks:remove', id),
  bookmarksFolderCreate: (name) => ipcRenderer.invoke('bookmarks:folder-create', name),
  bookmarksFolderRename: (id, name) =>
    ipcRenderer.invoke('bookmarks:folder-rename', { id, name }),
  bookmarksFolderDelete: (id) => ipcRenderer.invoke('bookmarks:folder-delete', id),
  bookmarksExport: () => ipcRenderer.invoke('bookmarks:export'),
  bookmarksImport: (raw) => ipcRenderer.invoke('bookmarks:import', raw),
  bookmarksOpen: (opts) => ipcRenderer.invoke('bookmarks:open', opts),

  historyQuery: (opts) => ipcRenderer.invoke('history:query', opts),
  historyDelete: (id) => ipcRenderer.invoke('history:delete', id),
  historyClear: (opts) => ipcRenderer.invoke('history:clear', opts),
  historyOpen: (opts) => ipcRenderer.invoke('history:open', opts),

  downloadsList: () => ipcRenderer.invoke('downloads:list'),
  downloadsSettings: (partial) => ipcRenderer.invoke('downloads:settings', partial),
  downloadsPickFolder: () => ipcRenderer.invoke('downloads:pick-folder'),
  downloadsPause: (id) => ipcRenderer.invoke('downloads:pause', id),
  downloadsResume: (id) => ipcRenderer.invoke('downloads:resume', id),
  downloadsCancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
  downloadsOpen: (id) => ipcRenderer.invoke('downloads:open', id),
  downloadsShow: (id) => ipcRenderer.invoke('downloads:show', id),
  downloadsRemove: (id) => ipcRenderer.invoke('downloads:remove', id),

  diagnosticsLogs: () => ipcRenderer.invoke('diagnostics:logs'),
  diagnosticsPreview: () => ipcRenderer.invoke('diagnostics:preview'),
  diagnosticsExport: () => ipcRenderer.invoke('diagnostics:export'),
  diagnosticsGithubIssue: () => ipcRenderer.invoke('diagnostics:github-issue'),
  diagnosticsProcessInfo: () => ipcRenderer.invoke('diagnostics:process-info'),
  updatesCheck: () => ipcRenderer.invoke('updates:check'),
  updatesStatus: () => ipcRenderer.invoke('updates:status'),
  updatesDownload: () => ipcRenderer.invoke('updates:download'),
  updatesCancel: () => ipcRenderer.invoke('updates:cancel'),
  updatesInstall: () => ipcRenderer.invoke('updates:install'),
  updatesOpenReleases: () => ipcRenderer.invoke('updates:open-releases'),
  updatesOpenDownload: () => ipcRenderer.invoke('updates:open-download'),
  updatesGetChannel: () => ipcRenderer.invoke('updates:get-channel'),
  updatesGetAutoCheck: () => ipcRenderer.invoke('updates:get-auto-check'),
  updatesSetAutoCheck: (enabled) => ipcRenderer.invoke('updates:set-auto-check', enabled),
  changelogGet: () => ipcRenderer.invoke('changelog:get'),
  changelogShouldShow: () => ipcRenderer.invoke('changelog:should-show'),
  changelogMarkSeen: (version) => ipcRenderer.invoke('changelog:mark-seen', version),
  changelogClockSkew: () => ipcRenderer.invoke('changelog:clock-skew'),

  planilhaList: () => ipcRenderer.invoke('planilha:list'),
  planilhaGet: (id) => ipcRenderer.invoke('planilha:get', id),
  planilhaCreate: (name) => ipcRenderer.invoke('planilha:create', name),
  planilhaDelete: (id) => ipcRenderer.invoke('planilha:delete', id),
  planilhaRename: (id, name) => ipcRenderer.invoke('planilha:rename', { id, name }),
  planilhaSetCell: (opts) => ipcRenderer.invoke('planilha:set-cell', opts),
  planilhaAddSheet: (opts) => ipcRenderer.invoke('planilha:add-sheet', opts),
  planilhaRenameSheet: (opts) => ipcRenderer.invoke('planilha:rename-sheet', opts),
  planilhaDeleteSheet: (opts) => ipcRenderer.invoke('planilha:delete-sheet', opts),
  planilhaSetActiveSheet: (opts) => ipcRenderer.invoke('planilha:set-active-sheet', opts),
  planilhaSetColWidth: (opts) => ipcRenderer.invoke('planilha:set-col-width', opts),
  planilhaSetRowHeight: (opts) => ipcRenderer.invoke('planilha:set-row-height', opts),
  planilhaAutofitCol: (opts) => ipcRenderer.invoke('planilha:autofit-col', opts),
  planilhaAutofitRow: (opts) => ipcRenderer.invoke('planilha:autofit-row', opts),
  planilhaValidateSheetName: (opts) => ipcRenderer.invoke('planilha:validate-sheet-name', opts),
  planilhaExport: (id) => ipcRenderer.invoke('planilha:export', id),
  planilhaImport: () => ipcRenderer.invoke('planilha:import'),

  alarmesList: () => ipcRenderer.invoke('alarmes:list'),
  alarmesAddReminder: (data) => ipcRenderer.invoke('alarmes:add-reminder', data),
  alarmesUpdateReminder: (data) => ipcRenderer.invoke('alarmes:update-reminder', data),
  alarmesRemoveReminder: (id) => ipcRenderer.invoke('alarmes:remove-reminder', id),
  alarmesCompleteReminder: (id) => ipcRenderer.invoke('alarmes:complete-reminder', id),
  alarmesSnooze: (id, minutes) => ipcRenderer.invoke('alarmes:snooze', { id, minutes }),
  alarmesFilter: (view, now) => ipcRenderer.invoke('alarmes:filter', { view, now }),
  alarmesAddTimer: (data) => ipcRenderer.invoke('alarmes:add-timer', data),
  alarmesStartTimer: (id) => ipcRenderer.invoke('alarmes:start-timer', id),
  alarmesPauseTimer: (id) => ipcRenderer.invoke('alarmes:pause-timer', id),
  alarmesResetTimer: (id) => ipcRenderer.invoke('alarmes:reset-timer', id),
  alarmesRemoveTimer: (id) => ipcRenderer.invoke('alarmes:remove-timer', id),

  notasList: () => ipcRenderer.invoke('notas:list'),
  notasGet: (id) => ipcRenderer.invoke('notas:get', id),
  notasCreate: (title) => ipcRenderer.invoke('notas:create', title),
  notasUpdate: (data) => ipcRenderer.invoke('notas:update', data),
  notasRemove: (id) => ipcRenderer.invoke('notas:remove', id),
  notasPreview: (body) => ipcRenderer.invoke('notas:preview', body),

  onEvent: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('event', listener);
    return () => ipcRenderer.removeListener('event', listener);
  },
});
