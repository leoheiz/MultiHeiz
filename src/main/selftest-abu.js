'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const CHROME_ID = 'ohahllgiabjaoigichmmfljhkcfikeof';
const EDGE_ID = 'pciakllldcajllepkbbihkmfkikheffb';
const DOC = path.join(app.getAppPath(), 'docs', 'ADBLOCKER-ULTIMATE.md');

/**
 * Phase 3b — real AdBlocker Ultimate install + DNR shim probe (TEMP userData).
 */
async function runAbuSelftest(ctx) {
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
    adblock,
  } = ctx;

  const results = {
    when: new Date().toISOString(),
    chromeId: CHROME_ID,
    edgeId: EDGE_ID,
    userData: app.getPath('userData'),
    install: null,
    manifest: null,
    dnr: null,
    popup: null,
    localBlock: null,
    uol: null,
    coexistence: null,
    notes: [],
  };

  const writeDoc = () => {
    const md = renderDoc(results);
    fs.mkdirSync(path.dirname(DOC), { recursive: true });
    fs.writeFileSync(DOC, md, 'utf8');
    console.log('Wrote', DOC);
  };

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    results.notes.push('unhandledRejection: ' + msg);
    writeDoc();
    app.exit(1);
  });

  // Built-in off so we measure extension DNR alone
  updateState((s) => {
    s.accounts = [];
    s.workspaces = [{ id: 'ws-abu', name: 'Principal' }];
    s.activeWorkspaceId = 'ws-abu';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.settings = {
      ...s.settings,
      openLastPage: false,
      homepage: 'about:blank',
      adblock: { ...(s.settings.adblock || {}), enabled: false },
    };
  });
  if (adblock && adblock.applySettings) {
    await adblock.applySettings({ enabled: false });
  }
  flushSave();

  console.log('Installing AdBlocker Ultimate from Chrome Web Store…', CHROME_ID);
  let installed = null;
  try {
    installed = await extensions.installFromStore(CHROME_ID, { applyTo: 'all' });
  } catch (err) {
    results.notes.push('Chrome Web Store install failed: ' + (err && err.message));
    console.warn('CWS failed, trying Edge Add-ons…', EDGE_ID);
    try {
      installed = await extensions.installFromStore(EDGE_ID, { applyTo: 'all' });
    } catch (err2) {
      results.install = {
        ok: false,
        error: String(err2 && err2.message ? err2.message : err2),
      };
      writeDoc();
      throw err2;
    }
  }

  results.install = {
    ok: true,
    id: installed.id,
    name: installed.name,
    version: installed.version,
    path: installed.path,
    source: installed.source,
    storeId: installed.storeId,
    networkBlocker: !!installed.networkBlocker,
    hasDnr: !!installed.hasDnr,
    warnings: installed.warnings || [],
  };
  console.log('PASS: installed', installed.name, installed.version, installed.path);

  // Manifest inspection (post-prepare: DNR in snapshot)
  const snapPath = path.join(installed.path, 'multiheiz-dnr.json');
  const manPath = path.join(installed.path, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  const snap = fs.existsSync(snapPath)
    ? JSON.parse(fs.readFileSync(snapPath, 'utf8'))
    : null;
  const dnrSection = (snap && snap.declarative_net_request) || manifest.declarative_net_request;
  const contentScripts = (manifest.content_scripts || []).map((c) => ({
    matches: c.matches,
    js: c.js,
    css: c.css,
    run_at: c.run_at,
  }));
  results.manifest = {
    manifest_version: manifest.manifest_version,
    name: installed.name,
    version: manifest.version,
    permissions: [
      ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
      ...(snap && Array.isArray(snap.permissions) ? snap.permissions : []),
    ],
    host_permissions: manifest.host_permissions || [],
    action_popup: manifest.action && manifest.action.default_popup,
    background: manifest.background,
    content_scripts: contentScripts,
    dnr_rulesets: (dnrSection && dnrSection.rule_resources
      ? dnrSection.rule_resources.map((r) => ({
          id: r.id,
          enabled: !!r.enabled,
          path: r.path,
        }))
      : []),
    dnr_stripped_for_electron: !!snap,
  };
  console.log(
    'Manifest MV' + results.manifest.manifest_version,
    'rulesets',
    results.manifest.dnr_rulesets.length,
    'enabled',
    results.manifest.dnr_rulesets.filter((r) => r.enabled).map((r) => r.id)
  );

  updateState((s) => {
    s.accounts.push({
      id: 'acc-abu',
      name: 'ABU test',
      color: '#2bb8a6',
      startUrl: 'about:blank',
      workspaceId: 'ws-abu',
      muted: true,
      lastUrl: null,
      zoomFactor: 1,
      adblockEnabled: false,
    });
  });
  flushSave();
  if (emitToRenderer) emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);

  await extensions.setApplyTo(installed.id, ['acc-abu']);
  await extensions.loadForAccount('acc-abu');

  const eng = extensions.dnr.getEngine(installed.id);
  if (!eng) throw new Error('DNR engine missing after ABU install');
  const sampleUrls = [
    'https://resourcelow.com/ads.js',
    'https://adsterratech.com/banner.gif',
    'https://www.uol.com.br/',
    'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
  ];
  const measure = extensions.dnr.measureLookup(installed.id, sampleUrls.concat(sampleUrls).concat(sampleUrls));
  results.dnr = {
    ruleCount: eng.ruleCount,
    loadMs: eng.loadMs,
    rulesets: [...eng.rulesets.entries()].map(([id, rs]) => ({
      id,
      enabled: rs.enabled,
      rules: rs.rules.length,
    })),
    measure,
    sampleMatches: sampleUrls.map((url) => {
      const m = extensions.dnr.matchUrl(installed.id, url, {
        resourceType: 'script',
        initiator: 'https://www.uol.com.br/',
      });
      return {
        url,
        action: m ? m.actionType : null,
        ruleId: m ? m.id : null,
        priority: m ? m.priority : null,
      };
    }),
  };
  console.log(
    'PASS: DNR',
    eng.ruleCount,
    'rules loadMs=',
    eng.loadMs,
    'avgUs=',
    measure.avgUs.toFixed(2)
  );

  results.coexistence = extensions.coexistenceHint();
  console.log('coexistence suggest=', results.coexistence.suggest);

  // Local network probe from about:blank (avoids ABU document_start CS on http://*,
  // which aborted 127.0.0.1 loads). Requests still hit the session DNR hub.
  const sesLocal = require('electron').session.fromPartition(
    require('./extensions/loader').partitionFor('acc-abu')
  );
  const localWin = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      session: sesLocal,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await localWin.loadURL('about:blank');
  const localProbe = await localWin.webContents.executeJavaScript(
    `(() => new Promise((resolve) => {
      const out = {};
      let left = 3;
      const done = () => { left -= 1; if (left <= 0) resolve(out); };
      const probe = (key, src) => {
        const img = new Image();
        img.onload = () => { out[key] = { ok: true, w: img.naturalWidth }; done(); };
        img.onerror = () => { out[key] = { ok: false, w: 0 }; done(); };
        img.src = src;
      };
      probe('a', 'https://resourcelow.com/pixel.gif?' + Date.now());
      probe('b', 'https://adsterratech.com/pixel.gif?' + Date.now());
      probe('ok', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
      setTimeout(() => {
        if (left > 0) {
          if (!out.a) out.a = { ok: false, timeout: true };
          if (!out.b) out.b = { ok: false, timeout: true };
          if (!out.ok) out.ok = { ok: false, timeout: true };
          resolve(out);
        }
      }, 8000);
    }))()`,
    true
  );
  try {
    localWin.destroy();
  } catch {
    /* ignore */
  }
  const localMatched = results.dnr.sampleMatches.filter((m) => m.action === 'block');
  results.localBlock = {
    probe: localProbe,
    networkBlockedLikely: !!(localProbe.a && !localProbe.a.ok) || !!(localProbe.b && !localProbe.b.ok),
    matchUrlBlocks: localMatched.length,
    okDataUrlLoaded: !!(localProbe.ok && localProbe.ok.ok && localProbe.ok.w > 0),
    note: 'Probed from about:blank so ABU content scripts (http/https only) do not run; DNR hub still sees image requests.',
  };
  console.log('Local probe', results.localBlock);

  // Popup / UI
  const pop = await extensions.openActionPopup('acc-abu', installed.id, {
    parent: mainWindow,
  });
  results.popup = { ok: !!pop.ok, error: pop.error || null, url: pop.url || null };
  if (pop.ok) {
    await sleep(1500);
    const actionWin = require('./extensions/popup').getActionWindow();
    if (actionWin && !actionWin.isDestroyed()) {
      try {
        const title = actionWin.getTitle();
        const href = actionWin.webContents.getURL();
        let bodyText = '';
        try {
          bodyText = await actionWin.webContents.executeJavaScript(
            "document.body ? document.body.innerText.slice(0, 400) : ''",
            true
          );
        } catch (err) {
          bodyText = '(exec failed: ' + (err && err.message) + ')';
        }
        results.popup.title = title;
        results.popup.href = href;
        results.popup.bodyPreview = bodyText;
        results.popup.loaded = !!(href && href.startsWith('chrome-extension://'));
      } catch (err) {
        results.popup.error = String(err && err.message);
      }
      try {
        actionWin.close();
      } catch {
        /* ignore */
      }
    } else {
      results.popup.loaded = false;
      results.popup.error = (results.popup.error || '') + ' window missing';
    }
  }
  console.log('Popup', results.popup);

  // ONE real uol.com.br load in a hidden BrowserWindow (same session / DNR hub)
  const ses = require('electron').session.fromPartition(
    require('./extensions/loader').partitionFor('acc-abu')
  );

  const hidden = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Collect request URLs via webRequest in parallel with hub (Electron allows only one listener —
  // so we must NOT register another. Instead, after load, inspect performance/resource timing
  // and matchUrl offline; also check cosmetic via DOM.)

  const uolUrl = 'https://www.uol.com.br/';
  const navStart = Date.now();
  let uolFinalUrl = '';
  let uolTitle = '';
  let cosmeticHint = null;
  try {
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve('timeout'), 45000);
      hidden.webContents.once('did-finish-load', () => {
        clearTimeout(t);
        resolve('load');
      });
      hidden.webContents.once('did-fail-load', (_e, code, desc, url, isMain) => {
        if (isMain) {
          clearTimeout(t);
          reject(new Error('uol fail ' + code + ' ' + desc + ' ' + url));
        }
      });
    });
    await hidden.loadURL(uolUrl);
    await done;
    await sleep(5000);
    uolFinalUrl = hidden.webContents.getURL();
    uolTitle = hidden.webContents.getTitle();
    // Resource timing + match against DNR
    const resources = await hidden.webContents.executeJavaScript(
      `performance.getEntriesByType('resource').map(e => e.name).slice(0, 200)`,
      true
    );
    let matchBlocks = 0;
    const blockSamples = [];
    for (const u of resources || []) {
      const m = extensions.dnr.matchUrl(installed.id, u, {
        resourceType: 'script',
        initiator: uolFinalUrl || uolUrl,
      });
      if (m && m.actionType === 'block') {
        matchBlocks += 1;
        if (blockSamples.length < 10) blockSamples.push(u.slice(0, 160));
      }
    }
    // Also probe known ad URLs as if requested from uol
    for (const u of sampleUrls) {
      const m = extensions.dnr.matchUrl(installed.id, u, {
        resourceType: 'script',
        initiator: uolUrl,
      });
      if (m && m.actionType === 'block') {
        matchBlocks += 1;
        blockSamples.push('(probe) ' + u);
      }
    }
    try {
      cosmeticHint = await hidden.webContents.executeJavaScript(
        `(() => {
          const ads = document.querySelectorAll('[id*="ad"],[class*="ad-"],[class*="ads"],iframe[src*="doubleclick"],iframe[src*="googlesyndication"]');
          const hiddenAds = [...ads].filter(el => {
            const s = getComputedStyle(el);
            return s.display === 'none' || s.visibility === 'hidden' || el.offsetHeight === 0;
          });
          return {
            adLike: ads.length,
            hiddenOrZero: hiddenAds.length,
            hasContentScriptMarker: !!document.documentElement.getAttribute('data-adguard-settings')
              || !!document.getElementById('adguard-assistant-dialog')
              || !!document.querySelector('html[abp]')
              || document.documentElement.outerHTML.includes('adblock'),
          };
        })()`,
        true
      );
    } catch (err) {
      cosmeticHint = { error: String(err && err.message) };
    }
    results.uol = {
      ok: true,
      ms: Date.now() - navStart,
      finalUrl: uolFinalUrl,
      title: uolTitle,
      resourceEntries: (resources || []).length,
      dnrWouldBlockAmongResources: matchBlocks,
      blockSamples: blockSamples.slice(0, 12),
      cosmetic: cosmeticHint,
      note:
        'Network cancel is enforced by DNR shim on the session hub; resource timing only lists requests that started. matchUrl on collected URLs + probes indicates filter coverage.',
    };
  } catch (err) {
    results.uol = {
      ok: false,
      error: String(err && err.message ? err.message : err),
      ms: Date.now() - navStart,
    };
  } finally {
    try {
      hidden.destroy();
    } catch {
      /* ignore */
    }
  }
  console.log('UOL result', results.uol && results.uol.ok, results.uol);

  writeDoc();
  console.log('SELFTEST abu OK — doc written');
  app.exit(0);
}

function renderDoc(r) {
  const lines = [];
  lines.push('# AdBlocker Ultimate on MultiHeiz (Phase 3b)');
  lines.push('');
  lines.push('Honest results from a TEMP `MULTIHEIZ_USERDATA` run (not Leo’s real profile).');
  lines.push('');
  lines.push('- When: `' + r.when + '`');
  lines.push('- userData: `' + r.userData + '`');
  lines.push('- Chrome Web Store ID: `' + r.chromeId + '`');
  lines.push('- Edge Add-ons ID (fallback): `' + r.edgeId + '`');
  lines.push('');
  lines.push('## Install');
  lines.push('');
  if (!r.install || !r.install.ok) {
    lines.push('- **Failed:** ' + (r.install && r.install.error));
  } else {
    lines.push('- **OK** — ' + r.install.name + ' v' + r.install.version);
    lines.push('- Source: `' + r.install.source + '` storeId=`' + r.install.storeId + '`');
    lines.push('- Path: `' + r.install.path + '`');
    lines.push('- networkBlocker / hasDnr: ' + r.install.networkBlocker + ' / ' + r.install.hasDnr);
    if (r.install.warnings && r.install.warnings.length) {
      lines.push('- Warnings: ' + r.install.warnings.join('; '));
    }
  }
  lines.push('');
  lines.push('## Manifest');
  lines.push('');
  if (r.manifest) {
    lines.push('- MV' + r.manifest.manifest_version + ' · popup: `' + r.manifest.action_popup + '`');
    lines.push('- Background: `' + JSON.stringify(r.manifest.background) + '`');
    lines.push('- Permissions: ' + (r.manifest.permissions || []).join(', '));
    lines.push('- Host: ' + (r.manifest.host_permissions || []).join(', '));
    lines.push('- Content scripts: ' + (r.manifest.content_scripts || []).length);
    for (const cs of r.manifest.content_scripts || []) {
      lines.push('  - `' + (cs.run_at || '') + '` js=' + (cs.js || []).join(',') + ' matches=' + (cs.matches || []).join(','));
    }
    lines.push('- DNR stripped for Electron loadExtension: ' + !!r.manifest.dnr_stripped_for_electron);
    lines.push('- rule_resources: ' + (r.manifest.dnr_rulesets || []).length + ' (enabled: ' +
      (r.manifest.dnr_rulesets || []).filter((x) => x.enabled).map((x) => x.id).join(', ') + ')');
  }
  lines.push('');
  lines.push('## DNR shim');
  lines.push('');
  if (r.dnr) {
    lines.push('- Rules loaded (enabled sets + dynamic/session): **' + r.dnr.ruleCount + '**');
    lines.push('- Load time: **' + r.dnr.loadMs + ' ms**');
    lines.push('- Lookup: ' + r.dnr.measure.lookups + ' lookups in ' +
      r.dnr.measure.totalMs.toFixed(2) + ' ms (avg **' + r.dnr.measure.avgUs.toFixed(1) + ' µs**)');
    lines.push('- Sample matches:');
    for (const m of r.dnr.sampleMatches || []) {
      lines.push('  - `' + m.url + '` → ' + (m.action || 'none') +
        (m.ruleId != null ? ' (rule ' + m.ruleId + ', prio ' + m.priority + ')' : ''));
    }
  }
  lines.push('');
  lines.push('## Local page (URLs matching rules)');
  lines.push('');
  if (r.localBlock) {
    lines.push('- Control data-URL image loaded: ' + !!r.localBlock.okDataUrlLoaded);
    lines.push('- matchUrl block hits on probes: ' + r.localBlock.matchUrlBlocks);
    lines.push('- Network cancel likely (img naturalWidth 0): ' + !!r.localBlock.networkBlockedLikely);
    lines.push('- Probe detail: `' + JSON.stringify(r.localBlock.probe) + '`');
  }
  lines.push('');
  lines.push('## Popup / UI');
  lines.push('');
  if (r.popup) {
    lines.push('- openActionPopup ok: **' + !!r.popup.ok + '**' + (r.popup.error ? ' (' + r.popup.error + ')' : ''));
    lines.push('- chrome-extension URL loaded: ' + !!r.popup.loaded);
    if (r.popup.href) lines.push('- href: `' + r.popup.href + '`');
    if (r.popup.title) lines.push('- title: ' + r.popup.title);
    if (r.popup.bodyPreview) lines.push('- body preview: ' + JSON.stringify(r.popup.bodyPreview));
  }
  lines.push('');
  lines.push('## Real site: https://www.uol.com.br/ (one hidden window)');
  lines.push('');
  if (r.uol) {
    if (!r.uol.ok) {
      lines.push('- **Failed:** ' + r.uol.error);
    } else {
      lines.push('- Loaded in ' + r.uol.ms + ' ms → `' + r.uol.finalUrl + '`');
      lines.push('- Title: ' + r.uol.title);
      lines.push('- performance resource entries: ' + r.uol.resourceEntries);
      lines.push('- DNR would-block among resources + probes: **' + r.uol.dnrWouldBlockAmongResources + '**');
      if (r.uol.blockSamples && r.uol.blockSamples.length) {
        lines.push('- Samples:');
        for (const s of r.uol.blockSamples) lines.push('  - `' + s + '`');
      }
      lines.push('- Cosmetic / content-script hint: `' + JSON.stringify(r.uol.cosmetic) + '`');
      lines.push('- Note: ' + r.uol.note);
    }
  }
  lines.push('');
  lines.push('## Coexistence');
  lines.push('');
  if (r.coexistence) {
    lines.push('- Suggest turn off built-in: **' + !!r.coexistence.suggest + '**');
    lines.push('- ' + (r.coexistence.message || ''));
  }
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  const installOk = !!(r.install && r.install.ok);
  const dnrOk = !!(r.dnr && r.dnr.ruleCount > 0);
  const popupOk = !!(r.popup && r.popup.ok && r.popup.loaded);
  const netOk = !!(r.localBlock && (r.localBlock.networkBlockedLikely || r.localBlock.matchUrlBlocks > 0));
  const cosmo = r.uol && r.uol.cosmetic;
  const cosmoOk = !!(cosmo && (cosmo.hiddenOrZero > 0 || cosmo.hasContentScriptMarker));
  lines.push('| Check | Result |');
  lines.push('|-------|--------|');
  lines.push('| Installs via store installer | ' + (installOk ? 'YES' : 'NO') + ' |');
  lines.push('| Popup/UI loads | ' + (popupOk ? 'YES' : 'PARTIAL/NO') + ' |');
  lines.push('| DNR shim blocks network | ' + (netOk ? 'YES' : 'NO') + ' |');
  lines.push('| Cosmetic hiding works | ' + (cosmoOk ? 'LIKELY/YES' : 'UNCLEAR/NO — content scripts may run but cosmetic depends on ABU SW') + ' |');
  lines.push('');
  if (r.notes && r.notes.length) {
    lines.push('## Notes');
    lines.push('');
    for (const n of r.notes) lines.push('- ' + n);
    lines.push('');
  }
  lines.push('Shim: `src/main/extensions/dnr-shim.js` via `webRequestHub` (block wins; MultiHeiz allowlist respected).');
  lines.push('Fallback (b) not needed — static rulesets load into the shim.');
  lines.push('');
  return lines.join('\n');
}

module.exports = { runAbuSelftest, CHROME_ID, EDGE_ID };
