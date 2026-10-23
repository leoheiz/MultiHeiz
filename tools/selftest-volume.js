'use strict';

/**
 * Self-test volume fino por janela (0–200% com reforço).
 * Uso: npm run selftest:volume
 * Phase 1: fixtures A–F + UI; Phase 2: persistência (mesma USERDATA).
 * Saída longa: _local/st-selftest-volume.log (via caller) / stdout.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-volume-'));

/** WAV PCM 16-bit mono — duração longa (stream tipo rádio / loop). */
function makeWavBuffer(freq = 440, durationSec = 12, sampleRate = 22050) {
  const n = Math.floor(sampleRate * durationSec);
  const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.35;
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.floor(sample * 32767))), 44 + i * 2);
  }
  return buf;
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<title>MH Volume Test</title>
</head>
<body>
<h1>Volume selftest</h1>
<audio id="a-same" controls loop></audio>
<iframe id="ifr" title="xo-player" style="width:320px;height:80px;border:0"></iframe>
<div id="status">boot</div>
<script>
(function(){
  window.__volPage = {
    ready: false,
    osc: null,
    ctx: null,
    analyser: null,
    sameEl: null,
    detachedCors: null,
    detachedNoCors: null,
    spamEl: null,
    spamTimer: null,
    lastRms: 0,
    err: ''
  };

  function makeLocalWavUrl(freq, sec) {
    var sr = 22050, n = Math.floor(sr * (sec || 4)), dataSize = n * 2;
    var ab = new ArrayBuffer(44 + dataSize);
    var dv = new DataView(ab);
    function wstr(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
    wstr(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    wstr(36, 'data'); dv.setUint32(40, dataSize, true);
    for (var i = 0; i < n; i++) {
      var s = Math.sin(2 * Math.PI * (freq || 440) * (i / sr)) * 0.3;
      dv.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, (s * 32767) | 0)), true);
    }
    return URL.createObjectURL(new Blob([ab], { type: 'audio/wav' }));
  }

  window.__volPage.measureRms = function() {
    try {
      if (window.__mhVol && typeof window.__mhVol.measureTestRms === 'function') {
        window.__mhVol.enableTestTap && window.__mhVol.enableTestTap();
        var v = window.__mhVol.measureTestRms();
        window.__volPage.lastRms = v;
        return v;
      }
    } catch (e0) {}
    return 0;
  };

  window.__volPage.stopAll = async function() {
    try { if (window.__volPage.spamTimer) clearInterval(window.__volPage.spamTimer); } catch (e1) {}
    window.__volPage.spamTimer = null;
    var list = [
      window.__volPage.sameEl,
      window.__volPage.detachedCors,
      window.__volPage.detachedNoCors,
      window.__volPage.spamEl
    ];
    for (var i = 0; i < list.length; i++) {
      try { if (list[i]) { list[i].pause(); list[i].removeAttribute('src'); list[i].load(); } } catch (e2) {}
    }
    try {
      if (window.__volPage.osc) { window.__volPage.osc.stop(); window.__volPage.osc.disconnect(); }
    } catch (e3) {}
    window.__volPage.osc = null;
    try {
      var ifr = document.getElementById('ifr');
      if (ifr) ifr.removeAttribute('src');
    } catch (e4) {}
    await new Promise(function(r){ setTimeout(r, 120); });
  };

  window.__volPage.startSame = async function() {
    var a = document.getElementById('a-same');
    a.loop = true;
    a.src = makeLocalWavUrl(440, 6);
    window.__volPage.sameEl = a;
    try { await a.play(); } catch (e) { window.__volPage.err += 'same:' + e; }
    return true;
  };

  window.__volPage.startDetachedCors = async function(corsUrl) {
    var a = new Audio();
    a.loop = true;
    a.preload = 'none';
    a.src = corsUrl;
    window.__volPage.detachedCors = a;
    try { await a.play(); } catch (e) { window.__volPage.err += 'cors:' + e; }
    return true;
  };

  window.__volPage.startDetachedNoCors = async function(noCorsUrl) {
    var a = new Audio();
    a.loop = true;
    a.preload = 'none';
    a.src = noCorsUrl;
    window.__volPage.detachedNoCors = a;
    try { await a.play(); } catch (e) { window.__volPage.err += 'nocors:' + e; }
    return true;
  };

  window.__volPage.startSpam = async function(corsUrl) {
    var a = new Audio();
    a.loop = true;
    a.preload = 'none';
    a.src = corsUrl;
    window.__volPage.spamEl = a;
    try { await a.play(); } catch (e) { window.__volPage.err += 'spam:' + e; }
    window.__volPage.spamTimer = setInterval(function() {
      try { a.volume = 1; } catch (e2) {}
    }, 200);
    return true;
  };

  window.__volPage.startOsc = async function() {
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC();
    window.__volPage.ctx = ctx;
    var osc = ctx.createOscillator();
    osc.frequency.value = 523.25;
    var gain = ctx.createGain();
    gain.gain.value = 0.2;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    window.__volPage.osc = osc;
    if (ctx.state === 'suspended') await ctx.resume();
    return true;
  };

  window.__volPage.startIframe = function(iframeUrl) {
    var ifr = document.getElementById('ifr');
    ifr.src = iframeUrl;
    return true;
  };

  window.__volPage.startAll = async function(opts) {
    opts = opts || {};
    await window.__volPage.startSame();
    if (opts.corsUrl) await window.__volPage.startDetachedCors(opts.corsUrl);
    if (opts.noCorsUrl) await window.__volPage.startDetachedNoCors(opts.noCorsUrl);
    if (opts.spamUrl) await window.__volPage.startSpam(opts.spamUrl);
    if (opts.iframeUrl) window.__volPage.startIframe(opts.iframeUrl);
    await window.__volPage.startOsc();
    window.__volPage.ready = true;
    document.getElementById('status').textContent = 'ready';
    return true;
  };

  window.__volPage.addDynamic = async function() {
    var el = document.createElement('audio');
    el.id = 'a-dyn';
    el.loop = true;
    el.src = makeLocalWavUrl(330, 3);
    document.body.appendChild(el);
    window.__volPage.dynEl = el;
    try { await el.play(); } catch (e) { window.__volPage.err += 'dyn:' + e; }
    return true;
  };

  window.__volPage.readMediaVolumes = function() {
    function info(el) {
      if (!el) return null;
      return {
        volume: el.volume,
        muted: el.muted,
        paused: el.paused,
        detached: !el.isConnected
      };
    }
    return {
      same: info(window.__volPage.sameEl || document.getElementById('a-same')),
      detachedCors: info(window.__volPage.detachedCors),
      detachedNoCors: info(window.__volPage.detachedNoCors),
      spam: info(window.__volPage.spamEl),
      dyn: info(window.__volPage.dynEl || document.getElementById('a-dyn')),
      mh: window.__mhVol && window.__mhVol.getDiag ? window.__mhVol.getDiag() : null,
      level: window.__mhVol && window.__mhVol.get ? window.__mhVol.get() : null
    };
  };
})();
</script>
</body>
</html>`;

const IFRAME_HTML = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"/><title>iframe vol</title></head>
<body>
<audio id="a" controls loop></audio>
<script>
(async function(){
  var a = document.getElementById('a');
  a.loop = true;
  a.src = '/tone.wav';
  try { await a.play(); } catch (e) { document.title = 'err:' + e; }
  window.__ifrReady = true;
})();
</script>
</body></html>`;

function startServers() {
  const wav = makeWavBuffer(440, 14);
  const wavB = makeWavBuffer(554, 14);
  return new Promise((resolve, reject) => {
    const main = http.createServer((req, res) => {
      if (req.url === '/tone.wav') {
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': wav.length,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(wav);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
    });
    const xo = http.createServer((req, res) => {
      const u = req.url || '/';
      if (u.startsWith('/tone-cors.wav') || u === '/tone.wav') {
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': wavB.length,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(wavB);
        return;
      }
      if (u.startsWith('/tone-nocors.wav')) {
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': wavB.length,
        });
        res.end(wavB);
        return;
      }
      if (u.startsWith('/iframe')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(IFRAME_HTML);
        return;
      }
      res.writeHead(404);
      res.end('no');
    });
    main.listen(0, '127.0.0.1', () => {
      xo.listen(0, '127.0.0.1', () => {
        const mainPort = main.address().port;
        const xoPort = xo.address().port;
        resolve({
          main,
          xo,
          pageUrl: `http://127.0.0.1:${mainPort}/`,
          corsUrl: `http://127.0.0.1:${xoPort}/tone-cors.wav`,
          noCorsUrl: `http://127.0.0.1:${xoPort}/tone-nocors.wav`,
          iframeUrl: `http://127.0.0.1:${xoPort}/iframe`,
          // compat legado
          xoUrl: `http://127.0.0.1:${xoPort}/tone-nocors.wav`,
        });
      });
    });
    main.on('error', reject);
    xo.on('error', reject);
  });
}

function run(phase, envExtra) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'volume',
      MULTIHEIZ_SELFTEST_PHASE: String(phase || '1'),
      MULTIHEIZ_UI_WIDTH: '1280',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
      ...envExtra,
    };
    console.log('MultiHeiz selftest:volume phase', phase);
    console.log('userdata:', userdata);
    const child = spawn(electronBin, ['.'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (buf) => {
      const s = buf.toString();
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('volume selftest timed out'));
    }, 300000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error('volume selftest exited with code ' + code));
    });
  });
}

async function main() {
  let servers = null;
  try {
    servers = await startServers();
    console.log('page:', servers.pageUrl);
    console.log('cors:', servers.corsUrl);
    console.log('nocors:', servers.noCorsUrl);
    console.log('iframe:', servers.iframeUrl);
    await run('1', {
      MULTIHEIZ_VOLUME_TEST_URL: servers.pageUrl,
      MULTIHEIZ_VOLUME_XO_URL: servers.xoUrl,
      MULTIHEIZ_VOLUME_CORS_URL: servers.corsUrl,
      MULTIHEIZ_VOLUME_NOCORS_URL: servers.noCorsUrl,
      MULTIHEIZ_VOLUME_IFRAME_URL: servers.iframeUrl,
    });
    await run('2', {
      MULTIHEIZ_VOLUME_TEST_URL: servers.pageUrl,
      MULTIHEIZ_VOLUME_XO_URL: servers.xoUrl,
      MULTIHEIZ_VOLUME_CORS_URL: servers.corsUrl,
      MULTIHEIZ_VOLUME_NOCORS_URL: servers.noCorsUrl,
      MULTIHEIZ_VOLUME_IFRAME_URL: servers.iframeUrl,
    });
    console.log('PASS: selftest:volume complete');
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  } finally {
    try {
      if (servers) {
        servers.main.close();
        servers.xo.close();
      }
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(userdata, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main();
