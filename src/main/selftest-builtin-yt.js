'use strict';

/**
 * Built-in YouTube scriptlets selftest (FEATURE B).
 * ABU extension NOT installed; built-in adblock ON (MIT YOUTUBE_BUILTIN_SCRIPTLETS).
 * Optional abu_ad pass if a local fixture exists under _local/abu-youtube/fixtures/.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { startPageServer } = require('./selftest-builtin-yt-page-server');

const ACCOUNT_ID = 'acc-builtin-yt';

const ABU_AD_FIXTURE = path.join(
  app.getAppPath(),
  '_local',
  'abu-youtube',
  'fixtures',
  'abu-ad-filters.txt'
);

/**
 * @param {object} ctx
 */
async function runBuiltinYtSelftest(ctx) {
  const { mainWindow, panels, updateState, flushSave, sleep, adblock } = ctx;

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  console.log('MultiHeiz selftest:builtin-yt');
  console.log('userData:', app.getPath('userData'));

  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setOpacity(0);
      mainWindow.hide();
    }
  } catch {
    /* ignore */
  }

  const page = await startPageServer(18453);
  console.log('page-server', page.origin('www.youtube.com'));

  updateState((s) => {
    s.accounts = [
      {
        id: ACCOUNT_ID,
        name: 'Builtin YT',
        workspaceId: 'ws-builtin-yt',
        color: '#333',
        muted: true,
        zoomFactor: 1,
        startUrl: 'about:blank',
        lastUrl: '',
      },
    ];
    s.workspaces = [{ id: 'ws-builtin-yt', name: 'Builtin YT' }];
    s.activeWorkspaceId = 'ws-builtin-yt';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.settings = {
      ...s.settings,
      openLastPage: false,
      homepage: 'about:blank',
      adblock: {
        ...(s.settings.adblock || {}),
        enabled: true,
        cosmetic: true,
        youtubeExperimental: false,
        antiTracking: false,
      },
      extensions: { ...(s.settings.extensions || {}), abuCompat: false },
    };
  });
  flushSave();

  if (adblock && typeof adblock.whenReady === 'function') {
    await adblock.whenReady();
  }

  const allListsOff = {};
  if (adblock && adblock.LISTS) {
    for (const id of Object.keys(adblock.LISTS)) allListsOff[id] = false;
  }

  async function enableBuiltin(withAbuAd) {
    const partial = {
      enabled: true,
      cosmetic: true,
      youtubeExperimental: false,
      antiTracking: false,
      lists: { ...allListsOff },
      userRules: '',
    };
    if (withAbuAd && fs.existsSync(ABU_AD_FIXTURE)) {
      partial.userRules = fs.readFileSync(ABU_AD_FIXTURE, 'utf8');
      console.log('abu_ad fixture loaded into userRules:', ABU_AD_FIXTURE);
    }
    await adblock.applySettings(partial);
    await sleep(400);
    const early = adblock.computeEarlyPayload(
      page.origin('www.youtube.com') + '/watch?v=probe'
    );
    assert(early && early.ok, 'early payload ok');
    assert(
      Array.isArray(early.scripts) && early.scripts.length > 0,
      'early scripts for www.youtube.com (got ' + (early.scripts && early.scripts.length) + ')'
    );
    console.log('PASS: early scripts=', early.scripts.length, withAbuAd ? '(+abu fixture)' : '(MIT only)');
  }

  /**
   * @param {unknown} raw
   * @param {string} label
   */
  function assertAdsPruned(raw, label) {
    let j;
    try {
      j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      j = null;
    }
    assert(j && typeof j === 'object', label + ' JSON parseable (got ' + String(raw).slice(0, 80) + ')');
    assert(j.adPlacements == null, label + ' adPlacements pruned');
    assert(j.playerAds == null, label + ' playerAds pruned');
    assert(j.adSlots == null, label + ' adSlots pruned');
    if (j.playerResponse) {
      assert(j.playerResponse.adPlacements == null, label + ' playerResponse.adPlacements pruned');
      assert(j.playerResponse.playerAds == null, label + ' playerResponse.playerAds pruned');
      assert(j.playerResponse.adSlots == null, label + ' playerResponse.adSlots pruned');
    }
  }

  /**
   * @param {unknown} raw
   * @param {string} label
   */
  function assertShortsFlagsRemoved(raw, label) {
    let j;
    try {
      j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      j = null;
    }
    assert(j && Array.isArray(j.entries), label + ' shorts entries array');
    // json-prune path uses [-] — matching reel entries may be dropped entirely,
    // or isAd may be stripped from adClientParams.
    for (let i = 0; i < j.entries.length; i++) {
      const params =
        j.entries[i] &&
        j.entries[i].command &&
        j.entries[i].command.reelWatchEndpoint &&
        j.entries[i].command.reelWatchEndpoint.adClientParams;
      if (!params || typeof params !== 'object') continue;
      assert(
        !Object.prototype.hasOwnProperty.call(params, 'isAd'),
        label + ' entry ' + i + ' isAd removed (got ' + JSON.stringify(params) + ')'
      );
    }
    if (j.entries.length === 0) {
      // All flagged reel entries pruned — OK
      return;
    }
  }

  /**
   * @param {object} r
   * @param {string} label
   * @param {{ expectPruned: boolean }} mode
   */
  function assertFrameResult(r, label, mode) {
    assert(r && typeof r === 'object', label + ' result object');
    if (mode.expectPruned) {
      assert(r.guard === 1, label + ' guard counter == 1 (got ' + r.guard + ')');
      assert(r.adPlacements === undefined || r.adPlacements == null, label + ' inline adPlacements');
      assert(r.playerAds === undefined || r.playerAds == null, label + ' inline playerAds');
      assert(r.adSlots === undefined || r.adSlots == null, label + ' inline adSlots');
      assert(String(r.googleAdStatus) === '1', label + ' google_ad_status===1');
      assertAdsPruned(r.fetchPlayer, label + ' fetch /player');
      assertAdsPruned(r.fetchNext, label + ' fetch /next');
      assertAdsPruned(r.xhrPlayer, label + ' xhr /player');
      assertAdsPruned(r.xhrNext, label + ' xhr /next');
      assertShortsFlagsRemoved(r.shortsParsed, label + ' shorts');
    } else {
      assert(
        Array.isArray(r.adPlacements) && r.adPlacements.length > 0,
        label + ' control: adPlacements remain (got ' + JSON.stringify(r.adPlacements) + ')'
      );
      assert(
        Array.isArray(r.playerAds) && r.playerAds.length > 0,
        label + ' control: playerAds remain'
      );
      assert(Array.isArray(r.adSlots) && r.adSlots.length > 0, label + ' control: adSlots remain');
      let fp;
      try {
        fp = JSON.parse(r.fetchPlayer);
      } catch {
        fp = null;
      }
      assert(
        fp &&
          (fp.adPlacements != null ||
            (fp.playerResponse && fp.playerResponse.adPlacements != null)),
        label + ' control: fetch still has ads'
      );
    }
  }

  /**
   * @param {Electron.WebContents} wc
   * @param {string} label
   * @param {{ expectPruned: boolean }} mode
   */
  async function runNavigationAssertions(wc, label, mode) {
    const watchUrl = page.origin('www.youtube.com') + '/watch?v=' + encodeURIComponent(label);
    await wc.loadURL(watchUrl).catch((e) => {
      console.warn('loadURL', label, e && e.message);
    });
    await sleep(3200);

    const top = await wc.executeJavaScript('JSON.stringify(window.__R)').then(JSON.parse);
    console.log(label, 'top', JSON.stringify(top).slice(0, 500));
    assertFrameResult(top, label + ' top', mode);

    // youtube-nocookie embed
    const frames = wc.mainFrame.framesInSubtree || [];
    let nocookieOk = false;
    let blankFrame = null;
    for (const f of frames) {
      const fu = String(f.url || '');
      if (fu.includes('youtube-nocookie.com') && fu.includes('/embed/')) {
        const ir = await f.executeJavaScript('JSON.stringify(window.__R)').then(JSON.parse);
        console.log(label, 'nocookie', JSON.stringify(ir).slice(0, 400));
        assertFrameResult(ir, label + ' nocookie', mode);
        nocookieOk = true;
      }
    }
    assert(nocookieOk, label + ' youtube-nocookie embed asserted');

    // Prefer the #blank about:srcdoc child (YouTube-style blank/srcdoc inherit)
    for (let i = 0; i < 20 && !blankFrame; i++) {
      const subtree = wc.mainFrame.framesInSubtree || [];
      for (const f of subtree) {
        const fu = String(f.url || '');
        const looksBlank =
          fu === 'about:blank' ||
          fu === '' ||
          fu === 'about:srcdoc' ||
          fu.startsWith('about:srcdoc');
        if (!looksBlank) continue;
        try {
          const isBlankTarget = await f.executeJavaScript(
            '!!(window.frameElement && window.frameElement.id === "blank")'
          );
          if (isBlankTarget) {
            blankFrame = f;
            break;
          }
        } catch {
          /* ignore */
        }
      }
      if (!blankFrame) await sleep(200);
    }

    // about:blank/srcdoc child — inherit host scriptlets; run same probes with absolute URLs
    assert(blankFrame, label + ' about:blank/srcdoc frame present');
    const origin = page.origin('www.youtube.com');
    const blankResult = await blankFrame.executeJavaScript(`(async () => {
      const out = {
        guard: window.__mhEarlyMainWorldDone,
        googleAdStatus: String(window.google_ad_status)
      };
      window.ytInitialPlayerResponse = { adPlacements: [1], playerAds: [1], adSlots: [1], videoDetails: { videoId: 'blank' } };
      out.adPlacements = window.ytInitialPlayerResponse.adPlacements;
      out.playerAds = window.ytInitialPlayerResponse.playerAds;
      out.adSlots = window.ytInitialPlayerResponse.adSlots;
      try {
        out.fetchPlayer = JSON.stringify(await fetch(${JSON.stringify(origin + '/youtubei/v1/player?blank=1')}).then(r => r.json()));
      } catch (e) { out.fetchPlayer = 'ERR ' + e.message; }
      try {
        out.fetchNext = JSON.stringify(await fetch(${JSON.stringify(origin + '/youtubei/v1/next?blank=1')}).then(r => r.json()));
      } catch (e) { out.fetchNext = 'ERR ' + e.message; }
      await new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.open('GET', ${JSON.stringify(origin + '/youtubei/v1/player?blankxhr=1')});
        x.onload = function() {
          try { out.xhrPlayer = JSON.stringify(JSON.parse(x.responseText)); }
          catch (e) { out.xhrPlayer = 'ERR ' + e.message; }
          resolve();
        };
        x.onerror = function() { out.xhrPlayer = 'ERR network'; resolve(); };
        x.send();
      });
      await new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.open('GET', ${JSON.stringify(origin + '/youtubei/v1/next?blankxhr=1')});
        x.onload = function() {
          try { out.xhrNext = JSON.stringify(JSON.parse(x.responseText)); }
          catch (e) { out.xhrNext = 'ERR ' + e.message; }
          resolve();
        };
        x.onerror = function() { out.xhrNext = 'ERR network'; resolve(); };
        x.send();
      });
      try {
        const shortsRaw = '{"entries":[{"command":{"reelWatchEndpoint":{"adClientParams":{"isAd":true,"x":1},"videoId":"s1"}}},{"command":{"reelWatchEndpoint":{"adClientParams":{"isAd":false},"videoId":"s2"}}}]}';
        out.shortsParsed = JSON.stringify(JSON.parse(shortsRaw));
      } catch (e) { out.shortsParsed = 'ERR ' + e.message; }
      return out;
    })()`);
    console.log(label, 'blank', JSON.stringify(blankResult).slice(0, 400));
    assertFrameResult(blankResult, label + ' about:blank/srcdoc', mode);

    return top;
  }

  panels.createPanel(ACCOUNT_ID);
  await sleep(400);
  try {
    panels.syncVisiblePanels([
      { accountId: ACCOUNT_ID, x: -20000, y: -20000, width: 800, height: 600 },
    ]);
  } catch {
    /* ignore */
  }

  const panelWc = panels.getPanelCapture(ACCOUNT_ID);
  assert(panelWc, 'panel webContents');
  const ses = panelWc.session;
  ses.setCertificateVerifyProc((_req, cb) => cb(0));

  // --- ON (MIT only) ---
  await enableBuiltin(false);
  await runNavigationAssertions(panelWc, 'ON-MIT', { expectPruned: true });
  console.log('PASS: built-in ON (MIT) prunes top + nocookie + about:blank');

  // --- ON (+ abu_ad fixture) if available ---
  if (fs.existsSync(ABU_AD_FIXTURE)) {
    await enableBuiltin(true);
    await runNavigationAssertions(panelWc, 'ON-ABU', { expectPruned: true });
    console.log('PASS: built-in ON (+abu_ad fixture)');
  } else {
    console.log('SKIP: abu_ad fixture missing — MIT-only path (ok)');
  }

  // --- OFF control ---
  await adblock.applySettings({ enabled: false });
  await sleep(300);
  await runNavigationAssertions(panelWc, 'OFF', { expectPruned: false });
  console.log('PASS: built-in OFF leaves ads fields');

  await page.close();
  console.log('PASS: selftest:builtin-yt complete');
  app.exit(0);
}

module.exports = { runBuiltinYtSelftest };
