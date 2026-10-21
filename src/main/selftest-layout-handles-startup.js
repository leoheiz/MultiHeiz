'use strict';

/**
 * Selftest: alças de redimensionar ativas no modo livre desde a inicialização
 * (MULTIHEIZ_SELFTEST=layout-handles-startup).
 *
 * USERDATA pré-semeado: layout livre destravado + 2 painéis.
 * SEM trocar de área: arrasta uma alça (real OS mouse no Windows via handshake;
 * fora do Windows: caminho sintético + SKIP da parte real-input).
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, screen } = require('electron');
const { envGet } = require('./config');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function handshakeDir() {
  const d = envGet('MULTIHEIZ_REALCLICK_DIR');
  if (!d) return null;
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

async function waitForFile(filePath, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        /* retry */
      }
    }
    await sleep(50);
  }
  throw new Error('timeout waiting for ' + filePath);
}

/**
 * @param {object} ctx
 */
async function runLayoutHandlesStartupSelftest(ctx) {
  const {
    mainWindow,
    panels,
    getState,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep: ctxSleep,
    waitForUrl,
    rendererEval,
    waitForLayoutSettle,
  } = ctx;

  console.log('SELFTEST layout-handles-startup');

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  function assert(cond, msg, detail) {
    if (!cond) {
      console.log('FAIL:', msg, detail != null ? detail : '');
      throw new Error(msg + (detail != null ? ': ' + JSON.stringify(detail) : ''));
    }
  }

  const isWin = process.platform === 'win32';
  const dir = handshakeDir();
  const useRealInput = isWin && !!dir;

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><body style="margin:0;background:#1a3040;color:#eee;padding:20px;font:16px sans-serif">handles</body></html>`;
  await new Promise((resolve, reject) => {
    server = http.createServer((_req, res) => {
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

  // Keep pre-seeded livre/unlocked; just point accounts at the mock.
  updateState((s) => {
    s.layout = 'livre';
    if (!s.layoutByWorkspace) s.layoutByWorkspace = {};
    s.layoutByWorkspace[s.activeWorkspaceId || 'ws-default'] = 'livre';
    if (!s.ui) s.ui = {};
    s.ui.layoutLocked = false;
    const ids = ['acc-h1', 'acc-h2'];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      let acc = (s.accounts || []).find((a) => a.id === id);
      if (!acc) {
        if (!Array.isArray(s.accounts)) s.accounts = [];
        acc = {
          id,
          name: 'H' + (i + 1),
          color: i === 0 ? '#2bb8a6' : '#3d8bfd',
          startUrl: base + '/',
          workspaceId: s.activeWorkspaceId || 'ws-default',
          muted: false,
          lastUrl: null,
        };
        s.accounts.push(acc);
      } else {
        acc.startUrl = base + '/';
        acc.workspaceId = s.activeWorkspaceId || 'ws-default';
      }
    }
    if (!s.freeTiles) s.freeTiles = {};
    const ws = s.activeWorkspaceId || 'ws-default';
    // Leave room to the right and below acc-h1 so SE drag can grow without overlap.
    s.freeTiles[ws] = {
      'acc-h1': { c: 0, r: 0, w: 4, h: 4 },
      'acc-h2': { c: 8, r: 0, w: 4, h: 4 },
    };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await ctxSleep(500);

  const WIN_X = 100;
  const WIN_Y = 80;
  const WIN_W = 1400;
  const WIN_H = 900;
  try {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    if (mainWindow.isMinimized()) mainWindow.restore();
  } catch {
    /* ignore */
  }
  try {
    mainWindow.setBounds({ x: WIN_X, y: WIN_Y, width: WIN_W, height: WIN_H });
  } catch {
    mainWindow.setSize(WIN_W, WIN_H);
    mainWindow.setPosition(WIN_X, WIN_Y);
  }
  mainWindow.show();
  mainWindow.focus();
  try {
    mainWindow.moveTop();
  } catch {
    /* ignore */
  }
  await ctxSleep(400);
  await waitForLayoutSettle();

  // Do NOT switch workspace — assert handles on the initial area.
  const chrome = await rendererEval('window.__multiheizUi.syncLivreEditChrome()');
  assert(chrome && chrome.livreEdit === true, 'livre edit mode on startup', chrome);
  assert(chrome && chrome.handles >= 3, 'resize handles present on startup', chrome);

  const hit = await rendererEval(`(function(){
    const info = window.__multiheizUi.getHandleHitPoints();
    const slot = document.querySelector('.panel-slot[data-account-id="acc-h1"]');
    const node = slot && slot.querySelector('.resize-handle.se');
    let se = null;
    if (node) {
      const r = node.getBoundingClientRect();
      // Outer corner (away from WebContentsView) so real OS mouse hits the HTML handle.
      se = {
        accountId: 'acc-h1',
        role: 'se',
        x: r.right - 2,
        y: r.bottom - 2,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      };
    }
    return {
      livreEdit: info.livreEdit,
      se,
      handleInset: info.handleInset,
      count: (info.points || []).length,
      elementFromPoint: se
        ? (document.elementFromPoint(se.x, se.y) &&
            (document.elementFromPoint(se.x, se.y).className ||
              document.elementFromPoint(se.x, se.y).tagName))
        : null,
    };
  })()`);
  assert(hit && hit.livreEdit, 'livreEdit from hit points', hit);
  assert(hit && hit.se, 'SE handle hit point for acc-h1', hit);
  console.log('PASS: handles present without workspace switch', {
    handles: chrome.handles,
    se: hit.se,
    elementFromPoint: hit.elementFromPoint,
  });

  function tileOf(id) {
    const st = getState();
    const ws = st.activeWorkspaceId;
    return st.freeTiles && st.freeTiles[ws] && st.freeTiles[ws][id];
  }

  const before = tileOf('acc-h1');
  assert(before && before.w === 4 && before.h === 4, 'initial tile', before);

  async function boundsOf(id) {
    const info = panels.getPanelDebugInfo();
    const p = (info.panels || []).find((x) => x.accountId === id);
    return p ? p.bounds : null;
  }
  const boundsBefore = await boundsOf('acc-h1');

  if (useRealInput) {
    const readyPath = path.join(dir, 'ready.json');
    const donePath = path.join(dir, 'done.json');
    try {
      fs.unlinkSync(donePath);
    } catch {
      /* ignore */
    }

    const contentBounds = mainWindow.getContentBounds();
    const display = screen.getDisplayMatching(contentBounds);
    const scale = Number(display.scaleFactor) || 1;
    const cx = hit.se.x;
    const cy = hit.se.y;
    const physX = Math.round((contentBounds.x + cx) * scale);
    const physY = Math.round((contentBounds.y + cy) * scale);
    // Drag SE handle down-right enough to grow tile by ≥1 col/row.
    const deltaPhys = { x: Math.round(120 * scale), y: Math.round(100 * scale) };

    writeJson(readyPath, {
      token: 'layout-handles-' + Date.now(),
      action: 'Drag',
      physical: { x: physX, y: physY },
      deltaPhys,
      steps: 10,
      contentBounds,
      scaleFactor: scale,
      client: { x: cx, y: cy },
    });
    console.log('ready.json written; waiting for real drag…', { physX, physY, deltaPhys });

    await waitForFile(donePath, 60000);
    await ctxSleep(500);
    await waitForLayoutSettle();

    const after = tileOf('acc-h1');
    const boundsAfter = await boundsOf('acc-h1');
    assert(after, 'tile after real drag', after);
    const grew =
      (after.w || 0) > (before.w || 0) ||
      (after.h || 0) > (before.h || 0) ||
      (boundsAfter &&
        boundsBefore &&
        (boundsAfter.width > boundsBefore.width + 8 ||
          boundsAfter.height > boundsBefore.height + 8));
    assert(grew, 'panel grew after real SE drag', { before, after, boundsBefore, boundsAfter });
    console.log('PASS: real-input SE drag resized panel', { before, after });
  } else {
    console.log('SKIP: real-input drag (non-Windows or no MULTIHEIZ_REALCLICK_DIR)');
    // Synthetic path: dispatch pointer events on the handle (same listeners).
    const syn = await rendererEval(`(async () => {
      const slot = document.querySelector('.panel-slot[data-account-id="acc-h1"]');
      const h = slot && slot.querySelector('.resize-handle.se');
      if (!h) return { ok: false, reason: 'no-handle' };
      const r = h.getBoundingClientRect();
      const sx = r.left + r.width / 2;
      const sy = r.top + r.height / 2;
      const fire = (type, x, y, buttons) => {
        const ev = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerId: 1,
          pointerType: 'mouse',
          buttons,
        });
        (type === 'pointerdown' ? h : window).dispatchEvent(ev);
        const mev = new MouseEvent(type.replace('pointer', 'mouse'), {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          buttons,
        });
        (type === 'pointerdown' ? h : window).dispatchEvent(mev);
      };
      fire('pointerdown', sx, sy, 1);
      for (let i = 1; i <= 8; i++) {
        fire('pointermove', sx + i * 18, sy + i * 14, 1);
        await new Promise((r) => requestAnimationFrame(r));
      }
      fire('pointerup', sx + 144, sy + 112, 0);
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true };
    })()`);
    assert(syn && syn.ok, 'synthetic drag', syn);
    await ctxSleep(400);
    await waitForLayoutSettle();
    const after = tileOf('acc-h1');
    assert(
      after && ((after.w || 0) > (before.w || 0) || (after.h || 0) > (before.h || 0)),
      'synthetic drag grew tile',
      { before, after }
    );
    console.log('PASS: synthetic SE drag resized panel', { before, after });
  }

  // Still works after changing the layout (and back to livre unlocked).
  await rendererEval(`(async () => {
    const apply = (st) => {
      if (!st) return;
      if (window.__mhV16Hooks && window.__mhV16Hooks.applyState) window.__mhV16Hooks.applyState(st);
    };
    apply(await window.multiheiz.setLayout('2'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    apply(await window.multiheiz.setLayout('livre'));
    apply(await window.multiheiz.updateUi({ layoutLocked: false }));
    window.__multiheizUi.syncLivreEditChrome();
  })()`);
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await ctxSleep(400);
  await waitForLayoutSettle();

  const afterLayout = await rendererEval('window.__multiheizUi.syncLivreEditChrome()');
  assert(afterLayout && afterLayout.livreEdit && afterLayout.handles >= 3, 'handles after layout change', afterLayout);

  const mid = tileOf('acc-h1');
  const syn2 = await rendererEval(`(async () => {
    const slot = document.querySelector('.panel-slot[data-account-id="acc-h1"]');
    const h = slot && slot.querySelector('.resize-handle.e');
    if (!h) return { ok: false, reason: 'no-e' };
    const r = h.getBoundingClientRect();
    const sx = r.left + r.width / 2;
    const sy = r.top + r.height / 2;
    const fire = (type, x, y, buttons) => {
      const target = type === 'pointerdown' || type === 'mousedown' ? h : window;
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', buttons,
      }));
      target.dispatchEvent(new MouseEvent(type.replace('pointer', 'mouse'), {
        bubbles: true, cancelable: true, clientX: x, clientY: y, buttons,
      }));
    };
    fire('pointerdown', sx, sy, 1);
    for (let i = 1; i <= 6; i++) {
      fire('pointermove', sx + i * 20, sy, 1);
      await new Promise((r) => requestAnimationFrame(r));
    }
    fire('pointerup', sx + 120, sy, 0);
    await new Promise((r) => setTimeout(r, 200));
    return { ok: true };
  })()`);
  assert(syn2 && syn2.ok, 'post-layout synthetic drag', syn2);
  await ctxSleep(400);
  const after2 = tileOf('acc-h1');
  assert(
    after2 && ((after2.w || 0) !== (mid.w || 0) || (after2.h || 0) !== (mid.h || 0)),
    'resize still works after layout change',
    { mid, after2 }
  );
  console.log('PASS: handles still work after layout change', { mid, after2 });

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest layout-handles-startup');
  app.exit(0);
}

module.exports = { runLayoutHandlesStartupSelftest };
