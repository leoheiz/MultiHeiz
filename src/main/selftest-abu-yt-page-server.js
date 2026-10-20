'use strict';

/**
 * Local HTTPS YouTube stand-in for selftest:abu-yt (PLAN 3.A).
 * Self-signed cert; caller maps www.youtube.com → 127.0.0.1 via host-resolver-rules.
 */

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const crypto = require('node:crypto');

/**
 * @param {boolean} isEmbed
 */
function pageHtml(isEmbed) {
  return `<!doctype html><html><head><script>
window.__R = {
  injAtHead: JSON.stringify(window.__INJ || null),
  earlyMarker: String((window.__INJ || []).join(','))
};
try { window.__R.earlyDescriptor = !!Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse'); } catch (e) {}
window.ytInitialPlayerResponse = { adPlacements: [1], playerAds: [1], adSlots: [1], videoDetails: { videoId: 'x' } };
window.__R.setConstantAdPlacements = String(window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.adPlacements);
window.__R.googleAdStatus = String(window.google_ad_status);
window.__timeoutFactors = window.__timeoutFactors || [];
(function(){
  var orig = window.setTimeout;
  window.setTimeout = function(fn, delay) {
    var d = Number(delay);
    if (isFinite(d) && d > 0 && d < 20000) window.__timeoutFactors.push(d);
    return orig.apply(this, arguments);
  };
})();
fetch('/youtubei/v1/player?key=1').then(function(r){ return r.json(); }).then(function(j){
  window.__R.fetchPrune = JSON.stringify(j);
}).catch(function(e){ window.__R.fetchPrune = 'ERR ' + e.message; });
</script></head><body>
<ytd-rich-grid-renderer><div id="contents">
<ytd-rich-item-renderer id="aditem"><div id="content"><ytd-ad-slot-renderer>AD</ytd-ad-slot-renderer></div></ytd-rich-item-renderer>
<ytd-rich-item-renderer id="dispad"><div><ytd-display-ad-renderer>DISPLAY AD</ytd-display-ad-renderer></div></ytd-rich-item-renderer>
<ytd-rich-item-renderer id="normal"><div id="content"><span>video</span></div></ytd-rich-item-renderer>
</div></ytd-rich-grid-renderer>
<div id="shorts-inner-container"><div class="ytd-shorts"><div class="ytd-reel-video-renderer"><ytd-ad-slot-renderer id="shorts-ad">SHORTS AD</ytd-ad-slot-renderer></div></div></div>
<div id="masthead-ad">masthead</div>
${isEmbed ? '' : '<iframe id="emb" src="/embed/x"></iframe>'}
<script>
setTimeout(function(){
  window.__R.inj = JSON.stringify(window.__INJ || null);
  window.__R.mastheadDisplay = getComputedStyle(document.getElementById('masthead-ad')).display;
  window.__R.adItemDisplay = getComputedStyle(document.getElementById('aditem')).display;
  window.__R.extCssDispAd = getComputedStyle(document.getElementById('dispad')).display;
  // ABU: ###shorts-inner-container > .ytd-shorts:has(> .ytd-reel-video-renderer > ytd-ad-slot-renderer)
  var shortsEl = document.querySelector('#shorts-inner-container > .ytd-shorts');
  window.__R.shortsAdDisplay = shortsEl ? getComputedStyle(shortsEl).display : 'missing';
  window.__R.normalDisplay = getComputedStyle(document.getElementById('normal')).display;
  window.__R.timeoutFactors = (window.__timeoutFactors || []).slice();
}, 2800);
</script>
</body></html>`;
}

function opensslBins() {
  const list = ['openssl'];
  if (process.platform === 'win32') {
    list.push(
      'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe'
    );
  }
  return list;
}

/**
 * @param {string} dir
 */
function ensureCerts(dir) {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  fs.mkdirSync(dir, { recursive: true });
  let lastErr = null;
  for (const bin of opensslBins()) {
    try {
      execFileSync(
        bin,
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-days',
          '7',
          '-nodes',
          '-subj',
          '/CN=www.youtube.com',
        ],
        { stdio: 'pipe' }
      );
      if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  // Node 22+: crypto.X509Certificate cannot mint; use tls.createSecureContext requires real PEM.
  // Generate via a tiny openssl-compatible approach using child_process with -new and extensions.
  void crypto;
  throw new Error(
    'selftest-abu-yt: need openssl to create self-signed cert' +
      (lastErr && lastErr.message ? ' (' + lastErr.message + ')' : '')
  );
}

/**
 * @param {number} [preferredPort]
 * @returns {Promise<{ server: import('https').Server, port: number, hits: { pagead: number, adBreak: number }, origin: (host?: string) => string, close: () => Promise<void> }>}
 */
function startPageServer(preferredPort) {
  const certDir = path.join(os.tmpdir(), 'multiheiz-abu-yt-certs');
  const { key, cert } = ensureCerts(certDir);
  const hits = { pagead: 0, adBreak: 0 };

  const playerJson = JSON.stringify({
    playerResponse: {
      adPlacements: [1],
      playerAds: [1],
      adSlots: [1],
      videoDetails: {},
    },
    adPlacements: [1],
    playerAds: [1],
    adSlots: [1],
    videoDetails: {},
  });

  return new Promise((resolve, reject) => {
    const server = https.createServer({ key, cert }, (req, rsp) => {
      const url = String(req.url || '/');
      if (url.startsWith('/pagead')) {
        hits.pagead += 1;
        rsp.statusCode = 200;
        rsp.end('ad');
        return;
      }
      if (url.startsWith('/youtubei/v1/player/ad_break')) {
        hits.adBreak += 1;
        rsp.statusCode = 200;
        rsp.end('{}');
        return;
      }
      if (url.startsWith('/youtubei/v1/player')) {
        rsp.setHeader('content-type', 'application/json');
        rsp.setHeader('access-control-allow-origin', '*');
        rsp.end(playerJson);
        return;
      }
      if (url === '/robots.txt' || url.startsWith('/robots.txt')) {
        rsp.setHeader('content-type', 'text/plain');
        rsp.end('User-agent: *\nDisallow:');
        return;
      }
      rsp.setHeader('content-type', 'text/html; charset=utf-8');
      rsp.end(pageHtml(url.startsWith('/embed/')));
    });

    const base = preferredPort || 18443;
    const tryListen = (port) => {
      const onErr = (err) => {
        server.removeListener('error', onErr);
        if (err && err.code === 'EADDRINUSE' && port < base + 30) {
          tryListen(port + 1);
        } else {
          reject(err);
        }
      };
      server.once('error', onErr);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onErr);
        const addr = server.address();
        const p = typeof addr === 'object' && addr ? addr.port : port;
        resolve({
          server,
          port: p,
          hits,
          origin(host) {
            return 'https://' + (host || 'www.youtube.com') + ':' + p;
          },
          close() {
            return new Promise((res) => server.close(() => res()));
          },
        });
      });
    };
    tryListen(base);
  });
}

module.exports = { startPageServer, pageHtml, ensureCerts };
