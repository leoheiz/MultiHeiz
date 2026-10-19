'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const recovery = require('./recovery');

/**
 * Atomic JSON write: keep .bak of last good file, then tmp + rename.
 * @param {string} file
 * @param {unknown} data
 */
function writeJsonDurable(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const bak = `${file}.bak`;
  if (fs.existsSync(file)) {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.copyFileSync(file, bak);
    } catch {
      /* don't clobber a good .bak with a corrupt primary */
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
  readJsonDurable,
};
