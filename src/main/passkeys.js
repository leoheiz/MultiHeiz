'use strict';

/**
 * Windows passkeys (WebAuthn) preference for account sessions.
 * Default ON — real platform authenticator. When OFF, main-world patch
 * (via early-scriptlets) makes sites skip passkeys and fall through to password.
 */

/**
 * @returns {boolean} true = use Windows passkeys (default)
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
};
