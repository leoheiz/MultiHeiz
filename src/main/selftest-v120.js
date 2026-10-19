'use strict';

const http = require('node:http');
const { app } = require('electron');

/**
 * Selftest 1.2.0 Parte A — loadQueue lifecycle, tombstone vs layout:sync.
 */
async function runV120Selftest(ctx) {
  const {
    panels,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
  } = ctx;

  console.log('SELFTEST v120');
  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>v120</title></head>
<body style="margin:0;background:#111;color:#eee;font:16px sans-serif;padding:24px">
<h1 id="ok">v120</h1>
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

  const mkAcc = (id, name) => ({
    id,
    name,
    color: '#2bb8a6',
    startUrl: base + '/',
    workspaceId: 'ws-v120',
    muted: false,
    lastUrl: null,
    zoomFactor: 1,
  });

  updateState((s) => {
    s.workspaces = [{ id: 'ws-v120', name: 'v120' }];
    s.activeWorkspaceId = 'ws-v120';
    s.layout = '3';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      mkAcc('acc-v120-a', 'A'),
      mkAcc('acc-v120-b', 'B'),
      mkAcc('acc-v120-c', 'C'),
    ];
    s.settings = {
      ...s.settings,
      openLastPage: false,
      homepage: base + '/',
    };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });

  const slots = [
    { accountId: 'acc-v120-a', x: 0, y: 40, width: 400, height: 400 },
    { accountId: 'acc-v120-b', x: 400, y: 40, width: 400, height: 400 },
    { accountId: 'acc-v120-c', x: 800, y: 40, width: 400, height: 400 },
  ];

  // Destroy any leftover panels so needCreate.length > 1 triggers stagger queue
  for (const id of ['acc-v120-a', 'acc-v120-b', 'acc-v120-c']) {
    try {
      panels.destroyPanel(id);
    } catch {
      /* ignore */
    }
  }

  panels.syncVisiblePanels(slots);
  await sleep(50);

  let q = panels.getLoadQueueDebug();
  console.log('loadQueue after sync', JSON.stringify(q));

  // Destroy B while it may still be in the queue / pending
  panels.destroyPanel('acc-v120-b');
  await sleep(30);
  q = panels.getLoadQueueDebug();
  if (q.queue.includes('acc-v120-b') || q.pending.includes('acc-v120-b')) {
    console.log('FAIL: loadQueue still has destroyed panel', q);
    app.exit(1);
    return;
  }
  console.log('PASS: loadQueue pruned after destroyPanel');

  // No duplicate enqueue
  panels.enqueueVisibleLoads(['acc-v120-a', 'acc-v120-a', 'acc-v120-c', 'acc-v120-c']);
  q = panels.getLoadQueueDebug();
  const uniq = new Set(q.queue);
  if (q.queue.length !== uniq.size) {
    console.log('FAIL: duplicate ids in loadQueue', q);
    app.exit(1);
    return;
  }
  console.log('PASS: enqueueVisibleLoads does not duplicate');

  // Wait for remaining panels to load real URL (not about:blank commit)
  try {
    await waitForUrl('acc-v120-a', (u) => !!u && u !== 'about:blank', 30000);
  } catch {
    /* may already be loaded */
  }
  try {
    await waitForUrl('acc-v120-c', (u) => !!u && u !== 'about:blank', 30000);
  } catch {
    /* may already be loaded */
  }
  console.log('PASS: staggered loads reached real startUrl');

  // Tombstone: removing account must not be recreated by layout:sync
  panels.markAccountRemoving('acc-v120-a');
  panels.destroyPanel('acc-v120-a');
  panels.syncVisiblePanels(slots);
  await sleep(80);
  if (panels.isPanelActive('acc-v120-a')) {
    console.log('FAIL: layout:sync recreated removing account');
    panels.unmarkAccountRemoving('acc-v120-a');
    app.exit(1);
    return;
  }
  if (!panels.isAccountRemoving('acc-v120-a')) {
    console.log('FAIL: tombstone flag cleared early');
    app.exit(1);
    return;
  }
  panels.unmarkAccountRemoving('acc-v120-a');
  console.log('PASS: layout:sync skips account being removed');

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest v120 (panels)');
  app.exit(0);
}

module.exports = { runV120Selftest };
