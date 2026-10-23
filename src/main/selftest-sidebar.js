'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, nativeImage } = require('electron');
const { envGet } = require('./config');

/**
 * Optional full-window PNGs when MULTIHEIZ_SIDEBAR_SHOTS is a folder path.
 * Prefers BrowserWindow.capturePage (includes WebContentsView children); falls
 * back to compositing renderer + each panel at its bounds.
 */
function resolveSidebarShotsDir() {
  const raw = envGet('MULTIHEIZ_SIDEBAR_SHOTS');
  if (!raw) return null;
  const dir = path.resolve(String(raw).trim());
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function blitBgra(dst, dw, dh, src, sw, sh, ox, oy) {
  for (let y = 0; y < sh; y++) {
    const dy = (oy + y) | 0;
    if (dy < 0 || dy >= dh) continue;
    for (let x = 0; x < sw; x++) {
      const dx = (ox + x) | 0;
      if (dx < 0 || dx >= dw) continue;
      const si = (y * sw + x) * 4;
      const di = (dy * dw + dx) * 4;
      const a = src[si + 3];
      if (a === 0) continue;
      if (a === 255) {
        dst[di] = src[si];
        dst[di + 1] = src[si + 1];
        dst[di + 2] = src[si + 2];
        dst[di + 3] = 255;
        continue;
      }
      const inv = 255 - a;
      dst[di] = ((src[si] * a + dst[di] * inv) / 255) | 0;
      dst[di + 1] = ((src[si + 1] * a + dst[di + 1] * inv) / 255) | 0;
      dst[di + 2] = ((src[si + 2] * a + dst[di + 2] * inv) / 255) | 0;
      dst[di + 3] = 255;
    }
  }
}

async function captureWindowWithPanels(mainWindow, panels) {
  try {
    if (mainWindow && typeof mainWindow.capturePage === 'function') {
      const img = await mainWindow.capturePage();
      if (img && !img.isEmpty()) return img;
    }
  } catch (err) {
    console.log('sidebar shot: win.capturePage failed:', err && err.message ? err.message : err);
  }

  const chrome = await mainWindow.webContents.capturePage();
  const { width, height } = chrome.getSize();
  const [cw, ch] = mainWindow.getContentSize();
  const scaleX = cw > 0 ? width / cw : 1;
  const scaleY = ch > 0 ? height / ch : 1;
  const buf = Buffer.from(chrome.toBitmap());
  const info = panels.getPanelDebugInfo();
  for (const p of info.panels || []) {
    if (!p || !p.visible || p.parked || !p.bounds) continue;
    const b = p.bounds;
    if (!(b.width >= 2 && b.height >= 2)) continue;
    const wc = panels.getPanelCapture(p.accountId);
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) continue;
    let panelImg;
    try {
      panelImg = await wc.capturePage();
    } catch {
      continue;
    }
    if (!panelImg || panelImg.isEmpty()) continue;
    const psz = panelImg.getSize();
    blitBgra(
      buf,
      width,
      height,
      panelImg.toBitmap(),
      psz.width,
      psz.height,
      Math.round(b.x * scaleX),
      Math.round(b.y * scaleY)
    );
  }
  return nativeImage.createFromBitmap(buf, { width, height });
}

async function saveSidebarShot(ctx, fileName) {
  const dir = ctx._sidebarShotsDir;
  if (!dir) return;
  const { mainWindow, panels, sleep } = ctx;
  try {
    await sleep(120);
    const img = await captureWindowWithPanels(mainWindow, panels);
    if (!img || img.isEmpty()) {
      console.log('sidebar shot: empty image for', fileName);
      return;
    }
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, img.toPNG());
    console.log('SHOT:', file);
  } catch (err) {
    console.log('sidebar shot failed:', fileName, err && err.message ? err.message : err);
  }
}

/**
 * Selftest for sidebar auto-hide + legacy "always active" (1.3.0).
 * Overlay strategy under test: shift-x / keep-width on WebContentsView (see panels.js).
 */
async function runSidebarSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    rendererEval,
    waitForLayoutSettle,
    waitForPanels,
    chromeFullscreen,
    sidebarCursor,
  } = ctx;

  const phase = String(envGet('MULTIHEIZ_SELFTEST_PHASE') || '1');
  console.log('SELFTEST sidebar phase=' + phase);

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  if (phase === '2') {
    await runPhase2Persistence(ctx);
    return;
  }

  ctx._sidebarShotsDir = resolveSidebarShotsDir();
  if (ctx._sidebarShotsDir) {
    console.log('sidebar shots dir:', ctx._sidebarShotsDir);
  }

  let server = null;
  let port = 0;
  // Bright local page so panel displacement vs sidebar is obvious in optional PNGs.
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>sb</title></head>
<body style="margin:0;height:100vh;background:linear-gradient(135deg,#e85d4c 0%,#f0c14a 40%,#2bb8a6 70%,#3d8bfd 100%);color:#fff;font:bold 42px/1.2 system-ui,sans-serif">
<div style="box-sizing:border-box;height:100%;margin:16px;border:6px solid rgba(255,255,255,.85);display:flex;align-items:center;justify-content:center;text-shadow:0 2px 10px rgba(0,0,0,.45)">
<span id="t">SB PANEL</span>
</div>
</body></html>`;

  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;

  updateState((s) => {
    s.workspaces = [{ id: 'ws-sb', name: 'Sidebar' }];
    s.activeWorkspaceId = 'ws-sb';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-sb',
        name: 'Painel SB',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-sb',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
    s.ui = {
      ...(s.ui || {}),
      sidebarCollapsed: false,
      sidebarAutoHide: false,
      layoutLocked: true,
      sidebarWidth: 240,
    };
    s.settings = {
      ...s.settings,
      openLastPage: false,
      homepage: base + '/',
      sidebarAlwaysActive: false,
    };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(600);
  await waitForLayoutSettle();
  await waitForUrl('acc-sb', (u) => u.includes('127.0.0.1'), 30000);
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-sb' && p.visible && !p.parked));

  function panelBounds() {
    const info = panels.getPanelDebugInfo();
    const p = info.panels.find((x) => x.accountId === 'acc-sb');
    return { bounds: p && p.bounds, overlayW: info.sidebarOverlayWidth, lastSlots: info.lastSlots };
  }

  function near(a, b, tol = 3) {
    return Math.abs(a - b) <= tol;
  }

  if (!sidebarCursor || typeof sidebarCursor.setCursorOverride !== 'function') {
    console.log('FAIL: sidebarCursor selftest hooks missing');
    app.exit(1);
    return;
  }
  function setCursorContent(cx, cy) {
    const pt = sidebarCursor.contentPointToScreen(cx, cy);
    if (!pt) throw new Error('contentPointToScreen failed');
    sidebarCursor.setCursorOverride(pt);
  }
  const midY = Math.round((mainWindow.getContentSize()[1] || 900) / 2);
  /** Park cursor far from the left edge so polling does not race DOM-simulated reveals. */
  function parkCursorAway() {
    setCursorContent(400, midY);
  }

  /* ---------- Fixed mode (default on new profile): two independent buttons ---------- */
  let mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode || mode.autoHide !== false || mode.open !== false || mode.legacyAlwaysActive) {
    console.log('FAIL: start should be fixed (autoHide false, legacy off)', mode);
    app.exit(1);
    return;
  }
  if (mode.collapsed || mode.sidebarCollapsedPref) {
    console.log('FAIL: default fixed should be expanded', mode);
    app.exit(1);
    return;
  }
  if (!mode.collapseVisible || !mode.pinVisible) {
    console.log('FAIL: standard mode must show both arrow and pin', mode);
    app.exit(1);
    return;
  }
  if (mode.buttonsOverlap) {
    console.log('FAIL: arrow and pin must not overlap', mode);
    app.exit(1);
    return;
  }
  if (mode.pinTitle !== 'Esconder automaticamente' || mode.toggleTitle !== 'Esconder automaticamente') {
    console.log('FAIL: fixed pin tooltip', mode.pinTitle, mode.toggleTitle);
    app.exit(1);
    return;
  }
  if (mode.collapseTitle !== 'Recolher barra lateral') {
    console.log('FAIL: fixed collapse tooltip', mode.collapseTitle);
    app.exit(1);
    return;
  }
  if (!mode.pinFilled) {
    console.log('FAIL: pin should look filled when fixed', mode);
    app.exit(1);
    return;
  }
  const fixed = panelBounds();
  if (!fixed.bounds || fixed.overlayW !== 0) {
    console.log('FAIL: fixed bounds/overlay', fixed);
    app.exit(1);
    return;
  }
  if (!(fixed.bounds.x >= 160)) {
    console.log('FAIL: fixed panel x should start after sidebar', fixed.bounds);
    app.exit(1);
    return;
  }
  if (!(mode.sidebarWidth >= 160)) {
    console.log('FAIL: fixed expanded sidebar width', mode.sidebarWidth);
    app.exit(1);
    return;
  }
  const fixedX = fixed.bounds.x;
  const fixedW = fixed.bounds.width;
  console.log('PASS: fixed mode (default, two buttons)', { mode, bounds: fixed.bounds });
  await saveSidebarShot(ctx, 'sidebar-pinned.png');

  /* ---------- Arrow: fixed expanded → compact (panels reflow) ---------- */
  mode = await rendererEval('window.__multiheizUi.toggleSidebarCollapsed()');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.collapsed || mode.autoHide || !mode.pinVisible || !mode.collapseVisible) {
    console.log('FAIL: arrow should compact while staying fixed', mode);
    app.exit(1);
    return;
  }
  if (mode.buttonsOverlap || !mode.buttonsFitCompact) {
    console.log('FAIL: both buttons must fit compact 52px without overlap', mode);
    app.exit(1);
    return;
  }
  if (mode.collapseTitle !== 'Expandir barra lateral') {
    console.log('FAIL: compact collapse tooltip', mode.collapseTitle);
    app.exit(1);
    return;
  }
  if (!(mode.sidebarWidth >= 40 && mode.sidebarWidth <= 70)) {
    console.log('FAIL: fixed compact width ~52px', mode.sidebarWidth);
    app.exit(1);
    return;
  }
  const fixedCompact = panelBounds();
  if (fixedCompact.overlayW !== 0 || !(fixedCompact.bounds.x >= 40 && fixedCompact.bounds.x <= 90)) {
    console.log('FAIL: fixed compact panel bounds', fixedCompact);
    app.exit(1);
    return;
  }
  if (!(fixedCompact.bounds.width > fixedW + 50)) {
    console.log('FAIL: compact should free panel width', {
      compact: fixedCompact.bounds,
      fixedW,
    });
    app.exit(1);
    return;
  }
  console.log('PASS: fixed compact via arrow', { mode, bounds: fixedCompact.bounds });

  mode = await rendererEval('window.__multiheizUi.toggleSidebarCollapsed()');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.collapsed || mode.autoHide || !(mode.sidebarWidth >= 160)) {
    console.log('FAIL: arrow should expand again while fixed', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: fixed expand via arrow');

  /**
   * Regression (e68678d): #topbar is drag; interactive / sidebar / pin are no-drag;
   * with sidebar open, no point on the pin rect has effective region drag.
   * @param {string} label
   */
  async function assertTopbarAppRegions(label) {
    const probe = await rendererEval('window.__multiheizUi.getTopbarDragProbe()');
    if (!probe) {
      console.log('FAIL: getTopbarDragProbe missing', label);
      app.exit(1);
      return false;
    }
    if (probe.topbarRegion !== 'drag') {
      console.log('FAIL: #topbar must be app-region drag', label, probe.topbarRegion);
      app.exit(1);
      return false;
    }
    if (!probe.emptyEffective || probe.emptyEffective.region !== 'drag') {
      console.log('FAIL: empty topbar point must resolve to drag', label, probe.emptyEffective);
      app.exit(1);
      return false;
    }
    if (probe.settingsRegion !== 'no-drag') {
      console.log('FAIL: topbar settings button must be no-drag', label, probe.settingsRegion);
      app.exit(1);
      return false;
    }
    if (probe.layoutSelectRegion && probe.layoutSelectRegion !== 'no-drag') {
      console.log('FAIL: layout select must be no-drag', label, probe.layoutSelectRegion);
      app.exit(1);
      return false;
    }
    if (probe.sidebarRegion !== 'no-drag') {
      console.log('FAIL: #sidebar must be no-drag', label, probe.sidebarRegion);
      app.exit(1);
      return false;
    }
    // Pin may be hidden in legacy (non-F11); only assert when the control is on-screen.
    if (probe.pinRect) {
      if (probe.pinRegion !== 'no-drag') {
        console.log('FAIL: pin button must be no-drag', label, probe.pinRegion);
        app.exit(1);
        return false;
      }
      const pinDrag = (probe.pinSamples || []).find((s) => s && s.region === 'drag');
      if (pinDrag) {
        console.log('FAIL: pin rect must not have effective drag (sidebar open/fixed)', label, pinDrag);
        app.exit(1);
        return false;
      }
    }
    if (probe.collapseRect) {
      if (probe.collapseRegion && probe.collapseRegion !== 'no-drag') {
        console.log('FAIL: collapse arrow must be no-drag', label, probe.collapseRegion);
        app.exit(1);
        return false;
      }
      const collapseDrag = (probe.collapseSamples || []).find((s) => s && s.region === 'drag');
      if (collapseDrag) {
        console.log('FAIL: collapse rect must not have effective drag', label, collapseDrag);
        app.exit(1);
        return false;
      }
    }
    console.log('PASS: topbar app-region regression', label, {
      topbarRegion: probe.topbarRegion,
      empty: probe.emptyEffective && probe.emptyEffective.region,
      pinSamples: (probe.pinSamples || []).map((s) => s && s.region),
      collapseSamples: (probe.collapseSamples || []).map((s) => s && s.region),
    });
    return true;
  }

  if (!(await assertTopbarAppRegions('fixed'))) return;

  /* ---------- Toggle → auto-hide (hidden) ---------- */
  mode = await rendererEval('window.__multiheizUi.toggleSidebarAutoHide()');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.autoHide || mode.open) {
    console.log('FAIL: after toggle should be autoHide hidden', mode);
    app.exit(1);
    return;
  }
  if (mode.pinTitle !== 'Fixar barra lateral' || mode.toggleTitle !== 'Fixar barra lateral') {
    console.log('FAIL: auto-hide pin tooltip', mode.pinTitle, mode.toggleTitle);
    app.exit(1);
    return;
  }
  if (!mode.pinVisible || !mode.collapseVisible || mode.pinFilled) {
    console.log('FAIL: auto-hide must keep both buttons; pin unfilled', mode);
    app.exit(1);
    return;
  }
  if (mode.hotzoneHidden || !(mode.hotzoneWidth >= 4 && mode.hotzoneWidth <= 10)) {
    console.log('FAIL: hotzone should be visible ~6px', mode);
    app.exit(1);
    return;
  }
  const hidden = panelBounds();
  if (hidden.overlayW !== 0) {
    console.log('FAIL: overlay width should be 0 when hidden', hidden);
    app.exit(1);
    return;
  }
  // Hot-zone (~5) + grid padding/gap + focus frame → content x often ~12–20, not 0.
  if (!(hidden.bounds.x <= 24) || !(hidden.bounds.width > fixedW + 50)) {
    console.log('FAIL: auto-hidden panels should use nearly full width', {
      hidden: hidden.bounds,
      fixedX,
      fixedW,
    });
    app.exit(1);
    return;
  }
  const hiddenX = hidden.bounds.x;
  const hiddenW = hidden.bounds.width;
  console.log('PASS: auto-hide hidden + hotzone', { mode, bounds: hidden.bounds });
  await saveSidebarShot(ctx, 'sidebar-autohidden.png');

  parkCursorAway();
  await sleep(100);

  /* ---------- Hot-zone show (simulate + delay) ---------- */
  // DOM enter + cursor on hot edge so main polling does not cancel the show timer.
  await rendererEval('window.__multiheizUi.sidebarHotzoneEnter()');
  setCursorContent(5, midY);
  await sleep(80);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.open) {
    console.log('FAIL: should still be closed before show delay', mode);
    app.exit(1);
    return;
  }
  await sleep(120);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open) {
    console.log('FAIL: hotzone should open after ~150ms', mode);
    app.exit(1);
    return;
  }
  // Hold cursor inside the open strip so main polling does not race-hide.
  setCursorContent(80, midY);
  await sleep(80);
  const openB = panelBounds();
  if (!(openB.overlayW >= 200)) {
    console.log('FAIL: overlay width should match sidebar when open', openB);
    app.exit(1);
    return;
  }
  // Shift-x keep-width: visual x moves to overlayW; width stays ~hiddenW (may clip right)
  if (!near(openB.bounds.x, openB.overlayW, 4)) {
    console.log('FAIL: open bounds.x should equal overlay width (shift-x)', openB);
    app.exit(1);
    return;
  }
  if (!(await assertTopbarAppRegions('auto-hide-open'))) return;

  if (!near(openB.bounds.width, hiddenW, 6)) {
    console.log('FAIL: open bounds.width should keep logical width (no reflow)', {
      open: openB.bounds,
      hiddenW,
    });
    app.exit(1);
    return;
  }
  const logical = openB.lastSlots && openB.lastSlots.find((s) => s.accountId === 'acc-sb');
  if (!logical || !near(logical.x, hiddenX, 4) || !near(logical.width, hiddenW, 6)) {
    console.log('FAIL: lastSlots should stay logical (unshifted)', { logical, hiddenX, hiddenW });
    app.exit(1);
    return;
  }
  console.log('PASS: hotzone reveal + shift-x overlay bounds', openB);
  await saveSidebarShot(ctx, 'sidebar-hovered.png');

  /* ---------- Leave → hide (delay ~700ms) ---------- */
  const leaveT0 = Date.now();
  setCursorContent(440, midY);
  await sleep(500);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open) {
    console.log('FAIL: should still be open before ~700ms hide delay (at 500ms)', mode);
    app.exit(1);
    return;
  }
  await sleep(700);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.open) {
    console.log('FAIL: should hide after ~700ms leave (by 1200ms)', {
      mode,
      elapsedMs: Date.now() - leaveT0,
    });
    app.exit(1);
    return;
  }
  const afterHide = panelBounds();
  if (afterHide.overlayW !== 0 || !near(afterHide.bounds.x, hiddenX, 4)) {
    console.log('FAIL: bounds after hide', afterHide);
    app.exit(1);
    return;
  }
  console.log('PASS: leave hides sidebar (~700ms)', afterHide.bounds);

  /* ---------- Main cursor poll: reveal zone width ---------- */
  // Ensure tracking is on and sidebar closed.
  await rendererEval('window.__multiheizUi.setSidebarAutoHideOpen(false)');
  parkCursorAway();
  await sleep(100);
  setCursorContent(30, midY);
  await sleep(280);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.open) {
    console.log('FAIL: cursor at content x=30 must NOT reveal', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: cursor x=30 does not reveal');

  setCursorContent(10, midY);
  await sleep(80);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.open) {
    console.log('FAIL: should still be closed before show delay (x=10)', mode);
    app.exit(1);
    return;
  }
  await sleep(120);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open) {
    console.log('FAIL: cursor at content x=10 should reveal after ~150ms', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: cursor x=10 reveals (over panel)');

  await rendererEval('window.__multiheizUi.setSidebarAutoHideOpen(false)');
  await sleep(80);
  setCursorContent(-4, midY);
  await sleep(280);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open) {
    console.log('FAIL: cursor at content x=-4 (outside left edge) should reveal', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: cursor x=-4 outside left edge reveals');

  /* ---------- Diagonal trajectory edge → pin must not hide ---------- */
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  const pin = mode.pinCenter;
  if (!pin || !(pin.x > 20 && pin.y > 0)) {
    console.log('FAIL: pinCenter missing', mode);
    app.exit(1);
    return;
  }
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = 4 + (pin.x - 4) * t;
    const cy = midY + (pin.y - midY) * t;
    setCursorContent(cx, cy);
    await sleep(40);
    mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
    if (!mode.open) {
      console.log('FAIL: diagonal to pin closed sidebar at step', i, { cx, cy, mode });
      app.exit(1);
      return;
    }
  }
  // Rest briefly on pin
  setCursorContent(pin.x, pin.y);
  await sleep(400);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open) {
    console.log('FAIL: sidebar closed while cursor on pin', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: diagonal edge→pin keeps sidebar open');

  /* ---------- Leave far right → hide after ~700ms ---------- */
  const sw = Math.max(180, Math.min(400, Math.round(mode.sidebarWidth || 240)));
  setCursorContent(sw + 200, midY);
  await sleep(500);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open) {
    console.log('FAIL: far leave must still be open at 500ms', mode);
    app.exit(1);
    return;
  }
  await sleep(700);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.open) {
    console.log('FAIL: far leave must hide by ~1200ms', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: far leave hides after ~700ms');

  /* ---------- Hold open while native menu / rename ---------- */
  setCursorContent(10, midY);
  await sleep(280);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open) {
    console.log('FAIL: expected open before hold test', mode);
    app.exit(1);
    return;
  }
  await rendererEval('window.__multiheizUi.setSidebarNativeMenuOpen(true)');
  setCursorContent(sw + 200, midY);
  await sleep(1100);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open) {
    console.log('FAIL: must stay open while native menu hold', mode);
    app.exit(1);
    return;
  }
  await rendererEval('window.__multiheizUi.setSidebarNativeMenuOpen(false)');
  // Cursor still far — should schedule hide after hold clears
  await sleep(1100);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.open) {
    console.log('FAIL: should hide after hold cleared + delay', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: hold open with menu; hides after clear');

  /* ---------- Pin while revealed → fixed (no autoHide, overlay 0) ---------- */
  setCursorContent(8, midY);
  await sleep(280);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open || !mode.autoHide) {
    console.log('FAIL: expected revealed auto-hide before pin', mode);
    app.exit(1);
    return;
  }
  mode = await rendererEval('window.__multiheizUi.toggleSidebarAutoHide()');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.autoHide || mode.open || mode.toggleTitle !== 'Esconder automaticamente') {
    console.log('FAIL: pin while revealed should fix', mode);
    app.exit(1);
    return;
  }
  const pinnedFromOpen = panelBounds();
  if (pinnedFromOpen.overlayW !== 0 || !(pinnedFromOpen.bounds.x >= 160)) {
    console.log('FAIL: pin-from-revealed bounds', pinnedFromOpen);
    app.exit(1);
    return;
  }
  if (!(mode.sidebarWidth >= 160) || mode.appClassAutoHide) {
    console.log('FAIL: pin-from-revealed sidebar should be in-flow visible', mode);
    app.exit(1);
    return;
  }
  const tracking = sidebarCursor.getTracking();
  if (tracking.enabled) {
    console.log('FAIL: cursor polling must stop when fixed', tracking);
    app.exit(1);
    return;
  }
  sidebarCursor.setCursorOverride(null);
  console.log('PASS: pin while revealed → fixed + polling stopped', pinnedFromOpen.bounds);

  /* ---------- Toggle back into auto-hide then to fixed (legacy path still works) ---------- */
  mode = await rendererEval('window.__multiheizUi.toggleSidebarAutoHide()');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.autoHide || mode.open) {
    console.log('FAIL: toggle to auto-hide hidden', mode);
    app.exit(1);
    return;
  }
  mode = await rendererEval('window.__multiheizUi.toggleSidebarAutoHide()');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.autoHide || mode.open || mode.toggleTitle !== 'Esconder automaticamente') {
    console.log('FAIL: should be fixed again', mode);
    app.exit(1);
    return;
  }
  const fixedAgain = panelBounds();
  if (fixedAgain.overlayW !== 0 || !(fixedAgain.bounds.x >= 160)) {
    console.log('FAIL: fixed again bounds', fixedAgain);
    app.exit(1);
    return;
  }
  console.log('PASS: toggle back to fixed');

  /* ---------- Legacy mode: always visible compact rail, toggle expand, never auto-hide ---------- */
  mode = await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(true)');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.legacyAlwaysActive || mode.autoHide || mode.open || !mode.collapsed) {
    console.log('FAIL: legacy on should start compact (icon rail, no autoHide)', mode);
    app.exit(1);
    return;
  }
  if (mode.pinVisible) {
    console.log('FAIL: legacy must hide pin button', mode);
    app.exit(1);
    return;
  }
  if (!mode.collapseVisible) {
    console.log('FAIL: legacy must show collapse arrow', mode);
    app.exit(1);
    return;
  }
  if (mode.toggleTitle !== 'Expandir barra lateral' || mode.collapseTitle !== 'Expandir barra lateral') {
    console.log('FAIL: legacy compact tooltip', mode.toggleTitle, mode.collapseTitle);
    app.exit(1);
    return;
  }
  if (!mode.hotzoneHidden || mode.appClassAutoHide) {
    console.log('FAIL: legacy must hide hotzone / auto-hide class', mode);
    app.exit(1);
    return;
  }
  if (!(mode.sidebarWidth >= 40 && mode.sidebarWidth <= 70)) {
    console.log('FAIL: legacy start compact width ~52px', mode.sidebarWidth);
    app.exit(1);
    return;
  }
  const legacyCompact = panelBounds();
  if (legacyCompact.overlayW !== 0) {
    console.log('FAIL: legacy must not use overlay', legacyCompact);
    app.exit(1);
    return;
  }
  // Compact rail ~52px + padding → panel x well below expanded (~240).
  if (!(legacyCompact.bounds.x >= 40 && legacyCompact.bounds.x <= 90)) {
    console.log('FAIL: legacy compact panel x should sit after ~52px rail', legacyCompact.bounds);
    app.exit(1);
    return;
  }
  await rendererEval('window.__multiheizUi.sidebarHotzoneEnter()');
  await sleep(250);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.open || mode.autoHide || !mode.collapsed) {
    console.log('FAIL: legacy hotzone must not reveal overlay / must stay compact', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: legacy inicia compacto + hotzone inerte', {
    mode,
    bounds: legacyCompact.bounds,
  });

  // Head + arrow must not be caption-drag (Windows swallows real clicks otherwise).
  if (mode.headAppRegion === 'drag' || mode.collapseAppRegion === 'drag') {
    console.log('FAIL: legacy head/collapse must be no-drag for clicks', {
      headAppRegion: mode.headAppRegion,
      collapseAppRegion: mode.collapseAppRegion,
    });
    app.exit(1);
    return;
  }
  if (!(await assertTopbarAppRegions('legacy-compact'))) return;
  if (mode.collapseDisabled || mode.collapsePointerEvents === 'none') {
    console.log('FAIL: legacy collapse arrow must be clickable', mode);
    app.exit(1);
    return;
  }

  /* Real button click — compact → expand → compact */
  let clickRes = await rendererEval('window.__multiheizUi.clickSidebarToggleButton()');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!clickRes || !clickRes.ok) {
    console.log('FAIL: legacy clickSidebarToggleButton missing button', clickRes);
    app.exit(1);
    return;
  }
  if (!mode.legacyAlwaysActive || mode.collapsed || mode.autoHide) {
    console.log('FAIL: legacy real-button click should expand', mode);
    app.exit(1);
    return;
  }
  if (mode.toggleTitle !== 'Recolher barra lateral') {
    console.log('FAIL: legacy expanded tooltip', mode.toggleTitle);
    app.exit(1);
    return;
  }
  const legacyExpanded = panelBounds();
  if (legacyExpanded.overlayW !== 0 || !(legacyExpanded.bounds.x >= 160)) {
    console.log('FAIL: legacy expand should push panels (no overlay)', legacyExpanded);
    app.exit(1);
    return;
  }
  if (!(mode.sidebarWidth >= 160)) {
    console.log('FAIL: legacy expanded sidebar width', mode.sidebarWidth);
    app.exit(1);
    return;
  }
  if (!(legacyExpanded.bounds.x > legacyCompact.bounds.x + 80)) {
    console.log('FAIL: expand should reclaim panel x vs compact', {
      expanded: legacyExpanded.bounds,
      compact: legacyCompact.bounds,
    });
    app.exit(1);
    return;
  }
  console.log('PASS: legacy expand via #btn-sidebar-toggle', {
    sidebarWidth: mode.sidebarWidth,
    bounds: legacyExpanded.bounds,
  });
  await saveSidebarShot(ctx, 'sidebar-legacy-expanded.png');

  clickRes = await rendererEval('window.__multiheizUi.clickSidebarToggleButton()');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!clickRes || !clickRes.ok) {
    console.log('FAIL: legacy compact click missing button', clickRes);
    app.exit(1);
    return;
  }
  if (!mode.legacyAlwaysActive || !mode.collapsed || mode.autoHide) {
    console.log('FAIL: legacy real-button click should return to compact', mode);
    app.exit(1);
    return;
  }
  if (mode.toggleTitle !== 'Expandir barra lateral') {
    console.log('FAIL: legacy compact tooltip after second click', mode.toggleTitle);
    app.exit(1);
    return;
  }
  const legacyCompactAgain = panelBounds();
  if (legacyCompactAgain.overlayW !== 0) {
    console.log('FAIL: legacy re-compact must not use overlay', legacyCompactAgain);
    app.exit(1);
    return;
  }
  if (!(mode.sidebarWidth >= 40 && mode.sidebarWidth <= 70)) {
    console.log('FAIL: re-compact sidebar width ~52px', mode.sidebarWidth);
    app.exit(1);
    return;
  }
  if (!(legacyCompactAgain.bounds.x < legacyExpanded.bounds.x - 80)) {
    console.log('FAIL: re-compact should free panel width (smaller x)', {
      compact: legacyCompactAgain.bounds,
      expanded: legacyExpanded.bounds,
    });
    app.exit(1);
    return;
  }
  console.log('PASS: legacy compact via #btn-sidebar-toggle', {
    sidebarWidth: mode.sidebarWidth,
    bounds: legacyCompactAgain.bounds,
  });
  await saveSidebarShot(ctx, 'sidebar-legacy-collapsed.png');

  // Persist compact preference to disk before leaving legacy.
  flushSave();
  {
    const userData = app.getPath('userData');
    const statePath = path.join(userData, 'multiheiz-state.json');
    const rawCompact = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!rawCompact.ui || rawCompact.ui.sidebarCollapsed !== true) {
      console.log('FAIL: sidebarCollapsed true not written while legacy compact', rawCompact.ui);
      app.exit(1);
      return;
    }
    console.log('PASS: legacy compact sidebarCollapsed persisted to disk');
  }

  mode = await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(false)');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.legacyAlwaysActive || mode.autoHide || mode.collapsed) {
    console.log('FAIL: legacy off should return to fixed (new mode, no stuck auto-hide)', mode);
    app.exit(1);
    return;
  }
  if (!mode.pinVisible || !mode.collapseVisible) {
    console.log('FAIL: after legacy off both buttons must return', mode);
    app.exit(1);
    return;
  }
  if (mode.pinTitle !== 'Esconder automaticamente' || mode.toggleTitle !== 'Esconder automaticamente') {
    console.log('FAIL: after legacy off pin tooltip', mode.pinTitle, mode.toggleTitle);
    app.exit(1);
    return;
  }
  const afterLegacy = panelBounds();
  if (afterLegacy.overlayW !== 0 || !(afterLegacy.bounds.x >= 160)) {
    console.log('FAIL: after legacy off bounds', afterLegacy);
    app.exit(1);
    return;
  }
  console.log('PASS: legacy off → new fixed/auto-hide mode (clean)');

  /* ---------- Persist auto-hide for disk check + legacy for phase 2 ---------- */
  await rendererEval('window.__multiheizUi.toggleSidebarAutoHide()');
  await sleep(200);
  await waitForLayoutSettle();
  flushSave();
  const userData = app.getPath('userData');
  const statePath = path.join(userData, 'multiheiz-state.json');
  let raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!raw.ui || raw.ui.sidebarAutoHide !== true) {
    console.log('FAIL: sidebarAutoHide not written to state file', raw.ui);
    app.exit(1);
    return;
  }
  console.log('PASS: sidebarAutoHide persisted to disk');

  mode = await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(true)');
  await sleep(200);
  await waitForLayoutSettle();
  flushSave();
  raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!raw.settings || raw.settings.sidebarAlwaysActive !== true) {
    console.log('FAIL: sidebarAlwaysActive not written to state file', raw.settings);
    app.exit(1);
    return;
  }
  if (raw.ui.sidebarAutoHide !== true) {
    console.log('FAIL: ui.sidebarAutoHide should remain true under legacy', raw.ui);
    app.exit(1);
    return;
  }
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.legacyAlwaysActive || mode.autoHide) {
    console.log('FAIL: legacy overrides autoHide for UI', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: sidebarAlwaysActive persisted to disk (autoHide kept in ui)');

  /* ---------- Migration: missing sidebarAutoHide → fixed; dual-button expands fixed ---------- */
  {
    const { migrate } = require('./state');
    const m = migrate({
      version: 1,
      workspaces: [{ id: 'ws-sb', name: 'Sidebar' }],
      activeWorkspaceId: 'ws-sb',
      accounts: [],
      layout: '1',
      page: 0,
      ui: { sidebarCollapsed: true, layoutLocked: true, sidebarWidth: 240 },
      settings: { migrations: { keepAlive120: true } },
      appearance: { preset: 'escuro' },
      freeTiles: {},
    });
    if (m.ui.sidebarAutoHide !== false) {
      console.log('FAIL: missing sidebarAutoHide should migrate to fixed (autoHide false)', m.ui);
      app.exit(1);
      return;
    }
    // Dual-button one-shot: fixed profiles become expanded (no surprise shrink).
    if (m.ui.sidebarCollapsed !== false) {
      console.log('FAIL: dual-button migration should expand fixed profiles', m.ui);
      app.exit(1);
      return;
    }
    if (!m.settings.migrations || !m.settings.migrations.sidebarDualButtons130) {
      console.log('FAIL: sidebarDualButtons130 migration flag missing', m.settings);
      app.exit(1);
      return;
    }
    if (m.settings.sidebarAlwaysActive !== false) {
      console.log('FAIL: sidebarAlwaysActive default false', m.settings);
      app.exit(1);
      return;
    }
    const kept = migrate({
      version: 1,
      workspaces: [{ id: 'ws-sb', name: 'Sidebar' }],
      activeWorkspaceId: 'ws-sb',
      accounts: [],
      layout: '1',
      page: 0,
      ui: { sidebarCollapsed: true, sidebarAutoHide: true, layoutLocked: true, sidebarWidth: 240 },
      settings: { migrations: { keepAlive120: true }, sidebarAlwaysActive: false },
      appearance: { preset: 'escuro' },
      freeTiles: {},
    });
    if (kept.ui.sidebarAutoHide !== true) {
      console.log('FAIL: existing sidebarAutoHide true must be kept', kept.ui);
      app.exit(1);
      return;
    }
    // Auto-hide keeps last compact preference (independent of pin).
    if (kept.ui.sidebarCollapsed !== true) {
      console.log('FAIL: auto-hide profile should keep sidebarCollapsed', kept.ui);
      app.exit(1);
      return;
    }
    const fixedExpand = migrate({
      version: 1,
      workspaces: [{ id: 'ws-sb', name: 'Sidebar' }],
      activeWorkspaceId: 'ws-sb',
      accounts: [],
      layout: '1',
      page: 0,
      ui: { sidebarCollapsed: true, sidebarAutoHide: false, layoutLocked: true, sidebarWidth: 240 },
      settings: { migrations: { keepAlive120: true }, sidebarAlwaysActive: false },
      appearance: { preset: 'escuro' },
      freeTiles: {},
    });
    if (fixedExpand.ui.sidebarCollapsed !== false || fixedExpand.ui.sidebarAutoHide !== false) {
      console.log('FAIL: fixed+stale-compact must become fixed+expanded', fixedExpand.ui);
      app.exit(1);
      return;
    }
    // Second migrate must not re-clear an intentional compact after flag is set.
    const again = migrate({
      version: 1,
      workspaces: [{ id: 'ws-sb', name: 'Sidebar' }],
      activeWorkspaceId: 'ws-sb',
      accounts: [],
      layout: '1',
      page: 0,
      ui: { sidebarCollapsed: true, sidebarAutoHide: false, layoutLocked: true, sidebarWidth: 240 },
      settings: {
        migrations: { keepAlive120: true, sidebarDualButtons130: true },
        sidebarAlwaysActive: false,
      },
      appearance: { preset: 'escuro' },
      freeTiles: {},
    });
    if (again.ui.sidebarCollapsed !== true) {
      console.log('FAIL: after migration flag, compact preference must stick', again.ui);
      app.exit(1);
      return;
    }
    console.log('PASS: migration dual-button (fixed→expanded once; keep autoHide; flag idempotent)');
  }

  /* ---------- F11: edge-reveal overlay (auto-hide prefs) ---------- */
  // Need auto-hide active for F11 checks — turn legacy off first.
  await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(false)');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.autoHide) {
    console.log('FAIL: expected autoHide after leaving legacy', mode);
    app.exit(1);
    return;
  }
  const prefAutoHideBeforeFs = mode.autoHide;

  chromeFullscreen.enter();
  await sleep(500);
  await waitForLayoutSettle();
  await sleep(400);
  const vis = await rendererEval('window.__multiheizUi.getChromeVisibility()');
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!vis.chromeHidden || !mode.chromeHidden) {
    console.log('FAIL: F11 should hide chrome', { vis, mode });
    app.exit(1);
    return;
  }
  if (
    vis.topbar.display !== 'none' &&
    vis.topbar.offsetHeight !== 0
  ) {
    console.log('FAIL: F11 topbar should be hidden', vis.topbar);
    app.exit(1);
    return;
  }
  if (mode.open || mode.fsPinned || mode.hotzoneHidden) {
    console.log('FAIL: F11 start closed with hotzone visible', mode);
    app.exit(1);
    return;
  }
  if (!mode.appClassAutoHide || !mode.overlayMode) {
    console.log('FAIL: F11 should force overlay mode classes', mode);
    app.exit(1);
    return;
  }
  let fsBounds = panelBounds();
  if (fsBounds.overlayW !== 0) {
    console.log('FAIL: F11 closed overlay width must be 0', fsBounds);
    app.exit(1);
    return;
  }
  const trackingFs = sidebarCursor.getTracking();
  if (!trackingFs || !trackingFs.enabled) {
    console.log('FAIL: F11 cursor tracking must stay enabled', trackingFs);
    app.exit(1);
    return;
  }
  console.log('PASS: F11 starts closed with hotzone + tracking');

  parkCursorAway();
  await sleep(80);
  await rendererEval('window.__multiheizUi.sidebarHotzoneEnter()');
  setCursorContent(5, midY);
  await sleep(80);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.open) {
    console.log('FAIL: F11 should still be closed before show delay', mode);
    app.exit(1);
    return;
  }
  await sleep(120);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open) {
    console.log('FAIL: F11 hotzone should reveal after ~150ms', mode);
    app.exit(1);
    return;
  }
  setCursorContent(80, midY);
  await sleep(80);
  fsBounds = panelBounds();
  if (!(fsBounds.overlayW >= 200) || !near(fsBounds.bounds.x, fsBounds.overlayW, 4)) {
    console.log('FAIL: F11 open should shift panels (overlay)', fsBounds);
    app.exit(1);
    return;
  }
  console.log('PASS: F11 edge reveal + shift-x overlay', fsBounds);

  setCursorContent(Math.max(500, (fsBounds.overlayW || 240) + 200), midY);
  await sleep(500);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open) {
    console.log('FAIL: F11 should still be open before ~700ms hide', mode);
    app.exit(1);
    return;
  }
  await sleep(700);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.open) {
    console.log('FAIL: F11 should hide after leave delay', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: F11 leave hides after ~700ms');

  /* Pin while revealed: stays open with cursor away; prefs unchanged */
  setCursorContent(8, midY);
  await sleep(280);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open) {
    console.log('FAIL: F11 expected open before pin', mode);
    app.exit(1);
    return;
  }
  await rendererEval('window.__multiheizUi.clickSidebarPinButton()');
  await sleep(150);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.fsPinned || !mode.open || mode.autoHide !== prefAutoHideBeforeFs) {
    console.log('FAIL: F11 pin should keep open without changing autoHide pref', mode);
    app.exit(1);
    return;
  }
  parkCursorAway();
  await sleep(900);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open || !mode.fsPinned) {
    console.log('FAIL: F11 pinned must stay open with mouse away', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: F11 pin keeps sidebar open');

  await rendererEval('window.__multiheizUi.clickSidebarPinButton()');
  await sleep(150);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.fsPinned || mode.open) {
    console.log('FAIL: F11 unpin should close overlay', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: F11 unpin closes overlay');

  chromeFullscreen.exit();
  await sleep(400);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.chromeHidden || mode.fsPinned || mode.open) {
    console.log('FAIL: leave F11 should clear chrome-hidden / fs pin', mode);
    app.exit(1);
    return;
  }
  if (mode.autoHide !== prefAutoHideBeforeFs) {
    console.log('FAIL: leave F11 must not alter autoHide pref', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: leave F11 restores auto-hide mode (prefs intact)');

  /* ---------- F11 from fixed mode (no saved autoHide) ---------- */
  await rendererEval('window.__multiheizUi.toggleSidebarAutoHide()');
  await sleep(150);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.autoHide || mode.legacyAlwaysActive) {
    console.log('FAIL: expected fixed before F11-from-fixed', mode);
    app.exit(1);
    return;
  }
  parkCursorAway();
  await sleep(100);
  chromeFullscreen.enter();
  await sleep(500);
  await waitForLayoutSettle();
  await sleep(300);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.chromeHidden || mode.open || mode.hotzoneHidden || !mode.overlayMode) {
    console.log('FAIL: F11 from fixed should edge-reveal (closed + hotzone)', mode);
    app.exit(1);
    return;
  }
  setCursorContent(6, midY);
  await sleep(280);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open || mode.autoHide) {
    console.log('FAIL: F11 from fixed should reveal without flipping autoHide pref', mode);
    app.exit(1);
    return;
  }
  chromeFullscreen.exit();
  await sleep(400);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.chromeHidden || mode.autoHide || mode.open || mode.overlayMode) {
    console.log('FAIL: leave F11 should restore fixed (no overlay)', mode);
    app.exit(1);
    return;
  }
  const fixedAfterFs = panelBounds();
  if (fixedAfterFs.overlayW !== 0 || !(fixedAfterFs.bounds && fixedAfterFs.bounds.x >= 160)) {
    console.log('FAIL: leave F11 fixed should restore panel inset', fixedAfterFs);
    app.exit(1);
    return;
  }
  console.log('PASS: F11 from fixed + restore');

  /* ---------- F11 from legacy (reveal saved compact/expand; restore after) ---------- */
  await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(true)');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.legacyAlwaysActive || mode.autoHide || !mode.collapsed) {
    console.log('FAIL: expected legacy compact before F11-legacy', mode);
    app.exit(1);
    return;
  }
  const legacyCollapsedBeforeFs = true;
  parkCursorAway();
  await sleep(100);
  chromeFullscreen.enter();
  await sleep(500);
  await waitForLayoutSettle();
  await sleep(300);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.chromeHidden || mode.open || mode.hotzoneHidden || !mode.overlayMode) {
    console.log('FAIL: F11 legacy should edge-reveal (closed + hotzone)', mode);
    app.exit(1);
    return;
  }
  setCursorContent(6, midY);
  await sleep(280);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open || !mode.legacyAlwaysActive) {
    console.log('FAIL: F11 legacy reveal must keep legacy pref', mode);
    app.exit(1);
    return;
  }
  // Saved state was compact → overlay should be icon-rail width (~52), not full 240.
  fsBounds = panelBounds();
  if (!(fsBounds.overlayW >= 40 && fsBounds.overlayW <= 70) || !near(fsBounds.bounds.x, fsBounds.overlayW, 4)) {
    console.log('FAIL: F11 legacy compact reveal should shift by ~52px', fsBounds);
    app.exit(1);
    return;
  }
  if (!mode.collapsed) {
    console.log('FAIL: F11 legacy reveal should keep collapsed class', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: F11 legacy reveal in saved compact width', fsBounds);

  chromeFullscreen.exit();
  await sleep(400);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (
    mode.chromeHidden ||
    !mode.legacyAlwaysActive ||
    mode.open ||
    mode.overlayMode ||
    mode.collapsed !== legacyCollapsedBeforeFs
  ) {
    console.log('FAIL: leave F11 should restore legacy compact (saved state)', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: F11 from legacy + restore compact');

  /* ---------- Minimize / restore / close (item 7) ---------- */
  updateState((s) => {
    s.settings = { ...(s.settings || {}), sidebarAlwaysActive: false, confirmOnRemove: false };
    s.ui = {
      ...(s.ui || {}),
      sidebarCollapsed: false,
      sidebarAutoHide: false,
      sidebarWidth: 240,
    };
    s.layout = '2';
    if (!s.layoutByWorkspace) s.layoutByWorkspace = {};
    s.layoutByWorkspace[s.activeWorkspaceId] = '2';
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-sb',
        name: 'Painel SB',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-sb',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
        minimized: false,
      },
      {
        id: 'acc-sb-b',
        name: 'Painel SB B',
        color: '#3d8bfd',
        startUrl: base + '/',
        workspaceId: 'ws-sb',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
        minimized: false,
      },
    ];
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(500);
  await waitForLayoutSettle();
  await waitForPanels(
    (i) =>
      i.panels.some((p) => p.accountId === 'acc-sb' && p.visible && !p.parked) &&
      i.panels.some((p) => p.accountId === 'acc-sb-b' && p.visible && !p.parked)
  );

  const wcBefore = panels.getPanelCapture('acc-sb');
  if (!wcBefore || (typeof wcBefore.isDestroyed === 'function' && wcBefore.isDestroyed())) {
    console.log('FAIL: acc-sb webContents missing before minimize');
    app.exit(1);
    return;
  }
  const wcIdBefore = wcBefore.id;
  const tilesBefore = await rendererEval('window.__multiheizUi.getLayoutTileCount()');
  if (tilesBefore !== 2) {
    console.log('FAIL: expected 2 tiles before minimize, got', tilesBefore);
    app.exit(1);
    return;
  }

  const minRes = await rendererEval('window.__multiheizUi.setAccountMinimized("acc-sb", true)');
  await sleep(400);
  await waitForLayoutSettle();
  const tilesAfterMin = await rendererEval('window.__multiheizUi.getLayoutTileCount()');
  if (tilesAfterMin !== 1) {
    console.log('FAIL: tile count should drop to 1 after minimize', tilesAfterMin, minRes);
    app.exit(1);
    return;
  }
  const wcAfterMin = panels.getPanelCapture('acc-sb');
  if (!wcAfterMin || (typeof wcAfterMin.isDestroyed === 'function' && wcAfterMin.isDestroyed())) {
    console.log('FAIL: minimize destroyed webContents');
    app.exit(1);
    return;
  }
  if (wcAfterMin.id !== wcIdBefore) {
    console.log('FAIL: webContents id changed on minimize', wcIdBefore, wcAfterMin.id);
    app.exit(1);
    return;
  }
  const infoMin = panels.getPanelDebugInfo();
  const pMin = (infoMin.panels || []).find((p) => p.accountId === 'acc-sb');
  if (!pMin || !pMin.parked) {
    console.log('FAIL: minimized panel should be parked', pMin);
    app.exit(1);
    return;
  }
  const flags = await rendererEval('window.__multiheizUi.getSidebarMinimizedFlags()');
  if (!Array.isArray(flags) || !flags.some((f) => f.accountId === 'acc-sb' && f.minimized)) {
    console.log('FAIL: sidebar is-minimized look missing', flags);
    app.exit(1);
    return;
  }
  if (!publicState().accounts.find((a) => a.id === 'acc-sb' && a.minimized)) {
    console.log('FAIL: minimized not persisted in state');
    app.exit(1);
    return;
  }
  console.log('PASS: minimize keeps webContents id, parks, tile count drops');

  await rendererEval('window.__multiheizUi.setAccountMinimized("acc-sb", false)');
  await sleep(400);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-sb' && p.visible && !p.parked));
  const tilesRestored = await rendererEval('window.__multiheizUi.getLayoutTileCount()');
  if (tilesRestored !== 2) {
    console.log('FAIL: restore should bring tile back', tilesRestored);
    app.exit(1);
    return;
  }
  const wcRestored = panels.getPanelCapture('acc-sb');
  if (!wcRestored || wcRestored.id !== wcIdBefore) {
    console.log('FAIL: restore should keep same webContents id', wcIdBefore, wcRestored && wcRestored.id);
    app.exit(1);
    return;
  }
  console.log('PASS: restore brings panel back with same webContents');

  // Persist minimized across flush (phase2-style state check without full restart for this flag)
  await rendererEval('window.__multiheizUi.setAccountMinimized("acc-sb-b", true)');
  await sleep(200);
  flushSave();
  const diskPath = path.join(app.getPath('userData'), 'multiheiz-state.json');
  let diskOk = false;
  try {
    const raw = fs.readFileSync(diskPath, 'utf8');
    const parsed = JSON.parse(raw);
    diskOk = !!(parsed.accounts || []).find((a) => a.id === 'acc-sb-b' && a.minimized);
  } catch (err) {
    console.log('FAIL: read multiheiz-state.json for minimized persist', err && err.message);
    app.exit(1);
    return;
  }
  if (!diskOk) {
    console.log('FAIL: minimized not written to multiheiz-state.json');
    app.exit(1);
    return;
  }
  console.log('PASS: minimized persists to disk');

  await rendererEval('window.__multiheizUi.setAccountMinimized("acc-sb-b", false)');
  await sleep(200);
  const beforeClose = publicState().accounts.length;
  await rendererEval('window.__multiheizUi.clickSidebarClose("acc-sb-b")');
  await sleep(500);
  const afterClose = publicState().accounts.length;
  if (afterClose !== beforeClose - 1 || publicState().accounts.some((a) => a.id === 'acc-sb-b')) {
    console.log('FAIL: close should remove account', { beforeClose, afterClose });
    app.exit(1);
    return;
  }
  if (panels.getPanelCapture('acc-sb-b')) {
    console.log('FAIL: close left webContents alive');
    app.exit(1);
    return;
  }
  console.log('PASS: close removes account and webContents');

  // Leave legacy ON + compact for phase 2 restart persistence.
  updateState((s) => {
    s.accounts = [];
    s.maximizedAccountId = null;
    s.settings = { ...(s.settings || {}), sidebarAlwaysActive: true };
    s.ui = { ...(s.ui || {}), sidebarAutoHide: true, sidebarCollapsed: true };
  });
  flushSave();

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('SELFTEST sidebar phase1 OK — exiting for restart persistence check');
  app.exit(0);
}

/**
 * Phase 2: app restarted with same userdata — legacy option must still be on.
 */
async function runPhase2Persistence(ctx) {
  const { sleep, rendererEval, waitForLayoutSettle, flushSave, publicState, updateState, emitToRenderer } = ctx;
  // Avoid reloading phase-1 localhost URLs (server already gone).
  updateState((s) => {
    s.accounts = [];
    s.maximizedAccountId = null;
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(600);
  await waitForLayoutSettle();
  const st = publicState();
  if (!st.settings || st.settings.sidebarAlwaysActive !== true) {
    console.log('FAIL: phase2 publicState.sidebarAlwaysActive', st.settings);
    app.exit(1);
    return;
  }
  if (!st.ui || st.ui.sidebarAutoHide !== true) {
    console.log('FAIL: phase2 ui.sidebarAutoHide should remain true under legacy', st.ui);
    app.exit(1);
    return;
  }
  const mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.legacyAlwaysActive || mode.autoHide || mode.open || !mode.collapsed) {
    console.log('FAIL: phase2 renderer mode (legacy compact, never auto-hide)', mode);
    app.exit(1);
    return;
  }
  if (mode.toggleTitle !== 'Expandir barra lateral') {
    console.log('FAIL: phase2 legacy compact tooltip', mode.toggleTitle);
    app.exit(1);
    return;
  }
  if (!mode.hotzoneHidden || mode.appClassAutoHide) {
    console.log('FAIL: phase2 hotzone must stay hidden in legacy (never auto-hide)', mode);
    app.exit(1);
    return;
  }
  if (!(mode.sidebarWidth >= 40 && mode.sidebarWidth <= 70)) {
    console.log('FAIL: phase2 compact width ~52px', mode.sidebarWidth);
    app.exit(1);
    return;
  }
  if (!st.ui || st.ui.sidebarCollapsed !== true) {
    console.log('FAIL: phase2 ui.sidebarCollapsed must stay true', st.ui);
    app.exit(1);
    return;
  }
  flushSave();
  console.log('PASS: persistence after restart (legacy compact + sidebarAlwaysActive)');
  console.log('SELFTEST sidebar OK');
  app.exit(0);
}

module.exports = { runSidebarSelftest };
