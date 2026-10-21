'use strict';

/**
 * Preferência de passkeys / WebAuthn nas sessões de conta.
 *
 * Comportamento (todas as plataformas):
 * - Setting ON (default): Chromium usa o autenticador de plataforma do SO
 *   (Windows Hello / plataformas equivalentes). Sem patch no main world.
 * - Setting OFF: early-scriptlets injeta patch que esconde o autenticador de
 *   plataforma e rejeita credentials.get/create(publicKey) com NotAllowedError
 *   (sites caem para senha). Ver panel-preload.js.
 *
 * UI: a opção é oferecida em win32 / linux / darwin — o toggle OFF funciona em
 * qualquer SO; ON depende do suporte do Chromium + hardware/OS. Não ocultamos
 * a opção: o código não tem ramo “sem suporte” por plataforma.
 *
 * Rótulo: em Windows diz “do Windows”; em Linux/macOS diz “do sistema”
 * (nunca “do Windows” fora do win32).
 */

const { envGet } = require('./config');

/** @type {string | null} override só sob MULTIHEIZ_SELFTEST (gancho de teste) */
let selftestPlatformOverride = null;

/**
 * @returns {string} win32 | linux | darwin | …
 */
function getPasskeysPlatform() {
  if (
    envGet('MULTIHEIZ_SELFTEST') &&
    selftestPlatformOverride &&
    typeof selftestPlatformOverride === 'string'
  ) {
    return selftestPlatformOverride;
  }
  return process.platform;
}

/**
 * Selftest hook: simula plataforma para o rótulo (só com MULTIHEIZ_SELFTEST).
 * @param {string | null} platform
 */
function setSelftestPlatformOverride(platform) {
  if (!envGet('MULTIHEIZ_SELFTEST')) return;
  selftestPlatformOverride = platform ? String(platform) : null;
}

/**
 * @returns {boolean} sempre true — ver doc no topo do módulo
 */
function isPasskeysUiSupported() {
  return true;
}

/**
 * @param {string} [platform]
 * @returns {string} texto do rótulo (sem o checkbox)
 */
function getPasskeysLabel(platform) {
  const p = platform || getPasskeysPlatform();
  if (p === 'win32') {
    return 'Usar chaves de acesso (passkeys) do Windows';
  }
  return 'Usar chaves de acesso (passkeys) do sistema';
}

/**
 * @returns {{ supported: boolean, label: string, platform: string }}
 */
function getPasskeysUi() {
  const platform = getPasskeysPlatform();
  return {
    supported: isPasskeysUiSupported(),
    label: getPasskeysLabel(platform),
    platform,
  };
}

/**
 * @returns {boolean} true = usar passkeys do sistema (default)
 */
function isWindowsPasskeysEnabled() {
  try {
    const { getState } = require('./state');
    const s = getState().settings || {};
    return s.windowsPasskeys !== false;
  } catch {
    return true;
  }
}

/**
 * @returns {boolean} true when early preload should inject the disable patch
 */
function shouldDisablePasskeysInMainWorld() {
  return !isWindowsPasskeysEnabled();
}

module.exports = {
  isWindowsPasskeysEnabled,
  shouldDisablePasskeysInMainWorld,
  getPasskeysPlatform,
  getPasskeysLabel,
  getPasskeysUi,
  isPasskeysUiSupported,
  setSelftestPlatformOverride,
};
