'use strict';

/**
 * In-process Certisign client-certificate diagnostic (MULTIHEIZ_SELFTEST=diag-certisign).
 * Opens the public test page, follows a "testar"/test link if present, waits ~20s,
 * logs select-client-certificate / picker state. Never selects a cert — cancels picker.
 *
 * Note: Electron only fires select-client-certificate when the server requests a
 * client cert AND Chromium has candidate certificates with private keys.
 */

const certificates = require('./certificates');

const START_URL =
  'https://suporte.certisign.com.br/duvidas-suporte/certificado-digital/teste-certificado/';

/**
 * @param {object} ctx
 */
async function runDiagCertisign(ctx) {
  const {
    panels,
    updateState,
    flushSave,
    emitToRenderer,
    sleep,
    waitForUrl,
    waitForLayoutSettle,
    waitForPanels,
    rendererEval,
    publicState,
    app,
  } = ctx;

  console.log('DIAG certisign');
  console.log(
    'NOTE: Electron fires select-client-certificate only when the server requests a cert and Chromium has candidates.'
  );

  const summary = {
    selectClientCertificateFired: false,
    certsOffered: 0,
    pickerOpened: false,
    pickerCancelled: false,
    startUrl: START_URL,
    navigatedTestUrl: null,
    finalUrl: null,
    httpStatusHint: null,
    notes: [],
  };

  certificates.setSelftestClientCertHook((info) => {
    summary.selectClientCertificateFired = true;
    summary.certsOffered = (info.list && info.list.length) || (info.certificates && info.certificates.length) || 0;
    console.log('DIAG: select-client-certificate fired, certs=', summary.certsOffered);
    // Return nothing → fall through to in-app picker (hook is set so SELFTEST auto-cancel is skipped)
    return undefined;
  });

  updateState((s) => {
    s.workspaces = [{ id: 'ws-diag', name: 'Diag' }];
    s.activeWorkspaceId = 'ws-diag';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.clientCertChoices = {};
    s.settings = { ...(s.settings || {}), openLastPage: false, homepage: START_URL };
    s.ui = {
      ...(s.ui || {}),
      sidebarCollapsed: false,
      sidebarAutoHide: false,
      layoutLocked: true,
      sidebarWidth: 240,
    };
    s.accounts = [
      {
        id: 'acc-diag-cert',
        name: 'Diag Cert',
        color: '#2bb8a6',
        startUrl: START_URL,
        workspaceId: 'ws-diag',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(1000);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-diag-cert'));

  const wc = panels.getPanelCapture('acc-diag-cert');
  if (!wc) {
    console.log('FAIL: no panel webContents');
    app.exit(1);
    return;
  }

  try {
    await waitForUrl('acc-diag-cert', (u) => /certisign/i.test(u) || u.startsWith('https:'), 45000);
  } catch (err) {
    summary.notes.push('start URL wait: ' + (err && err.message));
    console.log('WARN: start URL wait', err && err.message);
  }
  await sleep(2000);

  // Find a "testar"/test link that may trigger client-cert
  const linkInfo = await wc.executeJavaScript(
    `(() => {
      const links = [...document.querySelectorAll('a[href]')];
      const scored = links.map((a) => {
        const text = ((a.textContent || '') + ' ' + (a.getAttribute('aria-label') || '')).toLowerCase();
        const href = a.href || '';
        let score = 0;
        if (/testar|teste|testar certificado|test certificate|validar/.test(text)) score += 3;
        if (/testar|teste|certificado|client/.test(href.toLowerCase())) score += 2;
        if (/https?:/.test(href)) score += 1;
        return { href, text: (a.textContent || '').trim().slice(0, 80), score };
      }).filter((x) => x.score >= 3 && /^https?:/i.test(x.href));
      scored.sort((a, b) => b.score - a.score);
      return { count: links.length, best: scored[0] || null, top: scored.slice(0, 5) };
    })()`,
    true
  );
  console.log('DIAG: link scan', JSON.stringify(linkInfo));

  if (linkInfo && linkInfo.best && linkInfo.best.href) {
    summary.navigatedTestUrl = linkInfo.best.href;
    console.log('DIAG: navigating to test link', linkInfo.best.href);
    try {
      await wc.loadURL(linkInfo.best.href);
    } catch (err) {
      summary.notes.push('load test link: ' + (err && err.message));
    }
  } else {
    summary.notes.push('no obvious testar/test link found; staying on start URL');
  }

  // Wait ~20s for cert challenge; cancel picker if it opens
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const peek = certificates.selftestPeekClientPick('acc-diag-cert') || certificates.selftestPeekClientPick();
    if (peek && peek.requestId) {
      summary.pickerOpened = true;
      summary.certsOffered = Math.max(summary.certsOffered, (peek.list && peek.list.length) || 0);
      console.log('DIAG: picker opened requestId=', peek.requestId, 'certs=', summary.certsOffered);
      // Assert dialog visible in renderer if possible
      try {
        const ui = await rendererEval(
          `!!(document.getElementById('dlg-client-cert') && document.getElementById('dlg-client-cert').open)`
        );
        console.log('DIAG: dlg-client-cert.open=', ui);
      } catch {
        /* ignore */
      }
      certificates.respondClientPick(peek.requestId, 'cancel', null, false);
      summary.pickerCancelled = true;
      console.log('DIAG: picker cancelled programmatically (never selected a cert)');
      break;
    }
    await sleep(250);
  }

  try {
    summary.finalUrl = wc.getURL();
  } catch {
    summary.finalUrl = null;
  }

  // Soft HTTP status hint via executeJavaScript performance/navigation if available
  try {
    summary.httpStatusHint = await wc.executeJavaScript(
      `(() => {
        try {
          const nav = performance.getEntriesByType('navigation')[0];
          return nav ? { type: nav.type, responseStatus: nav.responseStatus || null } : null;
        } catch (e) { return { error: String(e) }; }
      })()`,
      true
    );
  } catch {
    summary.httpStatusHint = null;
  }

  if (summary.selectClientCertificateFired && summary.certsOffered > 0 && !summary.pickerOpened) {
    console.log('DIAG FAIL: event fired with certs but picker did not open — needs fix');
    summary.notes.push('BUG: certs offered but picker never opened');
    // Attempt synthetic emit to verify UI path
    try {
      await certificates.selftestEmitClientCertPicker(wc, summary.finalUrl || START_URL, [
        { subjectName: 'Diag Fake', issuerName: 'Diag', fingerprint: 'DIAGFP1' },
      ]);
      const peek2 = certificates.selftestPeekClientPick();
      if (peek2) {
        summary.notes.push('synthetic picker did open — real event path may have skipped emit');
        certificates.respondClientPick(peek2.requestId, 'cancel', null, false);
      }
    } catch (err) {
      summary.notes.push('synthetic emit failed: ' + (err && err.message));
    }
  }

  console.log('DIAG SUMMARY ' + JSON.stringify(summary, null, 2));
  certificates.setSelftestClientCertHook(null);

  // Exit 0 even when server did not request a cert (diagnostic, not a pass/fail product test)
  if (summary.selectClientCertificateFired && summary.certsOffered > 0 && !summary.pickerOpened) {
    app.exit(1);
    return;
  }
  console.log('PASS: diag certisign complete');
  app.exit(0);
}

module.exports = { runDiagCertisign };
