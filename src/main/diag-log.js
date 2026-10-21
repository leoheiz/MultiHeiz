'use strict';

/**
 * Rotating diagnostic error log (main + renderer console errors).
 * Max ~256 KB × 2 files under userData/logs (diag-errors.log + .1).
 *
 * Idle-safe: buffer + debounce, async appends only, errors-only from
 * console-message (never warnings/info on the hot path), rate-limited.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');

const MAX_BYTES = 256 * 1024;
const FILE_MAIN = 'diag-errors.log';
const FILE_PREV = 'diag-errors.log.1';

let writeQueue = [];
/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null;
const FLUSH_MS = 400;
/** @type {Promise<void>} */
let flushInFlight = Promise.resolve();

/** @type {number} */
let crashCount = 0;

/** Rate-limit renderer console errors (hot path). */
let rendererLogWindowStart = 0;
let rendererLogWindowCount = 0;
const RENDERER_LOG_MAX_PER_SEC = 8;

function logsDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function currentPath() {
  return path.join(logsDir(), FILE_MAIN);
}

function prevPath() {
  return path.join(logsDir(), FILE_PREV);
}

async function rotateIfNeededAsync() {
  try {
    const file = currentPath();
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      return;
    }
    if (st.size < MAX_BYTES) return;
    const prev = prevPath();
    try {
      await fsp.unlink(prev);
    } catch {
      /* ignore */
    }
    await fsp.rename(file, prev);
  } catch {
    /* ignore */
  }
}

function flushQueue() {
  flushTimer = null;
  if (!writeQueue.length) return;
  const chunk = writeQueue.splice(0, writeQueue.length).join('');
  flushInFlight = flushInFlight
    .then(async () => {
      try {
        const dir = logsDir();
        await fsp.mkdir(dir, { recursive: true });
        await rotateIfNeededAsync();
        await fsp.appendFile(currentPath(), chunk, 'utf8');
      } catch {
        /* drop on I/O failure — never block the event loop with sync fs */
      }
    })
    .catch(() => {});
}

/**
 * Sync flush for tests / report generation (awaits pending async write).
 */
function flushQueueSync() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (writeQueue.length) {
    try {
      const dir = logsDir();
      fs.mkdirSync(dir, { recursive: true });
      try {
        const file = currentPath();
        if (fs.existsSync(file)) {
          const st = fs.statSync(file);
          if (st.size >= MAX_BYTES) {
            const prev = prevPath();
            try {
              if (fs.existsSync(prev)) fs.unlinkSync(prev);
            } catch {
              /* ignore */
            }
            fs.renameSync(file, prev);
          }
        }
      } catch {
        /* ignore */
      }
      const chunk = writeQueue.splice(0, writeQueue.length).join('');
      fs.appendFileSync(currentPath(), chunk, 'utf8');
    } catch {
      writeQueue.length = 0;
    }
  }
}

/**
 * @param {string} source  main | renderer | crash
 * @param {string} message
 * @param {object} [meta]
 */
function append(source, message, meta) {
  try {
    const line = {
      t: new Date().toISOString(),
      source: String(source || 'main'),
      message: String(message || '').slice(0, 4000),
      ...(meta && typeof meta === 'object' ? { meta } : {}),
    };
    writeQueue.push(JSON.stringify(line) + '\n');
    if (!flushTimer) {
      flushTimer = setTimeout(flushQueue, FLUSH_MS);
      if (typeof flushTimer.unref === 'function') flushTimer.unref();
    }
  } catch {
    /* ignore */
  }
}

function recordMainError(message, meta) {
  append('main', message, meta);
}

function allowRendererLog() {
  const now = Date.now();
  if (now - rendererLogWindowStart >= 1000) {
    rendererLogWindowStart = now;
    rendererLogWindowCount = 0;
  }
  if (rendererLogWindowCount >= RENDERER_LOG_MAX_PER_SEC) return false;
  rendererLogWindowCount += 1;
  return true;
}

function recordRendererError(message, meta) {
  if (!allowRendererLog()) return;
  append('renderer', message, meta);
}

function recordCrash(kind, meta) {
  crashCount += 1;
  append('crash', kind || 'crash', { ...(meta || {}), crashCount });
}

function getCrashCount() {
  return crashCount;
}

function setCrashCountForTest(n) {
  crashCount = Number(n) || 0;
}

/**
 * @param {number} [maxLines]
 * @returns {string[]}
 */
function readRecent(maxLines = 80) {
  flushQueueSync();
  const lines = [];
  try {
    const files = [currentPath(), prevPath()].filter((f) => fs.existsSync(f));
    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf8');
      const parts = raw.split('\n').filter(Boolean);
      for (let i = parts.length - 1; i >= 0 && lines.length < maxLines; i--) {
        lines.push(parts[i]);
      }
      if (lines.length >= maxLines) break;
    }
  } catch {
    /* ignore */
  }
  return lines.reverse();
}

function installProcessHandlers() {
  process.on('uncaughtException', (err) => {
    try {
      recordMainError((err && err.message) || String(err), {
        stack: err && err.stack ? String(err.stack).slice(0, 2000) : undefined,
      });
    } catch {
      /* ignore */
    }
  });
  process.on('unhandledRejection', (reason) => {
    try {
      const msg =
        reason && typeof reason === 'object' && reason.message
          ? reason.message
          : String(reason);
      recordMainError('unhandledRejection: ' + msg);
    } catch {
      /* ignore */
    }
  });
}

/**
 * Attach render-process-gone / child-process-gone + console-message on a BrowserWindow.
 * console-message: errors only (level >= 3) — warnings are a hot path under Chromium.
 * @param {import('electron').BrowserWindow} win
 */
function attachWindow(win) {
  if (!win || !win.webContents) return;
  win.webContents.on('render-process-gone', (_e, details) => {
    recordCrash('render-process-gone', {
      reason: details && details.reason,
      exitCode: details && details.exitCode,
    });
  });
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // Electron: 0=debug 1=info 2=warning 3=error — skip warnings (hot / noisy).
    if (level < 3) return;
    recordRendererError(String(message || ''), {
      level,
      line,
      sourceId: sourceId ? String(sourceId).slice(0, 200) : undefined,
    });
  });
}

function attachAppCrashHooks(electronApp) {
  const a = electronApp || app;
  a.on('child-process-gone', (_e, details) => {
    recordCrash('child-process-gone', {
      type: details && details.type,
      reason: details && details.reason,
      exitCode: details && details.exitCode,
      name: details && details.name,
    });
  });
  a.on('render-process-gone', (_e, _wc, details) => {
    recordCrash('render-process-gone', {
      reason: details && details.reason,
      exitCode: details && details.exitCode,
    });
  });
}

module.exports = {
  MAX_BYTES,
  append,
  recordMainError,
  recordRendererError,
  recordCrash,
  getCrashCount,
  setCrashCountForTest,
  readRecent,
  installProcessHandlers,
  attachWindow,
  attachAppCrashHooks,
  logsDir,
  flushQueue: flushQueueSync,
};
