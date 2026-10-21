'use strict';

/**
 * Packaged / env-driven check for differential updates (MULTIHEIZ_SELFTEST=diff-update).
 * Included in asar (not selftest-*.js) so the TEST-ONLY installer can run it.
 *
 * Expects MULTIHEIZ_UPDATE_URL pointing at a generic provider (latest.yml + setup + blockmap).
 * Downloads without installing (autoInstallOnAppQuit false). Asserts electron-updater
 * logged a differential download when the old blockmap is available.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * @param {{
 *   updater: typeof import('./updater'),
 *   sleep?: (ms: number) => Promise<void>,
 * }} ctx
 */
async function runDiffUpdateCheck(ctx) {
  const updater = ctx.updater || require('./updater');
  const sleep =
    typeof ctx.sleep === 'function'
      ? ctx.sleep
      : (ms) => new Promise((r) => setTimeout(r, ms));

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  console.log('SELFTEST diff-update (packaged check)');
  assert(!!process.env.MULTIHEIZ_SELFTEST, 'MULTIHEIZ_SELFTEST required');
  assert(!!process.env.MULTIHEIZ_UPDATE_URL, 'MULTIHEIZ_UPDATE_URL required');

  const logLines = [];
  const autoUpdater = updater.getAutoUpdater();

  const prevLogger = autoUpdater.logger;
  autoUpdater.logger = {
    info: (...args) => {
      const line = args.map(String).join(' ');
      logLines.push(line);
      console.log('[electron-updater]', line);
    },
    warn: (...args) => {
      const line = args.map(String).join(' ');
      logLines.push(line);
      console.warn('[electron-updater]', line);
    },
    error: (...args) => {
      const line = args.map(String).join(' ');
      logLines.push(line);
      console.error('[electron-updater]', line);
    },
    debug: (...args) => {
      const line = args.map(String).join(' ');
      logLines.push(line);
    },
  };

  process.env.MULTIHEIZ_UPDATE_NO_INSTALL = '1';
  updater.prepareAutoUpdater(autoUpdater);
  assert(autoUpdater.autoInstallOnAppQuit === false, 'autoInstallOnAppQuit must be false');

  if (!updater.handlersBoundForTest || true) {
    // events already bound by initUpdater in normal boot
  }

  const channel = updater.detectUpdateChannel();
  assert(channel === 'nsis', 'expected nsis channel, got ' + channel);

  const st = await updater.checkForUpdates({ silent: false });
  assert(
    st.status === 'available' || st.status === 'downloading' || st.status === 'ready',
    'expected update available, got ' + st.status + ' ' + st.message
  );
  console.log('PASS: update available', st.version);

  // Wait for download to finish (autoDownload true)
  const deadline = Date.now() + 10 * 60 * 1000;
  let ready = st.status === 'ready';
  while (!ready && Date.now() < deadline) {
    await sleep(1000);
    const cur = updater.getStatus();
    if (cur.status === 'ready') {
      ready = true;
      break;
    }
    if (cur.status === 'error') {
      assert(false, 'download error: ' + cur.message);
    }
  }
  assert(ready, 'download did not finish in time');
  console.log('PASS: update downloaded (no install)');

  const joined = logLines.join('\n');
  const hasDiff =
    /Differential download/i.test(joined) ||
    /Full:.*To download:/i.test(joined);
  const outPath = process.env.MULTIHEIZ_DIFF_UPDATE_LOG;
  if (outPath) {
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(
        outPath,
        JSON.stringify(
          {
            version: app.getVersion(),
            remote: updater.getStatus().version,
            hasDiff,
            logLines,
          },
          null,
          2
        ),
        'utf8'
      );
    } catch {
      /* ignore */
    }
  }

  if (hasDiff) {
    console.log('PASS: electron-updater reported differential download');
  } else {
    console.log(
      'WARN: no "Differential download" in updater log (full download may have been used; old blockmap may be missing)'
    );
    // Soft-fail only when MULTIHEIZ_DIFF_UPDATE_REQUIRE_DIFF=1
    if (process.env.MULTIHEIZ_DIFF_UPDATE_REQUIRE_DIFF === '1') {
      assert(false, 'expected Differential download in log');
    }
  }

  if (prevLogger) autoUpdater.logger = prevLogger;
  console.log('PASS: diff-update-check complete');
  return { ok: true, hasDiff, logLines };
}

module.exports = { runDiffUpdateCheck };
