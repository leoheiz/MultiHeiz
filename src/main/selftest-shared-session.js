'use strict';

const http = require('node:http');
const { app, session } = require('electron');
const { envGet } = require('./config');
const partition = require('./partition');

/**
 * Selftest: sessões compartilhadas (D1–D5).
 * MULTIHEIZ_SELFTEST=shared-session
 */
async function runSharedSessionSelftest(ctx) {
  const {
    panels,
    getState,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    waitForPanels,
  } = ctx;

  console.log('SELFTEST shared-session');

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  function fail(msg, detail) {
    console.log('FAIL:', msg, detail != null ? detail : '');
    app.exit(1);
  }

  function assert(cond, msg, detail) {
    if (!cond) fail(msg, detail);
  }

  let server = null;
  let port = 0;
  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = String(req.url || '');
      if (url.startsWith('/set')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': 'mhshare=shared-ok; Path=/',
        });
        res.end('<!DOCTYPE html><html><body>set</body></html>');
        return;
      }
      if (url.startsWith('/read')) {
        const raw = String(req.headers.cookie || '');
        const m = /(?:^|;\s*)mhshare=([^;]*)/.exec(raw);
        const val = m ? decodeURIComponent(m[1]) : '';
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ mhshare: val, cookies: raw }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body>ok</body></html>');
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;

  async function showSlots(accountIds) {
    const bw = 1200;
    const bh = 800;
    const n = accountIds.length || 1;
    const w = Math.floor(bw / n);
    const slots = accountIds.map((accountId, i) => ({
      accountId,
      x: i * w,
      y: 80,
      width: w,
      height: bh - 80,
    }));
    panels.syncVisiblePanels(slots);
    await sleep(400);
  }

  async function readShareCookie(accountId) {
    const wc = panels.getPanelCapture(accountId);
    assert(wc, 'panel webContents', accountId);
    await wc.loadURL(base + '/read');
    await waitForUrl(accountId, (u) => u.includes('/read'), 20000);
    await sleep(200);
    const text = await wc.executeJavaScript('document.body.innerText');
    return JSON.parse(text);
  }

  async function setShareCookie(accountId) {
    const wc = panels.getPanelCapture(accountId);
    assert(wc, 'panel for set', accountId);
    await wc.loadURL(base + '/set');
    await waitForUrl(accountId, (u) => u.includes('/set'), 20000);
    await sleep(200);
  }

  async function partitionHasCookie(partitionId) {
    const ses = session.fromPartition(partition.partitionString(partitionId));
    const list = await ses.cookies.get({ url: base, name: 'mhshare' });
    return list && list.length > 0 && list.some((c) => c.value === 'shared-ok');
  }

  /* ---- Migration: old-format state already seeded by tools runner ---- */
  {
    const st = getState();
    const accMig = (st.accounts || []).find((a) => a.id === 'acc-mig-a');
    if (accMig) {
      assert(accMig.partitionId === 'acc-mig-a', 'migration partitionId unchanged', accMig.partitionId);
      assert(accMig.name === 'Mig A', 'migration name', accMig.name);
      assert(accMig.startUrl && accMig.startUrl.includes('example.invalid'), 'migration startUrl');
      const ws = (st.workspaces || []).find((w) => w.id === 'ws-mig');
      assert(ws, 'migration workspace');
      assert(
        partition.normalizeWorkspaceSessionType(ws.sessionType) === 'independent',
        'migration sessionType default independent',
        ws.sessionType
      );
      console.log('PASS: migration old-format state leaves panels unchanged');
    } else {
      console.log('INFO: no seeded migration account (skip assert)');
    }
  }

  /* ---- Fresh setup for cookie / share tests ---- */
  updateState((s) => {
    s.workspaces = [
      {
        id: 'ws-ind',
        name: 'Independente',
        sessionType: 'independent',
        sharedPartitionId: null,
      },
      {
        id: 'ws-conv-new',
        name: 'Conv Novo',
        sessionType: 'conventional',
        sharedPartitionId: 'sess-conv-new',
      },
    ];
    s.activeWorkspaceId = 'ws-ind';
    s.layout = '2';
    if (!s.layoutByWorkspace) s.layoutByWorkspace = {};
    s.layoutByWorkspace['ws-ind'] = '2';
    s.layoutByWorkspace['ws-conv-new'] = '2';
    s.accounts = [
      {
        id: 'acc-share-a',
        name: 'Origem',
        color: '#3d8bfd',
        startUrl: base + '/',
        workspaceId: 'ws-ind',
        partitionId: 'acc-share-a',
        muted: false,
        volume: 100,
        pauseInBackground: false,
        keepAliveInBackground: false,
        privateHistory: false,
        adblockEnabled: true,
        showUnread: true,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
    s.page = 0;
    s.maximizedAccountId = null;
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });

  await showSlots(['acc-share-a']);
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-share-a'));
  await waitForUrl('acc-share-a', (u) => !!u && u !== 'about:blank', 30000);

  await setShareCookie('acc-share-a');
  const cookieA = await readShareCookie('acc-share-a');
  assert(cookieA.mhshare === 'shared-ok', 'cookie set on original', cookieA);

  /* D1: open same session */
  const opened = ctx.openAccountWithSameSession
    ? ctx.openAccountWithSameSession('acc-share-a')
    : null;
  assert(opened && opened.ok, 'open same session ok', opened && opened.error);
  const dupId = opened.account && opened.account.id;
  assert(dupId, 'duplicate account id');
  assert(
    opened.account.partitionId === 'acc-share-a',
    'duplicate shares partitionId',
    opened.account.partitionId
  );
  assert(
    opened.account.workspaceId === 'ws-ind',
    'duplicate same workspace',
    opened.account.workspaceId
  );

  const pub = publicState();
  const shareA = (pub.accounts || []).find((a) => a.id === 'acc-share-a');
  const shareDup = (pub.accounts || []).find((a) => a.id === dupId);
  assert(shareA && shareA.sessionShareCount === 2, 'indicator count 2 on original', shareA);
  assert(shareDup && shareDup.sessionShareCount === 2, 'indicator count 2 on dup', shareDup);
  console.log('PASS: indicator sessionShareCount=2');

  await showSlots(['acc-share-a', dupId]);
  await waitForPanels(
    (i) =>
      i.panels.some((p) => p.accountId === 'acc-share-a') &&
      i.panels.some((p) => p.accountId === dupId)
  );
  await waitForUrl(dupId, (u) => !!u && u !== 'about:blank', 30000);

  const cookieDup = await readShareCookie(dupId);
  assert(cookieDup.mhshare === 'shared-ok', 'duplicate sees cookie', cookieDup);
  console.log('PASS: duplicate panel sees cookie from original');

  /* Delete duplicate → original keeps cookie + partition intact */
  await ctx.removeAccountById(dupId);
  assert(
    await partitionHasCookie('acc-share-a'),
    'partition data intact after deleting duplicate'
  );
  await showSlots(['acc-share-a']);
  const cookieAfterDup = await readShareCookie('acc-share-a');
  assert(cookieAfterDup.mhshare === 'shared-ok', 'original still has cookie', cookieAfterDup);
  const pub2 = publicState();
  const shareA2 = (pub2.accounts || []).find((a) => a.id === 'acc-share-a');
  assert(shareA2 && shareA2.sessionShareCount === 1, 'indicator back to 1', shareA2);
  console.log('PASS: delete duplicate keeps partition + cookie');

  /* Separate mode isolation */
  updateState((s) => {
    s.accounts.push({
      id: 'acc-iso-b',
      name: 'Isolada',
      color: '#e83e8c',
      startUrl: base + '/',
      workspaceId: 'ws-ind',
      partitionId: 'acc-iso-b',
      muted: false,
      volume: 100,
      pauseInBackground: false,
      keepAliveInBackground: false,
      privateHistory: false,
      adblockEnabled: true,
      showUnread: true,
      lastUrl: null,
      zoomFactor: 1,
    });
  });
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await showSlots(['acc-share-a', 'acc-iso-b']);
  await waitForUrl('acc-iso-b', (u) => !!u && u !== 'about:blank', 30000);
  const cookieIso = await readShareCookie('acc-iso-b');
  assert(cookieIso.mhshare === '', 'independent panel isolated', cookieIso);
  console.log('PASS: Sessão independente keeps isolated cookies');

  /* Conventional workspace: new empty session */
  updateState((s) => {
    s.accounts.push({
      id: 'acc-conv-1',
      name: 'Conv1',
      color: '#20c997',
      startUrl: base + '/',
      workspaceId: 'ws-conv-new',
      partitionId: 'sess-conv-new',
      muted: false,
      volume: 100,
      pauseInBackground: false,
      keepAliveInBackground: false,
      privateHistory: false,
      adblockEnabled: true,
      showUnread: true,
      lastUrl: null,
      zoomFactor: 1,
    });
    s.activeWorkspaceId = 'ws-conv-new';
    s.layout = '2';
  });
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await showSlots(['acc-conv-1']);
  await waitForUrl('acc-conv-1', (u) => !!u && u !== 'about:blank', 30000);
  await setShareCookie('acc-conv-1');

  // New panel via account:create path (simulate conventional default)
  const created = await ctx.createAccountForSelftest({
    name: 'Conv2',
    startUrl: base + '/',
    workspaceId: 'ws-conv-new',
  });
  assert(created && created.account, 'create in conventional');
  assert(
    created.account.partitionId === 'sess-conv-new',
    'new panel gets base shared partition',
    created.account.partitionId
  );
  const conv2 = created.account.id;
  await showSlots(['acc-conv-1', conv2]);
  await waitForUrl(conv2, (u) => !!u && u !== 'about:blank', 30000);
  const cookieConv2 = await readShareCookie(conv2);
  assert(cookieConv2.mhshare === 'shared-ok', 'conventional new session shared cookie', cookieConv2);
  console.log('PASS: Navegador convencional (nova sessão) shares partition + cookie');

  /* Conventional imported from panel */
  const importRes = await ctx.updateWorkspaceForSelftest({
    id: 'ws-ind',
    sessionType: 'conventional',
    sharedFrom: 'acc-share-a',
  });
  assert(importRes && importRes.ok, 'switch ws-ind to conventional', importRes);
  const stImp = getState();
  const wsInd = stImp.workspaces.find((w) => w.id === 'ws-ind');
  assert(
    wsInd.sessionType === 'conventional',
    'ws-ind sessionType conventional',
    wsInd.sessionType
  );
  assert(
    wsInd.sharedPartitionId === 'acc-share-a',
    'imported sharedPartitionId',
    wsInd.sharedPartitionId
  );
  const accA = stImp.accounts.find((a) => a.id === 'acc-share-a');
  const accIso = stImp.accounts.find((a) => a.id === 'acc-iso-b');
  assert(accA.partitionId === 'acc-share-a', 'origin partition');
  assert(accIso.partitionId === 'acc-share-a', 'iso switched to shared', accIso.partitionId);
  console.log('PASS: type change to Navegador convencional imports panel session');

  await showSlots(['acc-share-a', 'acc-iso-b']);
  await sleep(600);
  // After rebind, need load
  try {
    await waitForUrl('acc-iso-b', (u) => !!u, 15000);
  } catch {
    /* may be blank until navigate */
  }
  const wcIso = panels.getPanelCapture('acc-iso-b');
  if (wcIso) {
    await wcIso.loadURL(base + '/read');
    await waitForUrl('acc-iso-b', (u) => u.includes('/read'), 20000);
    await sleep(200);
    const text = await wcIso.executeJavaScript('document.body.innerText');
    const j = JSON.parse(text);
    assert(j.mhshare === 'shared-ok', 'imported session cookie visible on switched panel', j);
  }
  console.log('PASS: imported conventional session cookie visible');

  /* Switch back to independent: existing keep partitions; new get own */
  const back = await ctx.updateWorkspaceForSelftest({
    id: 'ws-ind',
    sessionType: 'independent',
  });
  assert(back && back.ok, 'switch back independent');
  const stBack = getState();
  const wsBack = stBack.workspaces.find((w) => w.id === 'ws-ind');
  assert(wsBack.sessionType === 'independent', 'back to independent');
  const stillShared = stBack.accounts.find((a) => a.id === 'acc-iso-b');
  assert(
    stillShared.partitionId === 'acc-share-a',
    'existing panels keep partition after switch back',
    stillShared.partitionId
  );
  const newInd = await ctx.createAccountForSelftest({
    name: 'NovaInd',
    startUrl: base + '/',
    workspaceId: 'ws-ind',
  });
  assert(
    newInd.account.partitionId === newInd.account.id,
    'new panel in independent gets own partition',
    newInd.account.partitionId
  );
  console.log('PASS: switch back to Sessão independente');

  /* Delete last user of a unique partition → cleared */
  updateState((s) => {
    s.accounts = s.accounts.filter((a) => a.id !== 'acc-iso-b' && a.id !== newInd.account.id);
    // keep acc-share-a alone on its partition for last-user clear test
    for (const a of s.accounts) {
      if (a.id === 'acc-share-a') a.partitionId = 'acc-share-a';
    }
  });
  // Ensure cookie still there then remove last user
  assert(await partitionHasCookie('acc-share-a'), 'cookie before last delete');
  await ctx.removeAccountById('acc-share-a');
  assert(
    !(await partitionHasCookie('acc-share-a')),
    'partition cleared when last user deleted'
  );
  console.log('PASS: last user delete clears partition');

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest shared-session complete');
  app.exit(0);
}

module.exports = { runSharedSessionSelftest };
