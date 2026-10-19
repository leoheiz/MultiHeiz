'use strict';

/**
 * Promote session-only cookies to persistent (30d) + flush storage on cadence / quit.
 */

const { session } = require('electron');

/** @type {Set<Electron.Session>} */
const hooked = new Set();
/** @type {ReturnType<typeof setInterval> | null} */
let flushTimer = null;
const FLUSH_MS = 5 * 60 * 1000;
const PERSIST_DAYS = 30;

function persistSessionsEnabled() {
  try {
    const { getState } = require('./state');
    const s = getState().settings || {};
    return s.persistSessions !== false;
  } catch {
    return true;
  }
}

function isUnsafeToRewrite(cookie) {
  if (!cookie) return true;
  const name = String(cookie.name || '');
  if (name.startsWith('__Host-')) return true;
  if (cookie.partitioned) return true;
  return false;
}

function cookieUrl(cookie) {
  const domain = String(cookie.domain || '').replace(/^\./, '');
  const scheme = cookie.secure ? 'https' : 'http';
  const pathPart = cookie.path || '/';
  return `${scheme}://${domain}${pathPart.startsWith('/') ? pathPart : '/' + pathPart}`;
}

/**
 * @param {Electron.Session} ses
 */
function hookSessionCookies(ses) {
  if (!ses || hooked.has(ses)) return;
  hooked.add(ses);
  ses.cookies.on('changed', async (_e, cookie, cause, removed) => {
    if (removed || !persistSessionsEnabled()) return;
    if (!cookie || cookie.session !== true) return;
    if (isUnsafeToRewrite(cookie)) return;
    if (cause === 'explicit' && cookie.expirationDate) return;
    try {
      const expirationDate = Math.floor(Date.now() / 1000) + PERSIST_DAYS * 24 * 60 * 60;
      await ses.cookies.set({
        url: cookieUrl(cookie),
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: !!cookie.secure,
        httpOnly: !!cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate,
      });
    } catch {
      /* ignore edge cases */
    }
  });
}

/**
 * @param {Iterable<Electron.Session>} [sessions]
 */
async function flushAllSessions(sessions) {
  const list = sessions ? [...sessions] : [...hooked];
  try {
    list.push(session.defaultSession);
  } catch {
    /* ignore */
  }
  const seen = new Set();
  for (const ses of list) {
    if (!ses || seen.has(ses)) continue;
    seen.add(ses);
    try {
      if (typeof ses.flushStorageData === 'function') ses.flushStorageData();
    } catch {
      /* ignore */
    }
    try {
      if (ses.cookies && typeof ses.cookies.flushStore === 'function') {
        await ses.cookies.flushStore();
      }
    } catch {
      /* ignore */
    }
  }
}

function startPeriodicFlush(getSessions) {
  stopPeriodicFlush();
  flushTimer = setInterval(() => {
    const sessions = typeof getSessions === 'function' ? getSessions() : [];
    flushAllSessions(sessions).catch(() => {});
  }, FLUSH_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function stopPeriodicFlush() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

module.exports = {
  hookSessionCookies,
  flushAllSessions,
  startPeriodicFlush,
  stopPeriodicFlush,
  persistSessionsEnabled,
  PERSIST_DAYS,
};
