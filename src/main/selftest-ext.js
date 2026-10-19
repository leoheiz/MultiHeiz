'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app } = require('electron');
const { envGet } = require('./config');

/**
 * Offline selftest for v1.9 Phase 3 — third-party extensions + DNR shim.
 */
async function runExtSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    extensions,
  } = ctx;

  const phase = envGet('MULTIHEIZ_SELFTEST_PHASE') || '1';
  console.log('SELFTEST ext phase=' + phase);

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  const fixtureDir = path.join(app.getAppPath(), 'tools', 'fixtures', 'mh-ext-test');
  if (!fs.existsSync(path.join(fixtureDir, 'manifest.json'))) {
    throw new Error('fixture missing: ' + fixtureDir);
  }

  let server = null;
  let port = 0;
  // 1x1 GIF
  const GIF = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );
  const PAGE =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>ext-host</title></head>' +
    '<body><h1 id="host">host</h1>' +
    '<img id="dnr-block" src="/dnr-probe-block.gif" width="1" height="1" />' +
    '<img id="dnr-ok" src="/ok.gif" width="1" height="1" />' +
    '</body></html>';

  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.url && req.url.startsWith('/favicon')) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url && (req.url.includes('.gif') || req.url.includes('dnr-probe'))) {
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
        res.end(GIF);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
  const base = 'http://127.0.0.1:' + port;

  const closeServer = () =>
    new Promise((resolve) => {
      if (!server) return resolve();
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      } catch {
        /* ignore */
      }
      const t = setTimeout(() => resolve(), 1500);
      server.close(() => {
        clearTimeout(t);
        resolve();
      });
      try {
        server.unref();
      } catch {
        /* ignore */
      }
    });

  updateState((s) => {
    s.accounts = [];
    s.workspaces = [{ id: 'ws-ext', name: 'Principal' }];
    s.activeWorkspaceId = 'ws-ext';
    s.layout = '2';
    s.page = 0;
    s.maximizedAccountId = null;
    s.settings = {
      ...s.settings,
      openLastPage: false,
      homepage: base + '/',
      adblock: { ...(s.settings.adblock || {}), enabled: false },
    };
  });
  updateState((s) => {
    s.accounts.push(
      {
        id: 'acc-ext-a',
        name: 'Janela A',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-ext',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-ext-b',
        name: 'Janela B',
        color: '#e25c5c',
        startUrl: base + '/',
        workspaceId: 'ws-ext',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      }
    );
  });
  flushSave();
  if (emitToRenderer) emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(600);

  const bw = mainWindow.getContentBounds().width;
  const bh = mainWindow.getContentBounds().height;
  panels.syncVisiblePanels([
    { accountId: 'acc-ext-a', x: 0, y: 80, width: Math.floor(bw / 2), height: bh - 80 },
    {
      accountId: 'acc-ext-b',
      x: Math.floor(bw / 2),
      y: 80,
      width: Math.floor(bw / 2),
      height: bh - 80,
    },
  ]);
  await sleep(400);
  panels.panelNavigate('acc-ext-a', base + '/');
  panels.panelNavigate('acc-ext-b', base + '/');
  await waitForUrl('acc-ext-a', (u) => u.includes('127.0.0.1'), 20000);
  await waitForUrl('acc-ext-b', (u) => u.includes('127.0.0.1'), 20000);

  const evalIn = async (accountId, code) => {
    const wc = panels.getPanelCapture(accountId);
    if (!wc) throw new Error('no panel ' + accountId);
    return wc.executeJavaScript(code, true);
  };

  if (phase === '2') {
    const list = extensions.list();
    if (!list.length) throw new Error('phase2: no extensions persisted');
    const rec = list.find((e) => e.name === 'MultiHeiz Ext Test') || list[0];
    if (!rec.enabled) throw new Error('phase2: extension disabled unexpectedly');
    await extensions.setApplyTo(rec.id, ['acc-ext-a']);
    await extensions.loadForAccount('acc-ext-a');
    await extensions.loadForAccount('acc-ext-b');
    try { panels.destroyPanel('acc-ext-a'); } catch (_) {}
    try { panels.destroyPanel('acc-ext-b'); } catch (_) {}
    await sleep(300);
    {
      const bwP = mainWindow.getContentBounds().width;
      const bhP = mainWindow.getContentBounds().height;
      panels.syncVisiblePanels([
        { accountId: 'acc-ext-a', x: 0, y: 80, width: Math.floor(bwP / 2), height: bhP - 80 },
        {
          accountId: 'acc-ext-b',
          x: Math.floor(bwP / 2),
          y: 80,
          width: Math.floor(bwP / 2),
          height: bhP - 80,
        },
      ]);
    }
    await waitForUrl('acc-ext-a', (u) => u.includes('127.0.0.1'), 30000);
    await waitForUrl('acc-ext-b', (u) => u.includes('127.0.0.1'), 30000);
    await sleep(1500);
    let csA2 = null;
    let csB2 = null;
    for (let i = 0; i < 40; i++) {
      csA2 = await Promise.race([
        evalIn(
          'acc-ext-a',
          "document.documentElement.getAttribute('data-mh-ext-cs') || (window.__MH_EXT_CS__ ? '1' : null)"
        ),
        sleep(2500).then(() => 'timeout'),
      ]);
      csB2 = await Promise.race([
        evalIn(
          'acc-ext-b',
          "document.documentElement.getAttribute('data-mh-ext-cs') || (window.__MH_EXT_CS__ ? '1' : null)"
        ),
        sleep(2500).then(() => 'timeout'),
      ]);
      console.log('phase2 CS poll', i, { csA2, csB2 });
      if (csA2 === '1' && csB2 !== '1') break;
      await sleep(300);
    }
    if (csA2 !== '1') throw new Error('phase2: content script missing on A after restart');
    if (csB2 === '1') throw new Error('phase2: content script unexpectedly on B after restart');
    console.log('PASS: persistence — extension still applied to A only after restart');
    await closeServer();
    console.log('SELFTEST ext OK');
    app.exit(0);
    return;
  }

  const installed = await extensions.installFromUnpacked(fixtureDir, {
    applyTo: ['acc-ext-a'],
  });
  if (!installed || !installed.id) throw new Error('installFromUnpacked failed');
  console.log('PASS: installed unpacked', installed.id, 'MV' + installed.manifestVersion);

  const rulesPath = path.join(fixtureDir, 'rules.json');
  if (!fs.existsSync(rulesPath)) throw new Error('fixture rules.json missing');
  const snapPath = path.join(installed.path, 'multiheiz-dnr.json');
  if (!fs.existsSync(snapPath)) throw new Error('DNR snapshot missing after install');
  const eng = extensions.dnr.getEngine(installed.id);
  if (!eng || eng.ruleCount < 2) {
    throw new Error('DNR engine not loaded (rules=' + (eng && eng.ruleCount) + ')');
  }
  console.log('PASS: DNR shim loaded', eng.ruleCount, 'rules in', eng.loadMs + 'ms');

  const blockHit = extensions.dnr.matchUrl(
    installed.id,
    base + '/dnr-probe-block.gif',
    { resourceType: 'image', initiator: base + '/' }
  );
  if (!blockHit || blockHit.actionType !== 'block') {
    throw new Error('DNR matchUrl expected block for dnr-probe-block, got ' + JSON.stringify(blockHit));
  }
  const allowHit = extensions.dnr.matchUrl(
    installed.id,
    base + '/dnr-probe-allow.gif',
    { resourceType: 'image', initiator: base + '/' }
  );
  if (!allowHit || allowHit.actionType !== 'allow') {
    throw new Error('DNR matchUrl expected allow for dnr-probe-allow');
  }
  console.log('PASS: DNR matchUrl block/allow');

  const stubUp = extensions.dnr.updateEnabledRulesets(installed.id, {
    disableRulesetIds: ['ruleset_test'],
  });
  if (!stubUp.ok) throw new Error('updateEnabledRulesets failed');
  const afterOff = extensions.dnr.matchUrl(installed.id, base + '/dnr-probe-block.gif', {
    resourceType: 'image',
  });
  if (afterOff) throw new Error('ruleset still matching after disable');
  extensions.dnr.updateEnabledRulesets(installed.id, { enableRulesetIds: ['ruleset_test'] });
  const afterOn = extensions.dnr.matchUrl(installed.id, base + '/dnr-probe-block.gif', {
    resourceType: 'image',
  });
  if (!afterOn || afterOn.actionType !== 'block') {
    throw new Error('ruleset not restored after enable');
  }
  console.log('PASS: updateEnabledRulesets stub');

  const dyn = extensions.dnr.updateRules(installed.id, 'dynamic', {
    addRules: [
      {
        id: 9001,
        priority: 50,
        action: { type: 'block' },
        condition: { urlFilter: 'dnr-dyn-probe', resourceTypes: ['image'] },
      },
    ],
  });
  if (!dyn.ok) throw new Error('updateDynamicRules failed');
  const dynHit = extensions.dnr.matchUrl(installed.id, base + '/dnr-dyn-probe.gif', {
    resourceType: 'image',
  });
  if (!dynHit || dynHit.actionType !== 'block') throw new Error('dynamic rule miss');
  extensions.dnr.updateRules(installed.id, 'dynamic', { removeRuleIds: [9001] });
  console.log('PASS: updateDynamicRules stub');

  const measure = extensions.dnr.measureLookup(installed.id, [
    base + '/dnr-probe-block.gif',
    base + '/ok.gif',
    base + '/other.png',
    'http://ads.example.com/banner.js',
    'http://127.0.0.1/pixel.gif',
  ]);
  console.log(
    'PASS: DNR lookup measure avgUs=',
    measure.avgUs.toFixed(1),
    'totalMs=',
    measure.totalMs.toFixed(2)
  );

  await extensions.setApplyTo(installed.id, ['acc-ext-a']);
  await extensions.loadForAccount('acc-ext-a');
  await extensions.loadForAccount('acc-ext-b');

  const loadedA = extensions.loader.listLoaded('acc-ext-a');
  const loadedB = extensions.loader.listLoaded('acc-ext-b');
  if (!loadedA.some((x) => x.installId === installed.id)) {
    throw new Error('extension not loaded in session A');
  }
  if (loadedB.some((x) => x.installId === installed.id)) {
    throw new Error('extension loaded in session B but applyTo is A only');
  }
  console.log('PASS: per-session loading (A yes, B no)');

  const { session } = require('electron');
  const sesA = session.fromPartition(panels.partitionFor('acc-ext-a'));
  console.log('session A extensions', sesA.extensions.getAllExtensions().map((e) => ({ id: e.id, name: e.name })));

  console.log('recreating panels after extension load...');
  try { panels.destroyPanel('acc-ext-a'); } catch (_) {}
  try { panels.destroyPanel('acc-ext-b'); } catch (_) {}
  await sleep(300);
  const bw2 = mainWindow.getContentBounds().width;
  const bh2 = mainWindow.getContentBounds().height;
  panels.syncVisiblePanels([
    { accountId: 'acc-ext-a', x: 0, y: 80, width: Math.floor(bw2 / 2), height: bh2 - 80 },
    {
      accountId: 'acc-ext-b',
      x: Math.floor(bw2 / 2),
      y: 80,
      width: Math.floor(bw2 / 2),
      height: bh2 - 80,
    },
  ]);
  await waitForUrl('acc-ext-a', (u) => u.includes('127.0.0.1'), 20000);
  await waitForUrl('acc-ext-b', (u) => u.includes('127.0.0.1'), 20000);
  await sleep(1000);

  let csA = null;
  let csB = null;
  for (let i = 0; i < 40; i++) {
    try {
      csA = await Promise.race([
        evalIn(
          'acc-ext-a',
          "document.documentElement.getAttribute('data-mh-ext-cs') || (window.__MH_EXT_CS__ ? '1' : null)"
        ),
        sleep(2500).then(() => 'timeout'),
      ]);
      csB = await Promise.race([
        evalIn(
          'acc-ext-b',
          "document.documentElement.getAttribute('data-mh-ext-cs') || (window.__MH_EXT_CS__ ? '1' : null)"
        ),
        sleep(2500).then(() => 'timeout'),
      ]);
    } catch (err) {
      console.log('eval retry', err && err.message);
    }
    console.log('CS poll', i, { csA, csB });
    if (csA === '1' && csB !== '1') break;
    await sleep(400);
  }
  if (csA !== '1') throw new Error('content script did not run on A (got ' + csA + ')');
  if (csB === '1') throw new Error('content script ran on B (should be session-scoped)');
  console.log('PASS: content script on A only');

  // DNR network block via webRequestHub (img with dnr-probe-block in URL)
  let dnrNet = null;
  for (let i = 0; i < 30; i++) {
    dnrNet = await Promise.race([
      evalIn(
        'acc-ext-a',
        `(() => {
          const b = document.getElementById('dnr-block');
          const ok = document.getElementById('dnr-ok');
          return {
            blockComplete: b && b.complete,
            blockW: b ? b.naturalWidth : -1,
            okComplete: ok && ok.complete,
            okW: ok ? ok.naturalWidth : -1,
          };
        })()`
      ),
      sleep(2000).then(() => null),
    ]);
    if (dnrNet && dnrNet.blockComplete && dnrNet.okComplete) break;
    await sleep(200);
  }
  console.log('DNR net probe', dnrNet);
  if (!dnrNet || dnrNet.okW < 1) {
    throw new Error('control image /ok.gif failed to load (got ' + JSON.stringify(dnrNet) + ')');
  }
  if (dnrNet.blockW > 0) {
    throw new Error('DNR should have blocked /dnr-probe-block.gif (naturalWidth=' + dnrNet.blockW + ')');
  }
  console.log('PASS: DNR hub blocked probe image on A');

  const coexist = extensions.coexistenceHint();
  if (!coexist.suggest) throw new Error('coexistence hint should suggest (fixture is network blocker)');
  console.log('PASS: coexistence hint suggests turning off built-in');

  const pop = await extensions.openActionPopup('acc-ext-a', installed.id, {
    parent: mainWindow,
  });
  if (!pop.ok) throw new Error('openActionPopup failed: ' + pop.error);
  await sleep(800);
  const actionWin = require('./extensions/popup').getActionWindow();
  if (!actionWin || actionWin.isDestroyed()) throw new Error('action popup window missing');
  const popupText = await actionWin.webContents.executeJavaScript(
    "document.getElementById('mh-ext-popup-marker') && document.getElementById('mh-ext-popup-marker').textContent",
    true
  );
  if (popupText !== 'mh-ext-popup-ok') {
    throw new Error('popup marker missing: ' + popupText);
  }
  console.log('PASS: action popup opened');
  try {
    actionWin.close();
  } catch {
    /* ignore */
  }

  const opt = await extensions.openOptionsPage('acc-ext-a', installed.id, {
    parent: mainWindow,
  });
  if (!opt.ok) throw new Error('openOptionsPage failed: ' + opt.error);
  await sleep(600);
  const ow = require('./extensions/popup').getOptionsWindow();
  if (!ow || ow.isDestroyed()) throw new Error('options window missing');
  const optText = await ow.webContents.executeJavaScript(
    "document.getElementById('mh-ext-options-marker') && document.getElementById('mh-ext-options-marker').textContent",
    true
  );
  if (optText !== 'mh-ext-options-ok') throw new Error('options marker missing');
  console.log('PASS: options page opened');
  try {
    ow.close();
  } catch {
    /* ignore */
  }

  // Disable / enable on unpacked install (before CRX swap)
  await extensions.setEnabled(installed.id, false);
  await extensions.loadForAccount('acc-ext-a');
  panels.panelReload('acc-ext-a');
  await sleep(1500);
  csA = await Promise.race([
    evalIn('acc-ext-a', "document.documentElement.getAttribute('data-mh-ext-cs')"),
    sleep(2500).then(() => 'timeout'),
  ]);
  if (csA === '1') throw new Error('content script still present after disable');
  console.log('PASS: disable removes content script');

  await extensions.setEnabled(installed.id, true);
  await extensions.setApplyTo(installed.id, ['acc-ext-a']);
  try { panels.destroyPanel('acc-ext-a'); } catch (_) {}
  try { panels.destroyPanel('acc-ext-b'); } catch (_) {}
  await sleep(400);
  {
    const bw3 = mainWindow.getContentBounds().width;
    const bh3 = mainWindow.getContentBounds().height;
    panels.syncVisiblePanels([
      { accountId: 'acc-ext-a', x: 0, y: 80, width: Math.floor(bw3 / 2), height: bh3 - 80 },
      {
        accountId: 'acc-ext-b',
        x: Math.floor(bw3 / 2),
        y: 80,
        width: Math.floor(bw3 / 2),
        height: bh3 - 80,
      },
    ]);
  }
  await waitForUrl('acc-ext-a', (u) => u.includes('127.0.0.1'), 60000);
  await sleep(2000);
  csA = null;
  for (let i = 0; i < 40; i++) {
    csA = await Promise.race([
      evalIn('acc-ext-a', "document.documentElement.getAttribute('data-mh-ext-cs')"),
      sleep(2500).then(() => 'timeout'),
    ]);
    if (i % 5 === 0) console.log('re-enable poll', i, csA);
    if (csA === '1') break;
    await sleep(200);
  }
  if (csA !== '1') throw new Error('content script missing after re-enable');
  console.log('PASS: re-enable works');

  // CRX3 pack + unpack install (persistence subject for phase 2)
  const crxPath = path.join(app.getPath('temp'), 'mh-ext-test.crx');
  extensions.packDirAsCrx3(fixtureDir, crxPath);
  const crxBuf = fs.readFileSync(crxPath);
  if (crxBuf.subarray(0, 4).toString() !== 'Cr24') throw new Error('CRX3 magic missing');
  if (crxBuf.readUInt32LE(4) !== 3) throw new Error('CRX version not 3');
  await extensions.removeExtension(installed.id);
  const fromCrx = await extensions.installFromCrxFile(crxPath, {
    applyTo: ['acc-ext-a'],
  });
  if (!fromCrx || fromCrx.name !== 'MultiHeiz Ext Test') {
    throw new Error('CRX install failed');
  }
  await extensions.setApplyTo(fromCrx.id, ['acc-ext-a']);
  await extensions.loadForAccount('acc-ext-a');
  const sesCrx = require('electron').session.fromPartition(panels.partitionFor('acc-ext-a'));
  const loadedCrx = sesCrx.extensions.getAllExtensions();
  if (!loadedCrx.some((e) => e.name === 'MultiHeiz Ext Test')) {
    throw new Error('CRX extension not in session after install');
  }
  console.log('PASS: CRX3 fixture unpack + install (CS verified after restart in phase 2)');

  flushSave();
  await closeServer();
  console.log('SELFTEST ext phase1 OK — exiting for restart persistence check');
  app.exit(0);
}

module.exports = { runExtSelftest };
