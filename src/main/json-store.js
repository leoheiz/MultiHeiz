'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const recovery = require('./recovery');

/**
 * Atomic JSON write: keep .bak of last good file, then tmp + rename.
 * Sync path used on quit / load repair. Prefer writeJsonDurableAsync on hot paths.
 * @param {string} file
 * @param {unknown} data
 */
function writeJsonDurable(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const bak = `${file}.bak`;
  // Copy previous primary to .bak without re-parsing (parse was a main-thread stall).
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, bak);
    } catch {
      /* don't fail the write if bak copy fails */
    }
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Async durable write — stringify may still cost a turn; fs I/O is non-blocking.
 * @param {string} file
 * @param {unknown} data
 * @returns {Promise<void>}
 */
async function writeJsonDurableAsync(file, data) {
  const fsp = fs.promises;
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const bak = `${file}.bak`;
  try {
    await fsp.access(file);
    try {
      await fsp.copyFile(file, bak);
    } catch {
      /* ignore bak errors */
    }
  } catch {
    /* file does not exist yet */
  }
  const tmp = `${file}.${process.pid}.tmp`;
  const text = JSON.stringify(data, null, 2);
  // Yield so the stringify cost is not stacked with the write syscall on the same turn.
  await new Promise((r) => setImmediate(r));
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Read JSON with .bak fallback. Never throws.
 * @param {string} file
 * @param {unknown|(() => unknown)} defaultData
 * @param {string} [storeName]
 * @returns {{ data: any, restored: false|'bak'|'defaults' }}
 */
function readJsonDurable(file, defaultData, storeName) {
  const name = storeName || path.basename(file);
  const defaults =
    typeof defaultData === 'function' ? defaultData() : structuredCloneSafe(defaultData);

  const tryParse = (p) => {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  };

  if (fs.existsSync(file)) {
    try {
      const parsed = tryParse(file);
      return { data: parsed, restored: false };
    } catch (err) {
      console.error(`[json-store] parse ${name}:`, err && err.message);
    }
  }

  const bak = `${file}.bak`;
  if (fs.existsSync(bak)) {
    try {
      const parsed = tryParse(bak);
      recovery.noteRestore(name, 'bak');
      try {
        writeJsonDurable(file, parsed);
      } catch {
        /* keep in-memory restored data even if rewrite fails */
      }
      return { data: parsed, restored: 'bak' };
    } catch (err) {
      console.error(`[json-store] bak parse ${name}:`, err && err.message);
    }
  }

  if (fs.existsSync(file) || fs.existsSync(bak)) {
    recovery.noteRestore(name, 'defaults');
  }
  return { data: defaults, restored: fs.existsSync(file) || fs.existsSync(bak) ? 'defaults' : false };
}

/**
 * Debounced atomic JSON file store under userData.
 */
function createJsonStore(fileName, defaultData, debounceMs = 400) {
  let data = typeof defaultData === 'function' ? defaultData() : structuredCloneSafe(defaultData);
  let timer = null;
  let filePath = null;

  function getPath() {
    if (!filePath) filePath = path.join(app.getPath('userData'), fileName);
    return filePath;
  }

  function load() {
    const file = getPath();
    const result = readJsonDurable(file, defaultData, fileName);
    const parsed = result.data;
    data =
      typeof defaultData === 'function'
        ? { ...defaultData(), ...(parsed && typeof parsed === 'object' ? parsed : {}) }
        : {
            ...structuredCloneSafe(defaultData),
            ...(parsed && typeof parsed === 'object' ? parsed : {}),
          };
    return data;
  }

  function get() {
    return data;
  }

  function set(next) {
    data = next;
    scheduleSave();
    return data;
  }

  function update(mutator) {
    mutator(data);
    scheduleSave();
    return data;
  }

  function scheduleSave() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveNow();
    }, debounceMs);
  }

  function saveNow() {
    const file = getPath();
    try {
      writeJsonDurable(file, data);
    } catch (err) {
      console.error(`[json-store] save ${fileName}:`, err && err.message);
    }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    saveNow();
  }

  return { load, get, set, update, flush, getPath, scheduleSave, saveNow };
}

function structuredCloneSafe(obj) {
  return JSON.parse(JSON.stringify(obj));
}

module.exports = {
  createJsonStore,
  writeJsonDurable,
  writeJsonDurableAsync,
  readJsonDurable,
};
