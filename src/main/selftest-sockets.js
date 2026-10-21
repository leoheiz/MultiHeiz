'use strict';

/**
 * Selftest: coordena cenários de sockets TCP/UDP (MULTIHEIZ_SELFTEST=sockets).
 * O orquestrador tools/check-sockets.js lê fases em MULTIHEIZ_SOCKETS_CONTROL
 * e enumera sockets do process tree.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const IDLE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>idle-ok</title></head>
<body><p>idle mock</p></body></html>`;

const WEBRTC_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>webrtc-pending</title></head>
<body><p>webrtc mock (X-like)</p>
<script>
(async () => {
  try {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:127.0.0.1:1' }],
    });
    window.__mhPc = pc;
    pc.createDataChannel('x');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') resolve();
      };
      setTimeout(resolve, 8000);
    });
    document.title = 'webrtc-done';
    document.body.dataset.ice = pc.iceGatheringState;
  } catch (e) {
    document.title = 'webrtc-err';
    document.body.dataset.err = String(e && e.message ? e.message : e);
  }
})();
</script>
</body></html>`;

const GUM_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>gum-pending</title></head>
<body><p>getUserMedia mock</p>
<script>
(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    window.__mhStream = stream;
    document.title = 'gum-done';
  } catch (e) {
    document.title = 'gum-err';
    document.body.dataset.err = String(e && e.message ? e.message : e);
  }
})();
</script>
</body></html>`;

/**
 * @param {object} ctx
 */
async function runSocketsSelftest(ctx) {
  const {
    panels,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    app,
    permissions,
  } = ctx;

  console.log('SELFTEST sockets');

  const controlDir = process.env.MULTIHEIZ_SOCKETS_CONTROL || '';
  if (!controlDir) {
    throw new Error('MULTIHEIZ_SOCKETS_CONTROL required');
  }
  fs.mkdirSync(controlDir, { recursive: true });

  function writePhase(phase, extra) {
    const payload = {
      phase,
      pid: process.pid,
      at: Date.now(),
      ...(extra || {}),
    };
    fs.writeFileSync(path.join(controlDir, 'phase.json'), JSON.stringify(payload, null, 2));
    console.log('SOCKETS_PHASE', phase, JSON.stringify(extra || {}));
  }

  async function waitAck(phase, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 120000);
    const ackPath = path.join(controlDir, 'ack');
    while (Date.now() < deadline) {
      try {
        if (fs.existsSync(ackPath) && fs.readFileSync(ackPath, 'utf8').trim() === phase) {
          return;
        }
      } catch {
        /* ignore */
      }
      await sleep(200);
    }
    throw new Error('ack timeout for phase ' + phase);
  }

  let server = null;
  let port = 0;
  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = String(req.url || '/');
      let body = IDLE_HTML;
      if (u.startsWith('/webrtc')) body = WEBRTC_HTML;
      else if (u.startsWith('/gum')) body = GUM_HTML;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });

  const idleUrl = `http://127.0.0.1:${port}/idle`;
  const webrtcUrl = `http://127.0.0.1:${port}/webrtc`;
  const gumUrl = `http://127.0.0.1:${port}/gum`;

  // Scenario (d) modules: adblock + LT + AI flags on (AI sem chave — só carrega módulo).
  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Sockets' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = [
      {
        id: 'acc-sock',
        name: 'Sock',
        workspaceId: 'ws-default',
        color: '#4a9',
        muted: false,
        zoomFactor: 1,
        startUrl: idleUrl,
        lastUrl: '',
        adblockEnabled: true,
      },
    ];
    s.layout = '1';
    s.page = 0;
    if (!s.settings) s.settings = {};
    if (!s.settings.adblock) s.settings.adblock = {};
    s.settings.adblock.enabled = true;
    if (!s.settings.languageTool) s.settings.languageTool = {};
    s.settings.languageTool.enabled = true;
    if (!s.settings.aiWrite) s.settings.aiWrite = {};
    s.settings.aiWrite.enabled = true;
    if (!s.settings.extensions) s.settings.extensions = {};
    s.settings.extensions.abuCompat = true;
  });
  flushSave();

  if (permissions && typeof permissions.clearDecisionsForTest === 'function') {
    permissions.clearDecisionsForTest();
  }

  panels.createPanel('acc-sock');
  await sleep(800);
  panels.panelNavigate('acc-sock', idleUrl);
  await waitForUrl('acc-sock', (u) => u.includes('/idle'), 20000);
  await sleep(1500);

  writePhase('idle', { url: idleUrl });
  await waitAck('idle');

  // (b) WebRTC like X.com on load
  panels.panelNavigate('acc-sock', webrtcUrl);
  await waitForUrl('acc-sock', (u) => u.includes('/webrtc'), 20000);
  const wc = panels.getPanelCapture('acc-sock');
  if (!wc) throw new Error('no panel webContents');
  let iceOk = false;
  for (let i = 0; i < 60; i++) {
    const title = await wc.executeJavaScript('document.title');
    if (title === 'webrtc-done' || title === 'webrtc-err') {
      iceOk = title === 'webrtc-done';
      break;
    }
    await sleep(250);
  }
  await sleep(800);
  writePhase('webrtc', { iceOk });
  await waitAck('webrtc');

  // (c) getUserMedia with fake device
  try {
    if (permissions && typeof permissions.selftestRespond === 'function') {
      // auto-allow upcoming mic/cam prompt if any
      setTimeout(() => {
        try {
          permissions.selftestRespond('acc-sock', 'allow');
        } catch {
          /* ignore */
        }
      }, 400);
    }
  } catch {
    /* ignore */
  }
  panels.panelNavigate('acc-sock', gumUrl);
  await waitForUrl('acc-sock', (u) => u.includes('/gum'), 20000);
  let gumOk = false;
  for (let i = 0; i < 40; i++) {
    try {
      permissions.selftestRespond('acc-sock', 'allow');
    } catch {
      /* ignore */
    }
    const title = await wc.executeJavaScript('document.title').catch(() => '');
    if (title === 'gum-done' || title === 'gum-err') {
      gumOk = title === 'gum-done';
      break;
    }
    await sleep(250);
  }
  await sleep(800);
  writePhase('gum', { gumOk });
  await waitAck('gum');

  // (d) modules already enabled — stay on idle with engines warm
  panels.panelNavigate('acc-sock', idleUrl);
  await waitForUrl('acc-sock', (u) => u.includes('/idle'), 20000);
  await sleep(2000);
  writePhase('modules', { adblock: true, languageTool: true, aiWrite: true });
  await waitAck('modules');

  writePhase('done', {});
  try {
    server.close();
  } catch {
    /* ignore */
  }
  console.log('PASS: sockets selftest phases complete');
  app.exit(0);
}

module.exports = { runSocketsSelftest };
