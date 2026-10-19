'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, session } = require('electron');

/**
 * Real-site adblock check (internet). Writes docs/adblock-real-results.md + screenshots.
 */
async function runAdblockRealCheck(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    rendererEval,
    adblock,
  } = ctx;

  console.log('CHECK adblock-real');
  const docsDir = path.join(__dirname, '..', '..', 'docs');
  const shotsDir = path.join(docsDir, 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });

  await adblock.whenReady();
  // Force default lists download (not offline test filters)
  process.env.MULTIHEIZ_ADBLOCK_TEST = '0';
  await adblock.applySettings({
    enabled: true,
    cosmetic: true,
    antiTracking: true,
    youtubeExperimental: true,
  });
  const status0 = await adblock.updateListsNow();
  console.log(
    'engine',
    status0.engineSource,
    'net',
    status0.networkFilterCount,
    'cos',
    status0.cosmeticFilterCount,
    'res',
    status0.resourcesLoaded,
    'buildMs',
    status0.lastBuildMs
  );

  updateState((s) => {
    s.accounts = [
      {
        id: 'acc-real-a',
        name: 'Real A',
        color: '#2bb8a6',
        startUrl: 'about:blank',
        workspaceId: s.activeWorkspaceId,
        muted: false,
        pauseInBackground: false,
        privateHistory: false,
        adblockEnabled: true,
        lastUrl: null,
      },
      {
        id: 'acc-real-b',
        name: 'Real B',
        color: '#3d8bfd',
        startUrl: 'about:blank',
        workspaceId: s.activeWorkspaceId,
        muted: false,
        pauseInBackground: false,
        privateHistory: false,
        adblockEnabled: true,
        lastUrl: null,
      },
      {
        id: 'acc-real-c',
        name: 'Real C',
        color: '#e67e22',
        startUrl: 'about:blank',
        workspaceId: s.activeWorkspaceId,
        muted: false,
        pauseInBackground: false,
        privateHistory: false,
        adblockEnabled: true,
        lastUrl: null,
      },
    ];
    s.layout = '3';
    s.page = 0;
  });
  flushSave();

  panels.createPanel('acc-real-a');
  panels.createPanel('acc-real-b');
  panels.createPanel('acc-real-c');
  await sleep(500);
  adblock.attachSession(session.fromPartition(panels.partitionFor('acc-real-a')), 'acc-real-a');
  adblock.attachSession(session.fromPartition(panels.partitionFor('acc-real-b')), 'acc-real-b');
  adblock.attachSession(session.fromPartition(panels.partitionFor('acc-real-c')), 'acc-real-c');

  try {
    await rendererEval(
      'window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()'
    );
  } catch { /* ignore */ }
  await sleep(800);

  const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  // One SERP query per run only — repeated /search?q= hits trigger Google captcha on home IPs.
  const GOOGLE_HOME = 'https://www.google.com/?hl=pt-BR';
  const GOOGLE_SEARCH = 'https://www.google.com/search?q=seguro+auto&hl=pt-BR';
  const NEWS_URL = 'https://www.uol.com.br/';
  /** @type {boolean} */
  let googleSearchUsed = false;
  async function navigateGoogleOnce(accountId, mode) {
    if (mode === 'search') {
      if (googleSearchUsed) {
        console.log('WARN: skipping extra Google search (1 query/run throttle)');
        return;
      }
      googleSearchUsed = true;
      panels.panelNavigate(accountId, GOOGLE_SEARCH);
      return;
    }
    panels.panelNavigate(accountId, GOOGLE_HOME);
  }

  async function shot(name, accountId) {
    try {
      await sleep(500);
      try {
        await rendererEval(
          'window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()'
        );
      } catch { /* ignore */ }
      await sleep(300);
      let img = null;
      const wc = panels.getPanelCapture(accountId);
      if (wc && !wc.isDestroyed()) {
        try {
          img = await wc.capturePage();
          if (img && img.isEmpty()) img = null;
        } catch { img = null; }
      }
      if (!img) {
        img = await mainWindow.webContents.capturePage();
      }
      const buf = img.toPNG();
      if (!buf || !buf.length) throw new Error('empty png');
      fs.writeFileSync(path.join(shotsDir, name), buf);
      console.log('PASS: screenshot', name, buf.length, 'bytes');
    } catch (err) {
      console.log('WARN: screenshot', name, err && err.message);
    }
  }

  async function probeGoogle(accountId) {
    const wc = panels.getPanelCapture(accountId);
    return wc.executeJavaScript(`(function(){
      const sels = ['[data-text-ad]', '#tads', '#bottomads', '#tadsb', '.uEierd', '[aria-label="Anúncios"]'];
      const found = {};
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) { found[s] = null; continue; }
        const st = getComputedStyle(el);
        found[s] = { display: st.display, visibility: st.visibility, h: el.offsetHeight };
      }
      return {
        title: document.title,
        url: location.href,
        found,
        consent: !!(document.querySelector('#L2AGLb, form[action*="consent"], #introAgreeButton')),
      };
    })()`);
  }

  async function probeNews(accountId) {
    const wc = panels.getPanelCapture(accountId);
    return wc.executeJavaScript(`(function(){
      return {
        title: document.title,
        url: location.href,
        adSlots: document.querySelectorAll('[id*="ad"],[class*="advert"],[class*="banner"],iframe[src*="doubleclick"],iframe[src*="googlesyndication"]').length,
      };
    })()`);
  }

  async function probeYoutube(accountId) {
    const wc = panels.getPanelCapture(accountId);
    return wc.executeJavaScript(`(function(){
      const player = document.querySelector('.html5-video-player, #movie_player');
      const adShowing = !!(player && player.classList.contains('ad-showing'));
      const adOverlay = !!document.querySelector('.ytp-ad-player-overlay, .ytp-ad-text, .video-ads .ytp-ad-module');
      const adCountdown = (document.querySelector('.ytp-ad-duration-remaining, .ytp-ad-preview-text') || {}).textContent || '';
      const video = document.querySelector('video');
      return {
        title: document.title,
        url: location.href,
        adShowing,
        adOverlay,
        adCountdown: String(adCountdown).trim(),
        hasAdModule: !!document.querySelector('.ytp-ad-module, .video-ads'),
        paused: video ? !!video.paused : null,
        currentTime: video ? video.currentTime : null,
        consent: !!(document.querySelector('button[aria-label*="Accept"], form[action*="consent"], tp-yt-paper-dialog')),
        sorry: /sorry|captcha|unusual traffic/i.test(document.title + ' ' + (document.body && document.body.innerText || '').slice(0, 400)),
      };
    })()`);
  }

  function isSorryPage(probe) {
    if (!probe) return false;
    if (probe.sorry) return true;
    const u = String(probe.url || '');
    return /google\.com\/sorry|\/sorry\//i.test(u);
  }

  function recentHas(accountId, re) {
    const recent = adblock.getRecentBlocked(accountId) || [];
    return recent.filter((u) => re.test(u));
  }

  function recentReqHas(accountId, re) {
    const recent = (adblock.getRecentRequests && adblock.getRecentRequests(accountId)) || [];
    return recent.filter((r) => re.test(r.url || ''));
  }

  /** @type {any} */
  const results = {
    engine: status0,
    google: {},
    news: {},
    youtube: {},
  };

  // ---- Google OFF (homepage only — no /search?q=) ----
  await adblock.applySettings({ enabled: false });
  await navigateGoogleOnce('acc-real-a', 'home');
  await waitForUrl('acc-real-a', (u) => u.includes('google.'), 45000).catch(() => {});
  await sleep(5000);
  // best-effort consent dismiss
  try {
    await panels.getPanelCapture('acc-real-a').executeJavaScript(`(function(){
      const b = document.querySelector('#L2AGLb, button[aria-label*="Aceitar"], button[aria-label*="Accept all"]');
      if (b) b.click();
    })()`);
    await sleep(2500);
  } catch {
    /* ignore */
  }
  results.google.off = {
    probe: await probeGoogle('acc-real-a'),
    blocked: adblock.getPageStats('acc-real-a').pageBlocked,
    recent: adblock.getRecentBlocked('acc-real-a').slice(0, 15),
    note: 'homepage only (no SERP) to avoid captcha',
  };
  // Throttle before the single SERP query
  await sleep(4000);

  // ---- Google ON (the only /search?q= navigation this run) ----
  await adblock.applySettings({ enabled: true });
  await navigateGoogleOnce('acc-real-a', 'search');
  await waitForUrl('acc-real-a', (u) => u.includes('google.'), 45000).catch(() => {});
  await sleep(5500);
  try {
    await panels.getPanelCapture('acc-real-a').executeJavaScript(`(function(){
      const b = document.querySelector('#L2AGLb, button[aria-label*="Aceitar"], button[aria-label*="Accept all"]');
      if (b) b.click();
    })()`);
    await sleep(2500);
  } catch {
    /* ignore */
  }
  results.google.on = {
    probe: await probeGoogle('acc-real-a'),
    blocked: adblock.getPageStats('acc-real-a').pageBlocked,
    recent: adblock.getRecentBlocked('acc-real-a').slice(0, 15),
    doubleclick: recentHas('acc-real-a', /doubleclick|googlesyndication|pagead/i).length,
    note: 'single SERP query this run',
  };
  if (isSorryPage(results.google.on.probe) || isSorryPage(results.google.off.probe)) {
    results.captcha = 'captcha — tentar mais tarde';
    console.log('STOP: Google captcha/sorry — captcha — tentar mais tarde');
  }
  await shot('v1.8-google.png', 'acc-real-a');

  // ---- News ON (skip OFF to cut traffic) ----
  await adblock.applySettings({ enabled: true });
  panels.panelNavigate('acc-real-b', NEWS_URL);
  await waitForUrl('acc-real-b', (u) => u.includes('uol.com'), 45000).catch(() => {});
  await sleep(7000);
  results.news.on = {
    probe: await probeNews('acc-real-b'),
    blocked: adblock.getPageStats('acc-real-b').pageBlocked,
    recent: adblock.getRecentBlocked('acc-real-b').slice(0, 20),
    adNetwork: recentHas('acc-real-b', /googlesyndication|doubleclick|pagead|adservice/i),
  };

  // ---- YouTube ON — muted ~45s, sample every 1s (max 2 YT loads/run) ----
  let ytLoads = 0;
  await adblock.applySettings({ enabled: true, youtubeExperimental: true });
  ytLoads += 1;
  panels.panelNavigate('acc-real-c', YT_URL);
  await waitForUrl('acc-real-c', (u) => u.includes('youtube.com'), 60000).catch(() => {});
  await sleep(3000);
  try {
    await panels.getPanelCapture('acc-real-c').executeJavaScript(`(function(){
      const btns = [...document.querySelectorAll('button, tp-yt-paper-button')];
      const accept = btns.find(b => /accept|aceitar|concord|agree/i.test(b.textContent || ''));
      if (accept) accept.click();
      try { const v = document.querySelector('video'); if (v) { v.muted = true; v.play().catch(()=>{}); } } catch(e) {}
    })()`);
  } catch {
    /* ignore */
  }
  panels.panelSetMuted('acc-real-c', true);

  const firstProbe = await probeYoutube('acc-real-c');
  if (isSorryPage(firstProbe)) {
    results.captcha = 'captcha — tentar mais tarde';
    results.youtube.on = {
      blocked: 0,
      note: 'captcha — tentar mais tarde',
      probe: firstProbe,
      adShowingSamples: 0,
      samples: [],
    };
    console.log('STOP: YouTube captcha/sorry — captcha — tentar mais tarde');
  } else {
    const samples = [];
    let ytAdFrames = 0;
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      const p = await probeYoutube('acc-real-c');
      if (isSorryPage(p)) {
        results.captcha = 'captcha — tentar mais tarde';
        console.log('STOP: YouTube captcha mid-run');
        samples.push(p);
        break;
      }
      if (p.adShowing || p.adOverlay) ytAdFrames += 1;
      samples.push({
        t: i + 1,
        adShowing: p.adShowing,
        adOverlay: p.adOverlay,
        adCountdown: p.adCountdown,
        currentTime: p.currentTime,
      });
      results.youtube.lastProbe = p;
      if (i % 10 === 0) {
        try {
          await panels.getPanelCapture('acc-real-c').executeJavaScript(
            `(function(){var v=document.querySelector('video');if(v){v.muted=true;if(v.paused)v.play().catch(()=>{});}})()`
          );
        } catch {
          /* ignore */
        }
      }
    }
    const ytRules = adblock.countYoutubeRules ? adblock.countYoutubeRules() : {};
    const adRelatedBlocked = recentHas(
      'acc-real-c',
      /pagead|\/api\/stats\/ads|doubleclick|ptracking|get_midroll/i
    );
    const adRelatedAllowed = recentReqHas(
      'acc-real-c',
      /pagead|\/api\/stats\/ads|doubleclick|ptracking|get_midroll/i
    ).filter((r) => !r.blocked);
    results.youtube.on = {
      blocked: adblock.getPageStats('acc-real-c').pageBlocked,
      recent: adblock.getRecentBlocked('acc-real-c').slice(0, 25),
      adRelatedBlocked,
      adRelatedAllowed: adRelatedAllowed.slice(0, 15),
      adShowingSamples: ytAdFrames,
      samples,
      probe: results.youtube.lastProbe || firstProbe,
      youtubeRuleCounts: ytRules,
      ytLoads,
    };
  }
  await shot('v1.8-youtube.png', 'acc-real-c');

  // Optional short OFF probe only if no captcha and under 2 YT loads
  if (!results.captcha && ytLoads < 2) {
    await adblock.applySettings({ enabled: false });
    ytLoads += 1;
    panels.panelNavigate('acc-real-c', YT_URL);
    await waitForUrl('acc-real-c', (u) => u.includes('youtube.com'), 60000).catch(() => {});
    await sleep(5000);
    results.youtube.off = {
      blocked: adblock.getPageStats('acc-real-c').pageBlocked,
      probe: await probeYoutube('acc-real-c'),
    };
  }

  const md = [];
  md.push('# Adblock real-site results (v1.8 phase 1)');
  md.push('');
  md.push(`Gerado: ${new Date().toISOString()}`);
  md.push('');
  md.push('## Motor');
  md.push('');
  md.push(`- Fonte: **${status0.engineSource}**`);
  md.push(`- Filtros rede: **${status0.networkFilterCount}**`);
  md.push(`- Filtros cosméticos: **${status0.cosmeticFilterCount}**`);
  md.push(`- Resources (scriptlets/redirects): **${status0.resourcesLoaded}**`);
  md.push(`- Build: **${status0.lastBuildMs} ms**, ΔRSS ~**${status0.lastBuildRssMb} MB**`);
  md.push(`- Mensagem: ${status0.statusMessage || '—'}`);
  if (adblock.countYoutubeRules) {
    const yr = adblock.countYoutubeRules();
    md.push(
      `- Regras YouTube (aprox.): rede **${yr.network}**, cosmético **${yr.cosmetic}**, scriptlets **${yr.scriptlets}**`
    );
  }
  md.push('');
  if (results.captcha) {
    md.push('## Captcha');
    md.push('');
    md.push(`**${results.captcha}**`);
    md.push('');
  }
  md.push('## Google Search (seguro+auto)');
  md.push('');
  md.push('Throttle: no máx. 1 SERP + 2 YouTube loads. Janela off-screen; screenshot do painel.');
  md.push('');
  md.push('| | Bloqueados | Notas |');
  md.push('|--|--|--|');
  md.push(
    `| OFF | ${results.google.off.blocked} | homepage only; ads visibles: ${JSON.stringify(results.google.off.probe && results.google.off.probe.found)} |`
  );
  md.push(
    `| ON | ${results.google.on.blocked} | single SERP; doubleclick/pagead recent: ${results.google.on.doubleclick}; found: ${JSON.stringify(results.google.on.probe && results.google.on.probe.found)} |`
  );
  md.push('');
  md.push('Screenshot (painel): `docs/screenshots/v1.8-google.png`');
  md.push('');
  md.push('## Notícias (UOL)');
  md.push('');
  md.push(
    `- ON blocked: ${(results.news.on && results.news.on.blocked) || 0}, ad-network hits blocked: ${((results.news.on && results.news.on.adNetwork) || []).length}`
  );
  md.push('');
  md.push('## YouTube (~45 s muted playback)');
  md.push('');
  if (results.youtube.on) {
    md.push(
      `- ON blocked: ${results.youtube.on.blocked}, ad-related blocked: ${((results.youtube.on.adRelatedBlocked) || results.youtube.on.adRelated || []).length}, ad-showing samples: ${results.youtube.on.adShowingSamples}`
    );
    if (results.youtube.on.note) md.push(`- Nota: ${results.youtube.on.note}`);
    if (results.youtube.on.youtubeRuleCounts) {
      md.push(`- Contagem regras YT: ${JSON.stringify(results.youtube.on.youtubeRuleCounts)}`);
    }
  }
  if (results.youtube.off) {
    md.push(`- OFF probe adShowing: ${results.youtube.off.probe && results.youtube.off.probe.adShowing}`);
  }
  md.push('');
  md.push('Screenshot (painel): `docs/screenshots/v1.8-youtube.png`');
  md.push('');
  md.push('## Limitações');
  md.push('');
  md.push('- Consent/cookie walls podem alterar o DOM (best effort).');
  md.push('- Anúncios de texto do Google Search dependem sobretudo de cosméticos.');
  md.push('- YouTube: scriptlets early MAIN WORLD (v1.8) + listas; pipeline muda com frequência.');
  md.push('- Se aparecer `google.com/sorry`, a corrida para com "captcha — tentar mais tarde".');
  md.push('');
  md.push('```json');
  md.push(JSON.stringify(results, null, 2));
  md.push('```');
  md.push('');

  fs.writeFileSync(path.join(docsDir, 'adblock-real-results.md'), md.join('\n'), 'utf8');
  console.log('PASS: wrote docs/adblock-real-results.md');
  console.log('PASS: check adblock-real complete');
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  } catch {
    /* ignore */
  }
  app.exit(0);
}

module.exports = { runAdblockRealCheck };
