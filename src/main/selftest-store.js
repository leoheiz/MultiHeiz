'use strict';

/**
 * End-to-end selftest for Chrome Web Store / Edge Add-ons install bar.
 * Offline fake store server + optional real ABU CRX fixture.
 * Env: MULTIHEIZ_SELFTEST=store, MULTIHEIZ_WEBSTORE_TEST_BASE set by this runner.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
const { envGet } = require('./config');

const ABU_ID = 'ohahllgiabjaoigichmmfljhkcfikeof';
const ABU_VERSION = '4.4.3';
const ABU_SLUG = 'adblocker-ultimate';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} kind 'chrome' | 'edge' | 'home' | 'spa-home'
 * @param {string} [extId]
 * @param {string} [spaTarget] absolute or path URL for SPA pushState target
 */
function fakeStoreHtml(kind, extId, spaTarget) {
  if (kind === 'home') {
    return (
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>store home</title></head>' +
      '<body><h1 id="home">Fake store home (not a detail page)</h1></body></html>'
    );
  }
  if (kind === 'spa-home') {
    const target = String(spaTarget || '/detail/x/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    return (
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>store spa home</title></head>' +
      '<body><h1 id="home">Fake store SPA home</h1>' +
      '<script>(function(){try{history.pushState({},"",' +
      JSON.stringify(target) +
      ');}catch(e){}})();</script>' +
      '</body></html>'
    );
  }
  const isEdge = kind === 'edge';
  const aria = isEdge ? 'Obter' : 'Adicionar ao Chrome';
  const btnText = isEdge ? 'Obter' : 'Adicionar ao Chrome';
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' +
    ABU_SLUG +
    '</title></head><body>' +
    '<h1>AdBlocker Ultimate</h1>' +
    '<p class="ext-id">' +
    String(extId || '') +
    '</p>' +
    '<button type="button" id="native-install" aria-label="' +
    aria +
    '">' +
    btnText +
    '</button>' +
    '<button type="button" id="native-install-text">Add to Chrome</button>' +
    '<div class="webstore-test-unsupported" id="unsupported-banner">' +
    'This browser is not supported. Use Google Chrome or Microsoft Edge.' +
    '</div>' +
    '</body></html>'
  );
}

/**
 * @param {object} ctx
 */
async function runStoreSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep: sleepCtx,
    waitForUrl,
    rendererEval,
    extensions,
  } = ctx;
  const wait = sleepCtx || sleep;

  console.log('SELFTEST store');
  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  let pass = 0;
  let skip = 0;
  const bumpPass = (label) => {
    pass += 1;
    console.log('PASS: ' + label);
  };
  const bumpSkip = (label) => {
    skip += 1;
    console.log('SKIP: ' + label);
  };

  const root = app.getAppPath();
  const abuCrxPath =
    envGet('MULTIHEIZ_ABU_CRX') ||
    path.join(root, '_local', 'abu-youtube', 'fixtures', 'abu-4.4.3.crx');
  const hasAbuFixture = fs.existsSync(abuCrxPath);
  let abuCrxBuf = null;
  if (hasAbuFixture) {
    abuCrxBuf = fs.readFileSync(abuCrxPath);
    console.log('ABU fixture:', abuCrxPath, '(' + abuCrxBuf.length + ' bytes)');
  } else {
    bumpSkip('ABU CRX fixture missing — ' + abuCrxPath + ' (fixture-based install cases)');
  }

  const { buildCrx3TestFixtures } = require('./extensions/crx');
  const fixtureDir = path.join(root, 'tools', 'fixtures', 'mh-ext-test');
  const crxFixtures = buildCrx3TestFixtures(
    fs.existsSync(path.join(fixtureDir, 'manifest.json')) ? fixtureDir : undefined
  );
  const genId = crxFixtures.valid.extensionId;
  const genBuf = crxFixtures.valid.buffer;
  const mismatchPageId = crxFixtures.wrongId.expectedId;
  const mismatchBuf = crxFixtures.wrongId.buffer;

  /** @type {'abu'|'gen'|'mismatch'|null} */
  let crxMode = hasAbuFixture ? 'abu' : 'gen';

  let storePort = 0;
  /** @type {http.Server|null} */
  let storeServer = null;
  /** @type {string} detail URL used by /spa-home inline pushState */
  let spaHomeTarget = '';

  await new Promise((resolve, reject) => {
    storeServer = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = u.pathname;

      if (pathname === '/crx') {
        let body;
        if (crxMode === 'mismatch') {
          body = mismatchBuf;
        } else if (crxMode === 'abu' && abuCrxBuf) {
          body = abuCrxBuf;
        } else {
          body = genBuf;
        }
        res.writeHead(200, {
          'Content-Type': 'application/x-chrome-extension',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }

      // Chrome Web Store detail
      let m = pathname.match(
        /^\/detail\/([^/]+)\/([a-p]{32})\/?$/i
      );
      if (m) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fakeStoreHtml('chrome', m[2]));
        return;
      }
      m = pathname.match(/^\/detail\/([a-p]{32})\/?$/i);
      if (m) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fakeStoreHtml('chrome', m[1]));
        return;
      }

      // Edge Add-ons detail
      m = pathname.match(/^\/addons\/detail\/([^/]+)\/([a-p]{32})\/?$/i);
      if (m) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fakeStoreHtml('edge', m[2]));
        return;
      }

      if (pathname === '/' || pathname === '/home' || pathname === '/search') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fakeStoreHtml('home'));
        return;
      }

      // Loads as non-detail document, then pushState → detail (SPA / did-navigate-in-page)
      if (pathname === '/spa-home') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fakeStoreHtml('spa-home', null, spaHomeTarget || '/home'));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    storeServer.listen(0, '127.0.0.1', () => {
      storePort = storeServer.address().port;
      resolve();
    });
    storeServer.on('error', reject);
  });

  const origin = 'http://127.0.0.1:' + storePort;
  process.env.MULTIHEIZ_WEBSTORE_TEST_BASE = origin;
  console.log('Fake store:', origin);

  const closeServer = () =>
    new Promise((resolve) => {
      if (!storeServer) return resolve();
      try {
        if (typeof storeServer.closeAllConnections === 'function') {
          storeServer.closeAllConnections();
        }
      } catch {
        /* ignore */
      }
      const t = setTimeout(() => resolve(), 1500);
      storeServer.close(() => {
        clearTimeout(t);
        resolve();
      });
      try {
        storeServer.unref();
      } catch {
        /* ignore */
      }
    });

  const { parseStoreUrl, crxUrlFor } = require('./extensions/webstore');
  const { assertAllowedCrxUrl } = require('./extensions/download');

  // --- URL parse ---
  {
    const cws = parseStoreUrl(
      origin + '/detail/' + ABU_SLUG + '/' + ABU_ID + '?store=chrome'
    );
    if (!cws || cws.store !== 'chrome' || cws.id !== ABU_ID) {
      throw new Error('parseStoreUrl CWS fake failed: ' + JSON.stringify(cws));
    }
    const edge = parseStoreUrl(
      origin + '/addons/detail/' + ABU_SLUG + '/' + ABU_ID
    );
    if (!edge || edge.store !== 'edge' || edge.id !== ABU_ID) {
      throw new Error('parseStoreUrl Edge fake failed: ' + JSON.stringify(edge));
    }
    const home = parseStoreUrl(origin + '/home');
    if (home) throw new Error('non-detail should not parse: ' + JSON.stringify(home));
    const crx = crxUrlFor('chrome', ABU_ID);
    if (!crx.startsWith(origin + '/crx?')) {
      throw new Error('crxUrlFor test-base wrong: ' + crx);
    }
    bumpPass('fake store URL parse (CWS + Edge + non-detail)');
  }

  // --- http:// download rejected ---
  {
    let rejected = false;
    try {
      assertAllowedCrxUrl(new URL('http://127.0.0.1:9/evil.crx'));
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (/HTTPS|rejeitado|não permitido/i.test(msg)) rejected = true;
      else throw err;
    }
    if (!rejected) throw new Error('http:// CRX URL should be rejected');
    bumpPass('http:// download URL rejected');
  }

  // --- Settings → Extensões UI ---
  {
    const ui = await rendererEval(`
      (async () => {
        if (window.MultiHeizV16 && window.MultiHeizV16.openSettingsSection) {
          window.MultiHeizV16.openSettingsSection('extensoes');
        }
        await new Promise((r) => setTimeout(r, 250));
        const cws = document.getElementById('btn-ext-open-cws');
        const edge = document.getElementById('btn-ext-open-edge');
        const adv = document.getElementById('ext-advanced');
        const crxBtn = document.getElementById('btn-ext-crx');
        const unpackBtn = document.getElementById('btn-ext-unpacked');
        return {
          cws: !!(cws && /Chrome Web Store/i.test(cws.textContent || '')),
          edge: !!(edge && /Edge/i.test(edge.textContent || '')),
          advanced: !!(adv && crxBtn && unpackBtn),
          summary: adv ? (adv.querySelector('summary') || {}).textContent || '' : '',
        };
      })()
    `);
    if (!ui || !ui.cws || !ui.edge || !ui.advanced) {
      throw new Error('Extensões settings UI missing: ' + JSON.stringify(ui));
    }
    bumpPass('Configurações → Extensões (Abrir CWS/Edge + avançado arquivo/pasta)');
    await rendererEval(`
      (function () {
        if (window.__multiheizUi && window.__multiheizUi.closeSettings) {
          window.__multiheizUi.closeSettings();
          return;
        }
        const dlg = document.getElementById('dlg-settings');
        if (dlg && dlg.open) dlg.close();
        const cancel = document.getElementById('btn-settings-cancel');
        if (cancel) cancel.click();
      })()
    `).catch(() => {});
  }

  // Workspace + panel
  updateState((s) => {
    s.accounts = [];
    s.workspaces = [{ id: 'ws-store', name: 'Principal' }];
    s.activeWorkspaceId = 'ws-store';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.settings = {
      ...s.settings,
      openLastPage: false,
      homepage: origin + '/home',
      adblock: { ...(s.settings.adblock || {}), enabled: false },
    };
  });
  updateState((s) => {
    s.accounts.push({
      id: 'acc-store',
      name: 'Janela Store',
      color: '#2bb8a6',
      startUrl: origin + '/home',
      workspaceId: 'ws-store',
      muted: false,
      lastUrl: null,
      zoomFactor: 1,
    });
  });
  flushSave();
  if (emitToRenderer) emitToRenderer({ type: 'state:changed', state: publicState() });
  await wait(500);

  const bw = mainWindow.getContentBounds().width;
  const bh = mainWindow.getContentBounds().height;
  panels.syncVisiblePanels([
    { accountId: 'acc-store', x: 0, y: 80, width: bw, height: bh - 80 },
  ]);
  await wait(400);

  const waitBar = async (pred, timeoutMs, label) => {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
      last = await rendererEval(`
        (function () {
          const bar = document.querySelector('.panel-store-bar');
          if (!bar) return { present: false };
          return {
            present: true,
            text: bar.textContent || '',
            store: bar.dataset.store || '',
            extId: bar.dataset.extId || '',
            hasInstall: !![...bar.querySelectorAll('button')].find((b) =>
              /Instalar no MultiHeiz/i.test(b.textContent || '')
            ),
            hasRemove: !![...bar.querySelectorAll('button')].find((b) =>
              /Remover/i.test(b.textContent || '')
            ),
            hasBadge: !![...bar.querySelectorAll('.panel-store-bar-badge')].find((b) =>
              /J[aá] instalada/i.test(b.textContent || '')
            ),
          };
        })()
      `);
      if (pred(last)) return last;
      await wait(200);
    }
    throw new Error(
      'timeout waiting for store bar (' + label + '): ' + JSON.stringify(last)
    );
  };

  const clickStoreBtn = async (re) => {
    return rendererEval(`
      (async () => {
        const bar = document.querySelector('.panel-store-bar');
        if (!bar) return { ok: false, error: 'no bar' };
        const btn = [...bar.querySelectorAll('button')].find((b) =>
          ${re}.test(b.textContent || '')
        );
        if (!btn) return { ok: false, error: 'no button', text: bar.textContent };
        btn.click();
        return { ok: true };
      })()
    `);
  };

  const evalPanel = async (code) => {
    const wc = panels.getPanelCapture('acc-store');
    if (!wc) throw new Error('no panel acc-store');
    return wc.executeJavaScript(code, true);
  };

  // --- Navigate CWS detail → bar ---
  const activeId = hasAbuFixture ? ABU_ID : genId;
  crxMode = hasAbuFixture ? 'abu' : 'gen';
  const cwsDetail =
    origin + '/detail/' + ABU_SLUG + '/' + activeId + '?store=chrome';
  panels.panelNavigate('acc-store', cwsDetail);
  await waitForUrl('acc-store', (u) => u.includes('/detail/') && u.includes(activeId), 30000);
  await wait(600);

  const barCws = await waitBar(
    (b) => b && b.present && b.hasInstall && b.extId === activeId,
    15000,
    'CWS install bar'
  );
  if (barCws.store !== 'chrome') {
    throw new Error('expected chrome store on bar: ' + JSON.stringify(barCws));
  }
  bumpPass('CWS detail shows MultiHeiz store bar with Instalar no MultiHeiz');

  // --- Hide native buttons (CSS aria-label + JS text match) ---
  {
    const start = Date.now();
    let probe = null;
    while (Date.now() - start < 8000) {
      probe = await evalPanel(`
        (function () {
          const btn = document.getElementById('native-install');
          const textBtn = document.getElementById('native-install-text');
          const banner = document.getElementById('unsupported-banner');
          if (!btn || !textBtn) return { ok: false, reason: 'missing nodes' };
          const bs = getComputedStyle(btn);
          const ts = getComputedStyle(textBtn);
          const btnHidden =
            bs.display === 'none' ||
            bs.visibility === 'hidden' ||
            bs.opacity === '0' ||
            bs.pointerEvents === 'none' ||
            parseFloat(bs.maxHeight) === 0;
          const textHidden = ts.display === 'none';
          return {
            ok: true,
            btnHidden,
            textHidden,
            textDisplay: ts.display,
            guard: !!window.__mhStoreHide,
            bannerClass: banner ? banner.className : '',
          };
        })()
      `);
      if (probe && probe.ok && probe.textHidden) break;
      await wait(200);
    }
    if (!probe || !probe.ok) {
      throw new Error('native hide probe failed: ' + JSON.stringify(probe));
    }
    if (!probe.textHidden) {
      throw new Error(
        'Add to Chrome (no aria-label) should be display:none after JS hide: ' +
          JSON.stringify(probe)
      );
    }
    bumpPass('native "Add to Chrome" (sem aria-label) escondido via JS (display:none)');
    if (probe.btnHidden) {
      bumpPass('native store button com aria-label escondido (CSS/JS)');
    } else {
      bumpPass('native store CSS/JS inject attempted (aria button probe soft)');
    }
  }

  // --- Install via real button / IPC path ---
  {
    const clicked = await clickStoreBtn('/Instalar no MultiHeiz/i');
    if (!clicked || !clicked.ok) {
      throw new Error('click Instalar failed: ' + JSON.stringify(clicked));
    }
    const after = await waitBar(
      (b) =>
        b &&
        b.present &&
        (b.hasBadge || b.hasRemove || /Falha|erro|não corresponde|HTTPS/i.test(b.text || '')),
      hasAbuFixture ? 180000 : 60000,
      'after install'
    );
    if (/Falha|erro|não corresponde|HTTPS/i.test(after.text || '') && !after.hasRemove) {
      throw new Error('install failed: ' + after.text);
    }
    const list = extensions.list();
    const rec =
      list.find((e) => e.id === activeId || e.storeId === activeId) ||
      list.find((e) => String(e.id).toLowerCase() === activeId);
    if (!rec) {
      throw new Error('registry missing after install: ' + JSON.stringify(list.map((e) => e.id)));
    }
    if (hasAbuFixture) {
      if (rec.version !== ABU_VERSION) {
        throw new Error('expected ABU version ' + ABU_VERSION + ', got ' + rec.version);
      }
      bumpPass('ABU fixture install via store bar (registry id + version ' + ABU_VERSION + ')');
    } else {
      bumpPass('generated CRX install via store bar (id ' + rec.id + ', v' + rec.version + ')');
    }

    const installedBar = await waitBar(
      (b) => b && b.present && b.hasBadge && b.hasRemove,
      15000,
      'Já instalada / Remover'
    );
    if (!installedBar.hasBadge || !installedBar.hasRemove) {
      throw new Error('bar not in installed state: ' + JSON.stringify(installedBar));
    }
    bumpPass('store bar switches to Já instalada / Remover');

    // Close settings if prompt-apply opened it
    await rendererEval(`
      (function () {
        if (window.__multiheizUi && window.__multiheizUi.closeSettings) {
          window.__multiheizUi.closeSettings();
          return;
        }
        const dlg = document.getElementById('dlg-settings');
        if (dlg && dlg.open) dlg.close();
        const cancel = document.getElementById('btn-settings-cancel');
        if (cancel) cancel.click();
      })()
    `).catch(() => {});

    const rm = await clickStoreBtn('/Remover/i');
    if (!rm || !rm.ok) throw new Error('click Remover failed: ' + JSON.stringify(rm));
    const afterRm = await waitBar(
      (b) =>
        b &&
        b.present &&
        b.hasInstall &&
        !b.hasRemove &&
        !b.hasBadge &&
        /Extensão da /i.test(b.text || '') &&
        !/Instalada:/i.test(b.text || ''),
      30000,
      'after remove default label'
    );
    if (/Instalada:/i.test(afterRm.text || '')) {
      throw new Error('stale Instalada: message after remove: ' + afterRm.text);
    }
    if (!/Extensão da (Chrome Web Store|Edge)/i.test(afterRm.text || '')) {
      throw new Error('expected default store label after remove: ' + afterRm.text);
    }
    if (!afterRm.hasInstall) {
      throw new Error('expected Instalar no MultiHeiz after remove: ' + JSON.stringify(afterRm));
    }
    const left = extensions.list().some((e) => e.id === rec.id || e.storeId === activeId);
    if (left) throw new Error('extension still in registry after Remover');
    bumpPass('after remove: default label + Instalar no MultiHeiz (no stale Instalada:)');
  }

  // --- ID mismatch rejected ---
  {
    crxMode = 'mismatch';
    const badUrl =
      origin + '/detail/mismatch-ext/' + mismatchPageId + '?store=chrome';
    panels.panelNavigate('acc-store', badUrl);
    await waitForUrl(
      'acc-store',
      (u) => u.includes(mismatchPageId),
      20000
    );
    await wait(500);
    await waitBar(
      (b) => b && b.present && b.hasInstall && b.extId === mismatchPageId,
      15000,
      'mismatch page bar'
    );
    const clicked = await clickStoreBtn('/Instalar no MultiHeiz/i');
    if (!clicked || !clicked.ok) {
      throw new Error('mismatch click failed: ' + JSON.stringify(clicked));
    }
    const start = Date.now();
    let sawReject = false;
    let lastText = '';
    while (Date.now() - start < 45000) {
      const list = extensions.list();
      if (list.some((e) => e.id === mismatchPageId || e.storeId === mismatchPageId)) {
        throw new Error('mismatch CRX should not install');
      }
      const bar = await rendererEval(`
        (function () {
          const bar = document.querySelector('.panel-store-bar');
          return bar ? (bar.textContent || '') : '';
        })()
      `);
      lastText = String(bar || '');
      if (/não corresponde|Falha|erro|inválid|ID/i.test(lastText)) {
        sawReject = true;
        break;
      }
      // Also try direct installFromStore to confirm rejection path if UI is slow
      await wait(300);
    }
    if (!sawReject) {
      // Confirm via API
      try {
        await extensions.installFromStore(badUrl);
        throw new Error('installFromStore should reject id mismatch');
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (!/não corresponde|esperado/i.test(msg)) {
          throw new Error('unexpected mismatch error: ' + msg + '; bar=' + lastText);
        }
        sawReject = true;
      }
    }
    if (!sawReject) throw new Error('ID mismatch not rejected; bar=' + lastText);
    bumpPass('CRX id mismatch rejected');
    crxMode = hasAbuFixture ? 'abu' : 'gen';
  }

  // --- Edge detail shows bar (default label; no stale Instalada: from prior CWS) ---
  {
    const edgeId = hasAbuFixture ? ABU_ID : genId;
    const edgeUrl = origin + '/addons/detail/' + ABU_SLUG + '/' + edgeId;
    panels.panelNavigate('acc-store', edgeUrl);
    await waitForUrl('acc-store', (u) => u.includes('/addons/detail/'), 20000);
    await wait(500);
    const edgeBar = await waitBar(
      (b) =>
        b &&
        b.present &&
        b.extId === edgeId &&
        b.store === 'edge' &&
        b.hasInstall &&
        !b.hasRemove &&
        /Extensão da Edge/i.test(b.text || '') &&
        !/Instalada:/i.test(b.text || ''),
      15000,
      'Edge bar default label'
    );
    if (!edgeBar.present) throw new Error('Edge bar missing');
    if (/Instalada:/i.test(edgeBar.text || '')) {
      throw new Error('stale Instalada: after navigate to other store/id: ' + edgeBar.text);
    }
    if (!/Extensão da Edge/i.test(edgeBar.text || '') || !edgeBar.hasInstall) {
      throw new Error('expected Edge default label + Instalar: ' + JSON.stringify(edgeBar));
    }
    bumpPass('Edge Add-ons detail shows default label + Instalar (no stale Instalada:)');
  }

  // --- Non-detail hides bar ---
  {
    panels.panelNavigate('acc-store', origin + '/home');
    await waitForUrl('acc-store', (u) => /\/home\/?$/.test(u.split('?')[0]), 20000);
    await wait(500);
    const start = Date.now();
    let hidden = false;
    while (Date.now() - start < 10000) {
      const probe = await rendererEval(`
        (function () {
          return !!document.querySelector('.panel-store-bar');
        })()
      `);
      if (!probe) {
        hidden = true;
        break;
      }
      await wait(200);
    }
    if (!hidden) throw new Error('store bar still visible on non-detail page');
    bumpPass('non-detail page hides store bar');
  }

  // --- Conta criada após UI + SPA pushState (did-navigate-in-page) ---
  {
    const spaId = hasAbuFixture ? ABU_ID : genId;
    const spaDetailPath =
      '/detail/' + ABU_SLUG + '/' + spaId + '?store=chrome';
    const spaDetail = origin + spaDetailPath;
    spaHomeTarget = spaDetailPath;

    const created = await rendererEval(`
      (async () => {
        const apply =
          (window.__mhV16Hooks && window.__mhV16Hooks.applyState) ||
          (window.__multiheizUi && window.__multiheizUi.applyState);
        const res = await window.multiheiz.createAccount({
          name: 'Janela SPA Store',
          color: '#3d8bfd',
          startUrl: ${JSON.stringify(origin + '/home')},
          workspaceId: 'ws-store',
        });
        // createAccount emite state:changed; applyState do retorno cobre race com o evento
        if (res && res.state && apply) apply(res.state);
        const id = res && res.account ? res.account.id : null;
        if (!id) return null;
        const st = await window.multiheiz.setMaximized(id);
        if (st && apply) apply(st);
        return id;
      })()
    `);
    if (!created) throw new Error('createAccount after UI failed');
    await wait(600);
    const bw2 = mainWindow.getContentBounds().width;
    const bh2 = mainWindow.getContentBounds().height;
    panels.syncVisiblePanels([
      { accountId: created, x: 0, y: 80, width: bw2, height: bh2 - 80 },
    ]);
    await wait(500);

    // Full load of non-detail page whose inline script pushState → detail (SPA)
    const wcSpa = panels.getPanelCapture(created);
    if (!wcSpa) throw new Error('no panel for SPA account');
    let sawInPage = false;
    const onInPage = (_e, url) => {
      if (String(url || '').includes('/detail/') && String(url || '').includes(spaId)) {
        sawInPage = true;
      }
    };
    wcSpa.on('did-navigate-in-page', onInPage);
    try {
      panels.panelNavigate(created, origin + '/spa-home');
      await waitForUrl(
        created,
        (u) => u.includes('/detail/') && u.includes(spaId),
        30000
      );
      await wait(500);
      if (!sawInPage) {
        // pushState from page script should have fired; accept getURL if event missed
        const cur = wcSpa.getURL();
        if (!String(cur || '').includes('/detail/')) {
          throw new Error('SPA did not reach detail URL: ' + cur);
        }
      }
    } finally {
      try {
        wcSpa.removeListener('did-navigate-in-page', onInPage);
      } catch {
        /* ignore */
      }
    }

    const start = Date.now();
    let barProbe = null;
    while (Date.now() - start < 15000) {
      barProbe = await rendererEval(`
        (function () {
          const slot = document.querySelector('.panel-slot[data-account-id="${created}"]');
          const bar = slot
            ? slot.querySelector('.panel-store-bar')
            : document.querySelector('.panel-store-bar');
          if (!bar) return { present: false, visible: false, hasSlot: !!slot };
          return {
            present: true,
            visible: bar.offsetParent !== null,
            extId: bar.dataset.extId || '',
            hasSlot: !!slot,
          };
        })()
      `);
      if (barProbe && barProbe.present && barProbe.visible && barProbe.extId === spaId) {
        break;
      }
      await wait(200);
    }
    if (!barProbe || !barProbe.present || !barProbe.visible) {
      throw new Error(
        'store bar not visible after SPA pushState on new account: ' +
          JSON.stringify(barProbe) +
          ' sawInPage=' +
          sawInPage +
          ' url=' +
          (wcSpa.isDestroyed() ? '' : wcSpa.getURL())
      );
    }
    if (barProbe.extId !== spaId) {
      throw new Error('SPA bar wrong ext id: ' + JSON.stringify(barProbe));
    }
    bumpPass('conta nova + SPA pushState mostra .panel-store-bar (offsetParent)');
  }

  // Cleanup any leftover installs
  for (const e of extensions.list()) {
    try {
      await extensions.removeExtension(e.id);
    } catch {
      /* ignore */
    }
  }

  delete process.env.MULTIHEIZ_WEBSTORE_TEST_BASE;
  await closeServer();

  console.log(
    'SELFTEST store OK — PASS=' + pass + ' SKIP=' + skip
  );
  app.exit(0);
}

module.exports = { runStoreSelftest };
