'use strict';

/**
 * Volume fino por janela (0–200% com reforço).
 * Electron não tem volume por webContents: injeta GainNode no main world
 * e aplica o valor em todos os frames possíveis.
 *
 * Limitações:
 * - Cross-origin sem CORS → element.volume ≤100%, sem reforço nesse elemento
 * - WebRTC/MediaStream → não roteia createMediaElementSource (evita eco)
 * - Iframes de outro processo / sem preload podem não receber injeção
 */

const { ipcMain } = require('electron');
const { getVolumeInjectSource } = require('./volume-inject-source');

/** @type {((wc: import('electron').WebContents) => string|null) | null} */
let resolveAccountId = null;
/** @type {((accountId: string) => object|null) | null} */
let getAccount = null;
let ipcInstalled = false;

/**
 * Normaliza percentual 0–200 (inteiro). Default 100.
 * @param {unknown} v
 * @returns {number}
 */
function normalizeVolumePercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(200, Math.round(n)));
}

/**
 * @param {number} percent
 * @returns {number} linear gain 0–2
 */
function percentToGain(percent) {
  return normalizeVolumePercent(percent) / 100;
}

/**
 * Volume percentual de uma conta (default 100).
 * @param {object|null|undefined} account
 */
function volumeOfAccount(account) {
  if (!account) return 100;
  return normalizeVolumePercent(account.volume);
}

/**
 * Executa JS em todos os frames do webContents (mesmo processo).
 * @param {import('electron').WebContents} wc
 * @param {string} code
 */
async function executeInAllFrames(wc, code) {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
  /** @type {Error|null} */
  let lastErr = null;
  try {
    const mainFrame = wc.mainFrame;
    if (mainFrame && typeof mainFrame.framesInSubtree === 'function') {
      const frames = mainFrame.framesInSubtree();
      for (const frame of frames) {
        try {
          if (frame && typeof frame.executeJavaScript === 'function') {
            await frame.executeJavaScript(code, true);
          }
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
        }
      }
      return;
    }
  } catch (err) {
    lastErr = err instanceof Error ? err : new Error(String(err));
  }
  try {
    await wc.executeJavaScript(code, true);
  } catch (err) {
    lastErr = err instanceof Error ? err : new Error(String(err));
  }
  void lastErr;
}

/**
 * Injeta o controlador (idempotente via __mhVolCtlDone).
 * @param {import('electron').WebContents} wc
 */
async function injectVolumeControl(wc) {
  const src = getVolumeInjectSource();
  await executeInAllFrames(wc, src);
}

/**
 * Aplica ganho já injetado (0–200%).
 * @param {import('electron').WebContents} wc
 * @param {number} percent
 */
async function applyVolumeToWebContents(wc, percent) {
  const gain = percentToGain(percent);
  const code =
    '(function(g){try{if(window.__mhVol&&typeof window.__mhVol.set==="function")' +
    'return window.__mhVol.set(g);' +
    'return null;}catch(e){return null;}})(' +
    JSON.stringify(gain) +
    ')';
  await executeInAllFrames(wc, code);
}

/**
 * Injeta (se preciso) e aplica volume.
 * @param {import('electron').WebContents} wc
 * @param {number} percent
 */
async function ensureVolumeApplied(wc, percent) {
  try {
    await injectVolumeControl(wc);
  } catch {
    /* ignore */
  }
  try {
    await applyVolumeToWebContents(wc, percent);
  } catch {
    /* ignore */
  }
}

/**
 * Lê diagnóstico do main frame (selftest).
 * @param {import('electron').WebContents} wc
 */
async function readVolumeDiag(wc) {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return null;
  try {
    return await wc.executeJavaScript(
      '(function(){try{return window.__mhVol&&window.__mhVol.getDiag?window.__mhVol.getDiag():null;}catch(e){return{err:String(e)};}})()',
      true
    );
  } catch {
    return null;
  }
}

/**
 * Payload para mh-apply-volume / send ao preload.
 * @param {number} percent
 */
function applyPayload(percent) {
  return {
    percent: normalizeVolumePercent(percent),
    gain: percentToGain(percent),
    source: getVolumeInjectSource(),
  };
}

/**
 * Envia volume ao webContents (preload + frames via executeJavaScript).
 * @param {import('electron').WebContents} wc
 * @param {number} percent
 */
function pushVolumeToWebContents(wc, percent) {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
  const payload = applyPayload(percent);
  try {
    wc.send('mh-apply-volume', payload);
  } catch {
    /* ignore */
  }
  void ensureVolumeApplied(wc, percent);
}

/**
 * @param {{
 *   resolveAccountIdFromWebContents?: (wc: import('electron').WebContents) => string|null,
 *   getAccount?: (id: string) => object|null,
 * }} opts
 */
function installVolumeIpc(opts = {}) {
  if (typeof opts.resolveAccountIdFromWebContents === 'function') {
    resolveAccountId = opts.resolveAccountIdFromWebContents;
  }
  if (typeof opts.getAccount === 'function') {
    getAccount = opts.getAccount;
  }
  if (ipcInstalled) return;
  ipcInstalled = true;

  ipcMain.on('panel:volume-sync', (event) => {
    try {
      const wc = event && event.sender;
      let percent = 100;
      if (typeof resolveAccountId === 'function' && wc) {
        const accountId = resolveAccountId(wc);
        if (accountId && typeof getAccount === 'function') {
          percent = volumeOfAccount(getAccount(accountId));
        }
      }
      event.returnValue = {
        gain: percentToGain(percent),
        percent: normalizeVolumePercent(percent),
        source: getVolumeInjectSource(),
      };
    } catch {
      event.returnValue = {
        gain: 1,
        percent: 100,
        source: getVolumeInjectSource(),
      };
    }
  });
}

module.exports = {
  normalizeVolumePercent,
  percentToGain,
  volumeOfAccount,
  getVolumeInjectSource,
  injectVolumeControl,
  applyVolumeToWebContents,
  ensureVolumeApplied,
  executeInAllFrames,
  readVolumeDiag,
  applyPayload,
  pushVolumeToWebContents,
  installVolumeIpc,
};
