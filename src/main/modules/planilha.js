'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, BrowserWindow } = require('electron');

let ExcelJS = null;
function getExcelJS() {
  if (!ExcelJS) ExcelJS = require('exceljs');
  return ExcelJS;
}

function modulesDir() {
  const dir = path.join(app.getPath('userData'), 'modules', 'planilha');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptySheet(name = 'Planilha1') {
  return { id: makeId('sheet'), name, cells: {} };
}

function emptyWorkbook(name = 'Pasta de trabalho') {
  return {
    id: makeId('wb'),
    name,
    sheets: [emptySheet()],
    activeSheetId: null,
    updatedAt: Date.now(),
  };
}

function listWorkbooks() {
  const dir = modulesDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.bak'));
  const list = [];
  const { readJsonDurable } = require('../json-store');
  for (const f of files) {
    try {
      const result = readJsonDurable(path.join(dir, f), () => null, `modules/planilha/${f}`);
      const raw = result.data;
      if (!raw || typeof raw !== 'object') continue;
      list.push({
        id: raw.id || path.basename(f, '.json'),
        name: raw.name || 'Sem título',
        updatedAt: raw.updatedAt || 0,
        sheetCount: (raw.sheets || []).length,
      });
    } catch {
      /* ignore */
    }
  }
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function workbookPath(id) {
  return path.join(modulesDir(), `${id}.json`);
}

function loadWorkbook(id) {
  const file = workbookPath(id);
  if (!fs.existsSync(file) && !fs.existsSync(`${file}.bak`)) return null;
  try {
    const { readJsonDurable } = require('../json-store');
    const result = readJsonDurable(file, () => null, `modules/planilha/${id}.json`);
    const wb = result.data;
    if (!wb || typeof wb !== 'object') return null;
    if (!wb.activeSheetId && wb.sheets && wb.sheets[0]) wb.activeSheetId = wb.sheets[0].id;
    return wb;
  } catch {
    return null;
  }
}

function saveWorkbook(wb) {
  if (!wb || !wb.id) return null;
  wb.updatedAt = Date.now();
  if (!wb.activeSheetId && wb.sheets && wb.sheets[0]) wb.activeSheetId = wb.sheets[0].id;
  const file = workbookPath(wb.id);
  try {
    const { writeJsonDurable } = require('../json-store');
    writeJsonDurable(file, wb);
  } catch (err) {
    console.error('[planilha] saveWorkbook:', err && err.message);
    return null;
  }
  return wb;
}

function createWorkbook(name) {
  const wb = emptyWorkbook(name);
  wb.activeSheetId = wb.sheets[0].id;
  return saveWorkbook(wb);
}

function deleteWorkbook(id) {
  const file = workbookPath(id);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
  return true;
}

function colToLetters(col) {
  let n = col;
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function lettersToCol(letters) {
  let n = 0;
  const s = String(letters || '').toUpperCase();
  for (let i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 64);
  }
  return n - 1;
}

function parseCellRef(ref) {
  const m = String(ref || '')
    .toUpperCase()
    .match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  return { col: lettersToCol(m[1]), row: Number(m[2]) - 1 };
}

function cellKey(col, row) {
  return `${colToLetters(col)}${row + 1}`;
}

/** A1-style single cell ref from 0-based col/row */
function formatCellRef(col, row) {
  return cellKey(col, row);
}

/**
 * Range ref A1:B3 (normalized top-left → bottom-right).
 * Same cell → single ref.
 */
function formatRangeRef(c0, r0, c1, r1) {
  const ca = Math.min(c0, c1);
  const cb = Math.max(c0, c1);
  const ra = Math.min(r0, r1);
  const rb = Math.max(r0, r1);
  if (ca === cb && ra === rb) return cellKey(ca, ra);
  return `${cellKey(ca, ra)}:${cellKey(cb, rb)}`;
}

/**
 * Column ref for formula mode: prefer A:A; fallback A1:A<lastRow> if preferFull=false.
 * @param {number} col 0-based
 * @param {{ lastRow?: number, style?: 'full' | 'bounded' }} [opts]
 */
function formatColumnRef(col, opts) {
  const letters = colToLetters(col);
  const style = (opts && opts.style) || 'full';
  if (style === 'bounded') {
    const lastRow = Math.max(1, Number((opts && opts.lastRow) || 20));
    return `${letters}1:${letters}${lastRow}`;
  }
  return `${letters}:${letters}`;
}

/**
 * Insert a ref into a formula draft (value already starts with '=' or empty).
 * Returns the new raw string.
 */
function insertFormulaRef(currentRaw, refText) {
  let raw = currentRaw == null ? '' : String(currentRaw);
  if (!raw.startsWith('=')) raw = '=' + raw;
  // If ends with a cell/range token, replace it when building ranges via shift — caller decides.
  return raw + refText;
}

/**
 * True when the editor is in formula-entry mode (raw starts with '=').
 */
function isFormulaMode(raw) {
  return typeof raw === 'string' && raw.startsWith('=');
}

function getCellRaw(sheet, col, row) {
  const key = cellKey(col, row);
  const c = sheet.cells && sheet.cells[key];
  return c ? c.raw : '';
}

function setCell(sheet, ref, raw) {
  const parsed = parseCellRef(ref);
  if (!parsed) return null;
  const key = cellKey(parsed.col, parsed.row);
  if (!sheet.cells) sheet.cells = {};
  const value = String(raw == null ? '' : raw);
  if (!value) {
    delete sheet.cells[key];
  } else {
    sheet.cells[key] = { raw: value };
  }
  return key;
}

/* ---- Formula engine ---- */

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  const s = expr;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if ('+-*/(),:<>!='.includes(ch)) {
      if ((ch === '<' || ch === '>' || ch === '!') && s[i + 1] === '=') {
        tokens.push(ch + '=');
        i += 2;
      } else if (ch === '<' && s[i + 1] === '>') {
        tokens.push('<>');
        i += 2;
      } else {
        tokens.push(ch);
        i++;
      }
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let str = '';
      while (j < s.length && s[j] !== '"') {
        str += s[j++];
      }
      tokens.push({ type: 'str', value: str });
      i = j + 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      tokens.push({ type: 'num', value: Number(s.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      const word = s.slice(i, j).toUpperCase();
      tokens.push({ type: 'id', value: word });
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

function evaluateSheet(sheet) {
  /** @type {Map<string, {value: any, error?: string}>} */
  const cache = new Map();
  /** @type {Set<string>} */
  const stack = new Set();

  function evalCell(ref) {
    const key = String(ref).toUpperCase();
    if (cache.has(key)) return cache.get(key).value;
    if (stack.has(key)) return '#CYCLE!';
    stack.add(key);
    const raw = (sheet.cells && sheet.cells[key] && sheet.cells[key].raw) || '';
    let result;
    if (typeof raw === 'string' && raw.startsWith('=')) {
      try {
        result = evalExpr(raw.slice(1), evalCell);
      } catch (err) {
        result = '#ERROR!';
      }
    } else if (raw === '' || raw == null) {
      result = 0;
    } else if (!Number.isNaN(Number(raw)) && String(raw).trim() !== '') {
      result = Number(raw);
    } else {
      result = raw;
    }
    cache.set(key, { value: result });
    stack.delete(key);
    return result;
  }

  function sheetMaxRow() {
    let max = 0;
    for (const key of Object.keys(sheet.cells || {})) {
      const p = parseCellRef(key);
      if (p && p.row > max) max = p.row;
    }
    return Math.max(max, 19); // at least 20 rows (0..19)
  }

  function expandRange(a, b) {
    // Column-only refs: A:A or A:C
    const colOnly = /^([A-Z]+)$/;
    const aCol = colOnly.exec(String(a || '').toUpperCase());
    const bCol = colOnly.exec(String(b || '').toUpperCase());
    if (aCol && bCol) {
      const c0 = Math.min(lettersToCol(aCol[1]), lettersToCol(bCol[1]));
      const c1 = Math.max(lettersToCol(aCol[1]), lettersToCol(bCol[1]));
      const r1 = sheetMaxRow();
      const vals = [];
      for (let r = 0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          vals.push(evalCell(cellKey(c, r)));
        }
      }
      return vals;
    }
    const pa = parseCellRef(a);
    const pb = parseCellRef(b);
    if (!pa || !pb) return [];
    const vals = [];
    const c0 = Math.min(pa.col, pb.col);
    const c1 = Math.max(pa.col, pb.col);
    const r0 = Math.min(pa.row, pb.row);
    const r1 = Math.max(pa.row, pb.row);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        vals.push(evalCell(cellKey(c, r)));
      }
    }
    return vals;
  }

  function toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) return Number(v);
    if (v === true) return 1;
    if (v === false) return 0;
    return 0;
  }

  function evalExpr(expr, cellEval) {
    const tokens = tokenize(expr);
    let pos = 0;

    function peek() {
      return tokens[pos];
    }
    function next() {
      return tokens[pos++];
    }

    function parseComparison() {
      let left = parseAdd();
      while (peek() === '=' || peek() === '<>' || peek() === '<' || peek() === '>' || peek() === '<=' || peek() === '>=') {
        const op = next();
        const right = parseAdd();
        if (op === '=') left = left == right; // eslint-disable-line eqeqeq
        else if (op === '<>') left = left != right; // eslint-disable-line eqeqeq
        else if (op === '<') left = toNum(left) < toNum(right);
        else if (op === '>') left = toNum(left) > toNum(right);
        else if (op === '<=') left = toNum(left) <= toNum(right);
        else if (op === '>=') left = toNum(left) >= toNum(right);
      }
      return left;
    }

    function parseAdd() {
      let left = parseMul();
      while (peek() === '+' || peek() === '-') {
        const op = next();
        const right = parseMul();
        left = op === '+' ? toNum(left) + toNum(right) : toNum(left) - toNum(right);
      }
      return left;
    }

    function parseMul() {
      let left = parseUnary();
      while (peek() === '*' || peek() === '/') {
        const op = next();
        const right = parseUnary();
        left = op === '*' ? toNum(left) * toNum(right) : toNum(right) === 0 ? '#DIV/0!' : toNum(left) / toNum(right);
      }
      return left;
    }

    function parseUnary() {
      if (peek() === '-') {
        next();
        return -toNum(parseUnary());
      }
      if (peek() === '+') {
        next();
        return parseUnary();
      }
      return parsePrimary();
    }

    function parsePrimary() {
      const t = peek();
      if (!t) return 0;
      if (t && t.type === 'num') {
        next();
        return t.value;
      }
      if (t && t.type === 'str') {
        next();
        return t.value;
      }
      if (t && t.type === 'id') {
        next();
        const name = t.value;
        if (peek() === '(') {
          next();
          const args = [];
          if (peek() !== ')') {
            args.push(parseArg());
            while (peek() === ',') {
              next();
              args.push(parseArg());
            }
          }
          if (peek() === ')') next();
          return callFn(name, args);
        }
        // cell ref
        if (/^[A-Z]+\d+$/.test(name)) return cellEval(name);
        return 0;
      }
      if (t === '(') {
        next();
        const v = parseComparison();
        if (peek() === ')') next();
        return v;
      }
      next();
      return 0;
    }

    function parseArg() {
      // range A1:B2
      const start = parseComparison();
      if (peek() === ':') {
        next();
        // Need left and right as cell refs — recover from tokens is hard;
        // instead parse as id:id at higher level. Fallback: if start was number from cell, re-read.
        return start;
      }
      return start;
    }

    function flattenArgs(args) {
      const out = [];
      for (const a of args) {
        if (Array.isArray(a)) out.push(...a);
        else out.push(a);
      }
      return out;
    }

    function callFn(name, args) {
      // Detect ranges encoded as special objects
      const flat = [];
      for (const a of args) {
        if (a && a.__range) flat.push(...a.__range);
        else if (Array.isArray(a)) flat.push(...a);
        else flat.push(a);
      }
      const nums = flat.map(toNum).filter((n) => typeof n === 'number' && !Number.isNaN(n));
      switch (name) {
        case 'SUM':
          return nums.reduce((a, b) => a + b, 0);
        case 'AVERAGE':
        case 'AVG':
          return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
        case 'MIN':
          return nums.length ? Math.min(...nums) : 0;
        case 'MAX':
          return nums.length ? Math.max(...nums) : 0;
        case 'IF': {
          const cond = flat[0];
          const truthy = cond === true || (typeof cond === 'number' && cond !== 0) || (typeof cond === 'string' && cond !== '' && cond !== '0');
          return truthy ? (flat[1] != null ? flat[1] : true) : flat[2] != null ? flat[2] : false;
        }
        default:
          return '#NAME?';
      }
    }

    // Preprocess ranges: A1:B2 and column A:A / A:C
    const expanded = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const t2 = tokens[i + 2];
      if (
        t &&
        t.type === 'id' &&
        tokens[i + 1] === ':' &&
        t2 &&
        t2.type === 'id' &&
        (/^[A-Z]+\d+$/.test(t.value) || /^[A-Z]+$/.test(t.value)) &&
        (/^[A-Z]+\d+$/.test(t2.value) || /^[A-Z]+$/.test(t2.value))
      ) {
        const vals = expandRange(t.value, t2.value);
        expanded.push({ type: 'range', value: vals });
        i += 2;
      } else {
        expanded.push(t);
      }
    }
    tokens.length = 0;
    tokens.push(...expanded);

    // Patch parsePrimary for range tokens and callFn args
    const origParsePrimary = parsePrimary;
    parsePrimary = function () {
      const t = peek();
      if (t && t.type === 'range') {
        next();
        return { __range: t.value };
      }
      return origParsePrimary();
    };

    const result = parseComparison();
    return result && result.__range ? result.__range[0] : result;
  }

  // Evaluate all cells that have formulas or values
  const display = {};
  for (const key of Object.keys(sheet.cells || {})) {
    display[key] = { raw: sheet.cells[key].raw, value: evalCell(key) };
  }
  return display;
}

function getEvaluatedWorkbook(id) {
  const wb = loadWorkbook(id);
  if (!wb) return null;
  const sheets = (wb.sheets || []).map((sh) => ({
    ...sh,
    display: evaluateSheet(sh),
  }));
  return { ...wb, sheets };
}

function updateCell(workbookId, sheetId, ref, raw) {
  const wb = loadWorkbook(workbookId);
  if (!wb) return null;
  const sheet = (wb.sheets || []).find((s) => s.id === sheetId);
  if (!sheet) return null;
  setCell(sheet, ref, raw);
  saveWorkbook(wb);
  return getEvaluatedWorkbook(workbookId);
}

function addSheet(workbookId, name) {
  const wb = loadWorkbook(workbookId);
  if (!wb) return null;
  const sheet = emptySheet(name || `Planilha${(wb.sheets || []).length + 1}`);
  wb.sheets.push(sheet);
  wb.activeSheetId = sheet.id;
  saveWorkbook(wb);
  return getEvaluatedWorkbook(workbookId);
}

function renameSheet(workbookId, sheetId, name) {
  const wb = loadWorkbook(workbookId);
  if (!wb) return null;
  const sheet = (wb.sheets || []).find((s) => s.id === sheetId);
  if (!sheet) return null;
  sheet.name = String(name || '').trim() || sheet.name;
  saveWorkbook(wb);
  return getEvaluatedWorkbook(workbookId);
}

function deleteSheet(workbookId, sheetId) {
  const wb = loadWorkbook(workbookId);
  if (!wb || (wb.sheets || []).length <= 1) return null;
  wb.sheets = wb.sheets.filter((s) => s.id !== sheetId);
  if (wb.activeSheetId === sheetId) wb.activeSheetId = wb.sheets[0].id;
  saveWorkbook(wb);
  return getEvaluatedWorkbook(workbookId);
}

function setActiveSheet(workbookId, sheetId) {
  const wb = loadWorkbook(workbookId);
  if (!wb) return null;
  if (!(wb.sheets || []).some((s) => s.id === sheetId)) return null;
  wb.activeSheetId = sheetId;
  saveWorkbook(wb);
  return getEvaluatedWorkbook(workbookId);
}

function renameWorkbook(id, name) {
  const wb = loadWorkbook(id);
  if (!wb) return null;
  wb.name = String(name || '').trim() || wb.name;
  saveWorkbook(wb);
  return getEvaluatedWorkbook(id);
}

async function exportXlsx(workbookId, mainWindow) {
  const wb = loadWorkbook(workbookId);
  if (!wb) return { ok: false };
  const win = mainWindow || BrowserWindow.getFocusedWindow();
  const result = await dialog.showSaveDialog(win || undefined, {
    title: 'Exportar planilha',
    defaultPath: `${wb.name || 'planilha'}.xlsx`,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  const workbook = new (getExcelJS()).Workbook();
  workbook.creator = 'MultiHeiz';
  for (const sh of wb.sheets || []) {
    const ws = workbook.addWorksheet(sh.name || 'Sheet');
    for (const [ref, cell] of Object.entries(sh.cells || {})) {
      const parsed = parseCellRef(ref);
      if (!parsed) continue;
      const excelCell = ws.getCell(parsed.row + 1, parsed.col + 1);
      const raw = cell.raw;
      if (typeof raw === 'string' && raw.startsWith('=')) {
        excelCell.value = { formula: raw.slice(1) };
      } else if (!Number.isNaN(Number(raw)) && String(raw).trim() !== '') {
        excelCell.value = Number(raw);
      } else {
        excelCell.value = raw;
      }
    }
  }
  await workbook.xlsx.writeFile(result.filePath);
  return { ok: true, path: result.filePath };
}

async function importXlsx(mainWindow) {
  const win = mainWindow || BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win || undefined, {
    title: 'Importar planilha',
    filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) {
    return { ok: false, canceled: true };
  }
  const filePath = result.filePaths[0];
  const workbook = new (getExcelJS()).Workbook();
  await workbook.xlsx.readFile(filePath);
  const wb = emptyWorkbook(path.basename(filePath, path.extname(filePath)));
  wb.sheets = [];
  workbook.eachSheet((ws) => {
    const sheet = emptySheet(ws.name || 'Planilha');
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const ref = cellKey(colNumber - 1, rowNumber - 1);
        let raw = '';
        if (cell.formula) raw = `=${cell.formula}`;
        else if (cell.value != null && typeof cell.value === 'object' && cell.value.formula) {
          raw = `=${cell.value.formula}`;
        } else if (cell.value != null) raw = String(cell.value.result != null ? cell.value.result : cell.value);
        if (raw !== '') {
          if (!sheet.cells) sheet.cells = {};
          sheet.cells[ref] = { raw };
        }
      });
    });
    wb.sheets.push(sheet);
  });
  if (!wb.sheets.length) wb.sheets.push(emptySheet());
  wb.activeSheetId = wb.sheets[0].id;
  saveWorkbook(wb);
  return { ok: true, workbook: getEvaluatedWorkbook(wb.id) };
}

/** Test helper: set cells and evaluate without dialogs */
function applyCellsForTest(workbookId, sheetId, cellsMap) {
  const wb = loadWorkbook(workbookId);
  if (!wb) return null;
  const sheet = (wb.sheets || []).find((s) => s.id === sheetId);
  if (!sheet) return null;
  for (const [ref, raw] of Object.entries(cellsMap || {})) {
    setCell(sheet, ref, raw);
  }
  saveWorkbook(wb);
  return getEvaluatedWorkbook(workbookId);
}

async function exportXlsxToPath(workbookId, filePath) {
  const wb = loadWorkbook(workbookId);
  if (!wb) return { ok: false };
  const workbook = new (getExcelJS()).Workbook();
  for (const sh of wb.sheets || []) {
    const ws = workbook.addWorksheet(sh.name || 'Sheet');
    for (const [ref, cell] of Object.entries(sh.cells || {})) {
      const parsed = parseCellRef(ref);
      if (!parsed) continue;
      const excelCell = ws.getCell(parsed.row + 1, parsed.col + 1);
      const raw = cell.raw;
      if (typeof raw === 'string' && raw.startsWith('=')) {
        excelCell.value = { formula: raw.slice(1) };
      } else if (!Number.isNaN(Number(raw)) && String(raw).trim() !== '') {
        excelCell.value = Number(raw);
      } else {
        excelCell.value = raw;
      }
    }
  }
  await workbook.xlsx.writeFile(filePath);
  return { ok: true, path: filePath };
}

async function importXlsxFromPath(filePath, name) {
  const workbook = new (getExcelJS()).Workbook();
  await workbook.xlsx.readFile(filePath);
  const wb = emptyWorkbook(name || path.basename(filePath, path.extname(filePath)));
  wb.sheets = [];
  workbook.eachSheet((ws) => {
    const sheet = emptySheet(ws.name || 'Planilha');
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const ref = cellKey(colNumber - 1, rowNumber - 1);
        let raw = '';
        if (cell.formula) raw = `=${cell.formula}`;
        else if (cell.value != null && typeof cell.value === 'object' && cell.value.formula) {
          raw = `=${cell.value.formula}`;
        } else if (cell.value != null) {
          raw = String(cell.value.result != null ? cell.value.result : cell.value);
        }
        if (raw !== '') {
          if (!sheet.cells) sheet.cells = {};
          sheet.cells[ref] = { raw };
        }
      });
    });
    wb.sheets.push(sheet);
  });
  if (!wb.sheets.length) wb.sheets.push(emptySheet());
  wb.activeSheetId = wb.sheets[0].id;
  saveWorkbook(wb);
  return getEvaluatedWorkbook(wb.id);
}

module.exports = {
  listWorkbooks,
  loadWorkbook,
  getEvaluatedWorkbook,
  createWorkbook,
  deleteWorkbook,
  renameWorkbook,
  updateCell,
  addSheet,
  renameSheet,
  deleteSheet,
  setActiveSheet,
  exportXlsx,
  importXlsx,
  exportXlsxToPath,
  importXlsxFromPath,
  applyCellsForTest,
  evaluateSheet,
  colToLetters,
  lettersToCol,
  parseCellRef,
  cellKey,
  formatCellRef,
  formatRangeRef,
  formatColumnRef,
  insertFormulaRef,
  isFormulaMode,
};
