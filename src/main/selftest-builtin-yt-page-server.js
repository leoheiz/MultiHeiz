'use strict';

/**
 * Local HTTPS YouTube stand-in for selftest:builtin-yt.
 * Reuses cert helper from abu-yt page-server; maps hosts via host-resolver-rules.
 */

const https = require('node:https');
const path = require('node:path');
const os = require('node:os');
const { ensureCerts } = require('./selftest-abu-yt-page-server');

/**
 * @param {{ isEmbed?: boolean, port?: number }} opts
 */
function pageHtml(opts) {
  const isEmbed = !!(opts && opts.isEmbed);
  const port = (opts && opts.port) || 18453;
  const nocookieSrc = 'https://www.youtube-nocookie.com:' + port + '/embed/x';
  return `<!doctype html><html><head><script>
window.__R = {
  guardAtHead: window.__mhEarlyMainWorldDone,
  injAtHead: JSON.stringify(window.__INJ || null)
};
try { window.__R.earlyDescriptor = !!Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse'); } catch (e) {}
window.ytInitialPlayerResponse = { adPlacements: [1], playerAds: [1], adSlots: [1], videoDetails: { videoId: 'x' } };
window.__R.adPlacements = window.ytInitialPlayerResponse.adPlacements;
window.__R.playerAds = window.ytInitialPlayerResponse.playerAds;
window.__R.adSlots = window.ytInitialPlayerResponse.adSlots;
window.__R.googleAdStatus = String(window.google_ad_status);
window.__R.guard = window.__mhEarlyMainWorldDone;
fetch('/youtubei/v1/player?key=1').then(function(r){ return r.json(); }).then(function(j){
  window.__R.fetchPlayer = JSON.stringify(j);
}).catch(function(e){ window.__R.fetchPlayer = 'ERR ' + e.message; });
fetch('/youtubei/v1/next?key=1').then(function(r){ return r.json(); }).then(function(j){
  window.__R.fetchNext = JSON.stringify(j);
}).catch(function(e){ window.__R.fetchNext = 'ERR ' + e.message; });
(function(){
  var x = new XMLHttpRequest();
  x.open('GET', '/youtubei/v1/player?xhr=1');
  x.onload = function(){
    try { window.__R.xhrPlayer = JSON.stringify(JSON.parse(x.responseText)); }
    catch (e) { window.__R.xhrPlayer = 'ERR ' + e.message; }
  };
  x.onerror = function(){ window.__R.xhrPlayer = 'ERR network'; };
  x.send();
})();
(function(){
  var x = new XMLHttpRequest();
  x.open('GET', '/youtubei/v1/next?xhr=1');
  x.onload = function(){
    try { window.__R.xhrNext = JSON.stringify(JSON.parse(x.responseText)); }
    catch (e) { window.__R.xhrNext = 'ERR ' + e.message; }
  };
  x.onerror = function(){ window.__R.xhrNext = 'ERR network'; };
  x.send();
})();
try {
  var shortsRaw = '{"entries":[{"command":{"reelWatchEndpoint":{"adClientParams":{"isAd":true,"x":1},"videoId":"s1"}}},{"command":{"reelWatchEndpoint":{"adClientParams":{"isAd":false},"videoId":"s2"}}}]}';
  window.__R.shortsParsed = JSON.stringify(JSON.parse(shortsRaw));
} catch (e) { window.__R.shortsParsed = 'ERR ' + e.message; }
</script></head><body>
<div id="ok">builtin-yt</div>
${isEmbed ? '' : '<iframe id="nocookie" src="' + nocookieSrc + '"></iframe>'}
<script>
setTimeout(function(){
  // about:srcdoc gets frame preloads; plain about:blank often does not when created dynamically.
  if (!document.getElementById('blank')) {
    var b = document.createElement('iframe');
    b.id = 'blank';
    b.srcdoc = '<!doctype html><html><head></head><body data-mh="blank-child">x</body></html>';
    document.body.appendChild(b);
  }
  window.__R.guardLater = window.__mhEarlyMainWorldDone;
  window.__R.ready = !!(window.__R.fetchPlayer && window.__R.fetchNext && window.__R.xhrPlayer && window.__R.xhrNext);
}, 1200);
</script>
</body></html>`;
}

/**
 * @param {number} [preferredPort]
 */
function startPageServer(preferredPort) {
  const certDir = path.join(os.tmpdir(), 'multiheiz-builtin-yt-certs');
  const { key, cert } = ensureCerts(certDir);

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

  const nextJson = JSON.stringify({
    contents: {},
    adPlacements: [1],
    playerAds: [1],
    adSlots: [1],
    playerResponse: {
      adPlacements: [1],
      playerAds: [1],
      adSlots: [1],
    },
  });

  return new Promise((resolve, reject) => {
    /** @type {number} */
    let boundPort = preferredPort || 18453;

    const server = https.createServer({ key, cert }, (req, rsp) => {
      const url = String(req.url || '/');
      if (url.startsWith('/youtubei/v1/player')) {
        rsp.setHeader('content-type', 'application/json');
        rsp.setHeader('access-control-allow-origin', '*');
        rsp.end(playerJson);
        return;
      }
      if (url.startsWith('/youtubei/v1/next')) {
        rsp.setHeader('content-type', 'application/json');
        rsp.setHeader('access-control-allow-origin', '*');
        rsp.end(nextJson);
        return;
      }
      if (url === '/robots.txt' || url.startsWith('/robots.txt')) {
        rsp.setHeader('content-type', 'text/plain');
        rsp.end('User-agent: *\nDisallow:');
        return;
      }
      rsp.setHeader('content-type', 'text/html; charset=utf-8');
      rsp.end(pageHtml({ isEmbed: url.startsWith('/embed/'), port: boundPort }));
    });

    const base = preferredPort || 18453;
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
        boundPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve({
          server,
          port: boundPort,
          origin(host) {
            return 'https://' + (host || 'www.youtube.com') + ':' + boundPort;
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

module.exports = { startPageServer, pageHtml };
