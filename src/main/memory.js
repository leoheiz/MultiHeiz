'use strict';

const { app } = require('electron');
const { getState } = require('./state');
const panels = require('./panels');

const METRICS_INTERVAL_MS = 2000;
const ENFORCE_COOLDOWN_MS = 4000;
/** Suspend only when over limit; re-check after dropping below this fraction (hysteresis). */
const HYSTERESIS_RATIO = 0.85;
/** Settle delay after Liberar memória before measuring "freed". */
const FREE_SETTLE_MS = 2000;

/** @type {ReturnType<typeof setInterval> | null} */
let metricsTimer = null;
let lastEnforceAt = 0;
let lastTotalKb = 0;
/** @type {'ok' | 'over'} */
let pressureBand = 'ok';

/** @type {(payload: object) => void} */
let emitToRenderer = () => {};

function initMemory(emit) {
  emitToRenderer = emit;
  if (metricsTimer) clearInterval(metricsTimer);
  metricsTimer = setInterval(() => {
    tick().catch((err) => console.error('memory tick', err));
  }, METRICS_INTERVAL_MS);
  setTimeout(() => {
    tick().catch(() => {});
  }, 600);
}

function stopMemory() {
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
}

/**
 * ONE metric everywhere: privateBytes on Windows when available, else workingSetSize.
 * Electron ProcessMetric.memory.* values are in KB.
 * @param {{ workingSetSize?: number, privateBytes?: number } | null | undefined} mem
 * @returns {{ kb: number, metric: 'privateBytes' | 'workingSetSize' }}
 */
function pickProcessKb(mem) {
  const workingKb = Number(mem && mem.workingSetSize) || 0;
  const privateKb = Number(mem && mem.privateBytes) || 0;
  if (process.platform === 'win32' && privateKb > 0) {
    return { kb: privateKb, metric: 'privateBytes' };
  }
  if (workingKb > 0) return { kb: workingKb, metric: 'workingSetSize' };
  if (privateKb > 0) return { kb: privateKb, metric: 'privateBytes' };
  return { kb: 0, metric: process.platform === 'win32' ? 'privateBytes' : 'workingSetSize' };
}

function metricLabel() {
  return process.platform === 'win32' ? 'privateBytes' : 'workingSetSize';
}

/**
 * Classify a process for the RAM breakdown.
 * @param {Electron.ProcessMetric} m
 * @param {Set<number>} panelPids
 * @param {number} uiPid
 */
function classifyProcess(m, panelPids, uiPid) {
  const type = String(m.type || '').toLowerCase();
  if (panelPids.has(m.pid)) return 'panels';
  if (type === 'gpu' || type.includes('gpu')) return 'gpu';
  if (m.pid === process.pid || type === 'browser') return 'interface';
  if (uiPid && m.pid === uiPid) return 'interface';
  if (type === 'tab' || type === 'renderer' || type.includes('render')) return 'interface';
  return 'outros';
}

/**
 * Electron ProcessMetric.memory.workingSetSize / privateBytes are in KB.
 */
function collectMetrics() {
  const appMetrics = app.getAppMetrics();
  const byPid = new Map();
  for (const m of appMetrics) byPid.set(m.pid, m);

  const preferredMetric = metricLabel();
  let totalKb = 0;
  let totalCpu = 0;
  for (const m of appMetrics) {
    const picked = pickProcessKb(m.memory);
    totalKb += picked.kb;
    totalCpu += Number(m.cpu && m.cpu.percentCPUUsage) || 0;
  }

  const forceSuspended = panels.getForceSuspendedIds();
  const visible = panels.getVisibleAccountIds();
  const focused = panels.getFocusedAccountId();
  const st = getState();
  const wsName = (id) => {
    const w = st.workspaces.find((x) => x.id === id);
    return w ? w.name : '';
  };

  /** @type {Map<number, string[]>} pid -> accountIds sharing that process */
  const pidOwners = new Map();
  /** @type {Map<string, number>} */
  const accountPid = new Map();

  for (const acc of st.accounts) {
    if (!panels.isPanelActive(acc.id)) continue;
    const wc = panels.getPanelCapture(acc.id);
    if (!wc) continue;
    let pid = 0;
    try {
      pid = wc.getOSProcessId();
    } catch {
      pid = 0;
    }
    if (!pid) continue;
    accountPid.set(acc.id, pid);
    const list = pidOwners.get(pid) || [];
    list.push(acc.id);
    pidOwners.set(pid, list);
  }

  const panelPids = new Set(pidOwners.keys());
  let uiPid = 0;
  try {
    uiPid = panels.getMainUiProcessId();
  } catch {
    uiPid = 0;
  }

  let panelsKb = 0;
  let interfaceKb = 0;
  let gpuKb = 0;
  let outrosKb = 0;
  for (const m of appMetrics) {
    const { kb } = pickProcessKb(m.memory);
    const bucket = classifyProcess(m, panelPids, uiPid);
    if (bucket === 'panels') panelsKb += kb;
    else if (bucket === 'gpu') gpuKb += kb;
    else if (bucket === 'interface') interfaceKb += kb;
    else outrosKb += kb;
  }

  /** PIDs already fully attributed to a panel row (avoid double-count). */
  const attributedPids = new Set();

  /** @type {Array<object>} */
  const panelRows = [];
  for (const acc of st.accounts) {
    const active = panels.isPanelActive(acc.id);
    const forced = forceSuspended.has(acc.id);
    let ramKb = 0;
    let cpu = 0;
    let pid = accountPid.get(acc.id) || 0;
    let shared = false;
    /** @type {string[]} */
    let sharedWith = [];

    if (active && pid) {
      const owners = pidOwners.get(pid) || [acc.id];
      shared = owners.length > 1;
      sharedWith = owners.filter((id) => id !== acc.id);
      const m = byPid.get(pid);
      if (m) {
        cpu = Number(m.cpu && m.cpu.percentCPUUsage) || 0;
        if (!attributedPids.has(pid)) {
          // Attribute full process RAM to the first account that owns it
          ramKb = pickProcessKb(m.memory).kb;
          attributedPids.add(pid);
        } else {
          ramKb = 0;
        }
      }
    }

    let panelState = 'suspenso';
    if (active) panelState = 'ativo';
    else if (forced) panelState = 'suspenso';
    else if (!visible.has(acc.id)) panelState = 'oculto';

    const ramMb = Math.round(ramKb / 1024);
    panelRows.push({
      accountId: acc.id,
      name: acc.name,
      workspaceId: acc.workspaceId,
      workspaceName: wsName(acc.workspaceId),
      state: panelState,
      active,
      suspended: !active,
      forced,
      visible: visible.has(acc.id),
      focused: focused === acc.id,
      workingSetKb: Number(byPid.get(pid)?.memory?.workingSetSize) || 0,
      privateBytesKb: Number(byPid.get(pid)?.memory?.privateBytes) || 0,
      ramKb,
      ramMb,
      metric: preferredMetric,
      shared,
      sharedWith,
      cpu: Math.round(cpu * 10) / 10,
      pid,
      lastUsedAt: panels.getLastUsedAt(acc.id),
    });
  }

  const breakdown = {
    panelsMb: Math.round(panelsKb / 1024),
    interfaceMb: Math.round(interfaceKb / 1024),
    gpuMb: Math.round(gpuKb / 1024),
    outrosMb: Math.round(outrosKb / 1024),
  };
  // Ensure rounded parts sum to rounded total (±1 MB) by adjusting "outros"
  const partsSum =
    breakdown.panelsMb + breakdown.interfaceMb + breakdown.gpuMb + breakdown.outrosMb;
  const totalRamMb = Math.round(totalKb / 1024);
  if (partsSum !== totalRamMb) {
    breakdown.outrosMb += totalRamMb - partsSum;
  }

  lastTotalKb = totalKb;
  return {
    at: Date.now(),
    metric: preferredMetric,
    metricLabel: preferredMetric,
    totalWorkingKb: appMetrics.reduce(
      (n, m) => n + (Number(m.memory && m.memory.workingSetSize) || 0),
      0
    ),
    totalPrivateKb: appMetrics.reduce(
      (n, m) => n + (Number(m.memory && m.memory.privateBytes) || 0),
      0
    ),
    totalKb,
    totalRamMb,
    totalCpu: Math.round(totalCpu * 10) / 10,
    breakdown,
    panels: panelRows,
    processCount: appMetrics.length,
  };
}

function publishMetrics(metrics) {
  emitToRenderer({ type: 'memory:metrics', metrics });
}

async function tick() {
  const metrics = collectMetrics();
  publishMetrics(metrics);
  panels.applyThrottling();
  await enforce(metrics);
}

function overLimit(metrics) {
  const settings = getState().settings;
  const globalMb = Number(settings.memoryLimitMb) || 0;
  const panelMb = Number(settings.panelMemoryLimitMb) || 0;
  const totalMb = metrics.totalRamMb;

  let globalOver = false;
  if (globalMb > 0 && totalMb > globalMb) globalOver = true;

  /** @type {string[]} */
  const panelsOver = [];
  if (panelMb > 0) {
    for (const p of metrics.panels) {
      if (p.active && p.ramMb > panelMb) panelsOver.push(p.accountId);
    }
  }

  return { globalOver, panelsOver, globalMb, panelMb, totalMb };
}

async function enforce(metrics) {
  const settings = getState().settings;
  const globalMb = Number(settings.memoryLimitMb) || 0;
  const panelMb = Number(settings.panelMemoryLimitMb) || 0;
  if (globalMb <= 0 && panelMb <= 0) {
    pressureBand = 'ok';
    return;
  }

  const { globalOver, panelsOver } = overLimit(metrics);
  const hard = !!settings.hardMemoryLimit;

  if (globalMb > 0) {
    if (metrics.totalRamMb > globalMb) pressureBand = 'over';
    else if (metrics.totalRamMb < globalMb * HYSTERESIS_RATIO) pressureBand = 'ok';
  } else if (panelsOver.length) {
    pressureBand = 'over';
  } else {
    pressureBand = 'ok';
  }

  const now = Date.now();
  if (now - lastEnforceAt < ENFORCE_COOLDOWN_MS) return;

  for (const accountId of panelsOver) {
    const visible = panels.getVisibleAccountIds().has(accountId);
    if (!visible) {
      panels.suspendForMemory(accountId, { force: false });
      lastEnforceAt = now;
    } else if (hard) {
      const focused = panels.getFocusedAccountId();
      if (accountId !== focused) {
        panels.suspendForMemory(accountId, { force: true });
        lastEnforceAt = now;
      }
    }
  }

  if (!globalOver && pressureBand !== 'over') return;
  if (globalMb > 0 && metrics.totalRamMb <= globalMb && !panelsOver.length) return;

  const candidates = metrics.panels
    .filter((p) => p.active && !p.visible)
    .sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));

  for (const p of candidates) {
    if (metrics.totalRamMb <= globalMb && globalMb > 0 && !panelsOver.length) break;
    panels.suspendForMemory(p.accountId, { force: false });
    lastEnforceAt = now;
    const again = collectMetrics();
    Object.assign(metrics, again);
    if (globalMb > 0 && metrics.totalRamMb <= globalMb * HYSTERESIS_RATIO) {
      pressureBand = 'ok';
      publishMetrics(metrics);
      return;
    }
  }

  if (!hard) {
    publishMetrics(collectMetrics());
    return;
  }

  const focused = panels.getFocusedAccountId();
  const visibleCandidates = metrics.panels
    .filter((p) => p.active && p.visible && p.accountId !== focused)
    .sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));

  for (const p of visibleCandidates) {
    if (globalMb > 0 && metrics.totalRamMb <= globalMb) break;
    panels.suspendForMemory(p.accountId, { force: true });
    lastEnforceAt = now;
    const again = collectMetrics();
    Object.assign(metrics, again);
    if (globalMb > 0 && metrics.totalRamMb <= globalMb * HYSTERESIS_RATIO) break;
  }

  publishMetrics(collectMetrics());
}

async function freeMemory() {
  panels.clearViewMutationLog();
  const before = collectMetrics();
  const beforeMb = before.totalRamMb;

  // Snapshot visible panel bounds — must not change during this op
  const visibleBefore = panels.snapshotVisiblePanelBounds();

  // Clear HTTP cache only (not cookies/storage); do not touch visible views
  await panels.clearAllPartitionCaches();

  // Suspend all hidden panels only
  for (const id of panels.listActivePanelIds()) {
    if (!panels.getVisibleAccountIds().has(id)) {
      panels.suspendForMemory(id, { force: false });
    }
  }

  // Mild GC on hidden only — never invalidate visible panels
  panels.hintGarbageCollection({ hiddenOnly: true });

  await new Promise((r) => setTimeout(r, FREE_SETTLE_MS));
  const after = collectMetrics();
  publishMetrics(after);
  const afterMb = after.totalRamMb;
  const rawFreed = beforeMb - afterMb;
  const freedMb = rawFreed > 0 ? rawFreed : 0;

  const visibleAfter = panels.snapshotVisiblePanelBounds();
  const visibleUnchanged = panels.compareBoundsMaps(visibleBefore, visibleAfter);
  const mutations = panels.getViewMutationLog();

  const result = {
    beforeMb,
    afterMb,
    freedMb,
    metric: before.metric,
    visibleUnchanged,
    mutations,
  };
  emitToRenderer({ type: 'memory:freed', ...result });
  return result;
}

function getLatestMetrics() {
  return collectMetrics();
}

module.exports = {
  initMemory,
  stopMemory,
  collectMetrics,
  freeMemory,
  getLatestMetrics,
  enforce,
  pickProcessKb,
  metricLabel,
  FREE_SETTLE_MS,
};
