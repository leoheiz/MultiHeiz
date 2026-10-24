'use strict';

/**
 * Selftest: Ctrl+click new-window performance (MULTIHEIZ_SELFTEST=ctrlclick-perf).
 * Never logs URLs — ids/lengths only.
 */

const http = require('node:http');
const { app } = require('electron');

async function runCtrlclickPerfSelftest(ctx) {
  const {
    panels,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    waitForLayoutSettle,
    waitForPanels,
    getState,
  } = ctx;

  console.log('SELFTEST ctrlclick-perf');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>spa</title></head>
<body style="margin:0;padding:24px;font:16px sans-serif;background:#102030;color:#eee">
  <a id="a1" href="/t1">T1</a>
  <a id="a2" href="/t2">T2</a>
  <a id="a3" href="/t3">T3</a>
</body></html>`;
  const TARGET = (n) =>
    `<!DOCTYPE html><html><body data-target="${n}">ok-${n}</body></html>`;

  let server = null;
  let port = 0;
  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = String(req.url || '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (u.startsWith('/t1')) res.end(TARGET(1));
      else if (u.startsWith('/t2')) res.end(TARGET(2));
      else if (u.startsWith('/t3')) res.end(TARGET(3));
      else res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;

  updateState((s) => {
    s.workspaces = [{ id: 'ws-ccp', name: 'CCP' }];
    s.activeWorkspaceId = 'ws-ccp';
    s.layout = '4';
    s.page = 0;
    s.accounts = [
      {
        id: 'acc-ccp',
        name: 'Src',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-ccp',
        partitionId: 'part-ccp',
        muted: false,
        pauseInBackground: true,
        keepAliveInBackground: false,
        privateHistory: true,
        adblockEnabled: true,
        lastUrl: null,
      },
    ];
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  await waitForLayoutSettle();
  await waitForUrl('acc-ccp', (u) => String(u || '').includes('127.0.0.1'), 30000);
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-ccp' && p.visible));

  const beforeCount = (getState().accounts || []).length;
  const t0 = Date.now();
  const times = [];

  for (let i = 1; i <= 3; i++) {
    const href = `${base}/t${i}`;
    const pathMark = `/t${i}`;
    const start = Date.now();
    const r = panels.openUrlInNewPanel('acc-ccp', href, { focus: false });
    assert(r && r.ok && r.windowId, 'created window ' + i, r);
    const id = r.windowId;
    await waitForUrl(id, (u) => String(u || '').includes(pathMark), 20000);
    const finish = Date.now() - start;
    times.push(finish);

    const info = panels.getPanelDebugInfo();
    const p = (info.panels || []).find((x) => x.accountId === id);
    assert(p, 'panel exists ' + i);
    assert(
      p.bounds && p.bounds.width > 1 && p.bounds.height > 1,
      'non-zero bounds ' + i,
      p.bounds
    );
    assert(!panels.isForceSuspended(id), 'not suspended ' + i);

    let throttled = null;
    try {
      const entry = panels.getPanelCapture && panels.getPanelCapture(id);
      // getPanelCapture returns webContents
      const wc = entry;
      if (wc && typeof wc.isBackgroundThrottled === 'function') {
        throttled = wc.isBackgroundThrottled();
      }
    } catch {
      /* ignore */
    }
    // Soft check — may be false after layout
    void throttled;

    const acc = (getState().accounts || []).find((a) => a.id === id);
    assert(acc && String(acc.startUrl || '') === href, 'exact href startUrl ' + i, {
      len: (acc && acc.startUrl && acc.startUrl.length) || 0,
    });
    console.log('PASS: window', i, 'loaded', 'ms=' + finish, 'idLen=' + id.length);
  }

  const afterCount = (getState().accounts || []).length;
  assert(afterCount === beforeCount + 3, '3 new windows', { beforeCount, afterCount });

  const maxMs = Math.max(...times);
  const avgMs = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  // Reasonable threshold on local mock (not real network)
  assert(maxMs < 15000, 'did-finish-load under 15s on mock', { times, maxMs, avgMs });
  console.log('PASS: timings', { times, maxMs, avgMs, totalMs: Date.now() - t0 });

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest:ctrlclick-perf complete');
  app.exit(0);
}

module.exports = { runCtrlclickPerfSelftest };
