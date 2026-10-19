'use strict';

/**
 * Tracks JSON store recoveries so the UI can toast once after the window is ready.
 */

const logger = require('./logger');

/** @type {{ store: string, from: 'bak'|'defaults' }[]} */
const pending = [];
let toastEmitted = false;

function noteRestore(store, from) {
  const src = from === 'bak' ? 'bak' : 'defaults';
  pending.push({ store: String(store || 'store'), from: src });
  try {
    logger.warn("Configuração restaurada do backup", { store, from: src });
  } catch {
    /* ignore */
  }
  console.warn('[recovery] ' + store + ': restored from ' + src);
}

function consumePending() {
  const list = pending.splice(0, pending.length);
  return list;
}

function hasPending() {
  return pending.length > 0;
}

/**
 * Emit a single toast after the renderer is ready (idempotent per process start).
 * @param {(payload: object) => void} emit
 */
function flushRecoveryToast(emit) {
  if (!pending.length || toastEmitted) {
    if (pending.length) consumePending();
    return false;
  }
  consumePending();
  toastEmitted = true;
  if (typeof emit === 'function') {
    emit({
      type: 'toast',
      message: "Configuração restaurada do backup",
    });
  }
  return true;
}

function resetForTests() {
  pending.length = 0;
  toastEmitted = false;
}

module.exports = {
  noteRestore,
  consumePending,
  hasPending,
  flushRecoveryToast,
  resetForTests,
};
