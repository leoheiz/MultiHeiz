'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5;

let logStream = null;
let logFile = null;
/** @type {string[]} */
const writeQueue = [];
/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null;
const FLUSH_MS = 250;

function logsDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function currentLogPath() {
  if (!logFile) {
    const stamp = new Date().toISOString().slice(0, 10);
    logFile = path.join(logsDir(), `main-${stamp}.log`);
  }
  return logFile;
}

function ensureStream() {
  const file = currentLogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotateIfNeeded(file);
  if (!logStream) {
    logStream = fs.createWriteStream(file, { flags: 'a' });
  }
  return logStream;
}

function rotateIfNeeded(file) {
  try {
    if (!fs.existsSync(file)) return;
    const st = fs.statSync(file);
    if (st.size < MAX_BYTES) return;
    const rotated = `${file}.${Date.now()}.bak`;
    fs.renameSync(file, rotated);
    if (logStream) {
      try {
        logStream.end();
      } catch {
        /* ignore */
      }
      logStream = null;
    }
    pruneOld(path.dirname(file));
  } catch {
    /* ignore */
  }
}

function pruneOld(dir) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.log') || f.endsWith('.bak'))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const extra of files.slice(MAX_FILES)) {
      try {
        fs.unlinkSync(path.join(dir, extra.f));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function flushQueue() {
  flushTimer = null;
  if (!writeQueue.length) return;
  try {
    const stream = ensureStream();
    const chunk = writeQueue.splice(0, writeQueue.length).join('');
    stream.write(chunk);
  } catch {
    writeQueue.length = 0;
  }
}

function write(level, message, meta) {
  try {
    const line = {
      t: new Date().toISOString(),
      level,
      message: String(message || ''),
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

function info(msg, meta) {
  write('info', msg, meta);
}

function warn(msg, meta) {
  write('warn', msg, meta);
}

function error(msg, meta) {
  write('error', msg, meta);
}

function readRecent(maxLines = 200) {
  try {
    const dir = logsDir();
    if (!fs.existsSync(dir)) return [];
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const lines = [];
    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf8');
      const parts = raw.split('\n').filter(Boolean);
      for (let i = parts.length - 1; i >= 0 && lines.length < maxLines; i--) {
        lines.push(parts[i]);
      }
      if (lines.length >= maxLines) break;
    }
    return lines.reverse();
  } catch {
    return [];
  }
}

function close() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushQueue();
  if (logStream) {
    try {
      logStream.end();
    } catch {
      /* ignore */
    }
    logStream = null;
  }
}

module.exports = {
  info,
  warn,
  error,
  readRecent,
  logsDir,
  currentLogPath,
  close,
  flushQueue,
};
