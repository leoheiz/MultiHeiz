'use strict';

/**
 * Self-test volume fino por janela (0–200% com reforço).
 * Uso: npm run selftest:volume
 * Phase 1: medições + UI; Phase 2: persistência (mesma USERDATA).
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-volume-'));

/** WAV PCM 16-bit mono 440Hz ~0.4s */
function makeWavBuffer(freq = 440, durationSec = 0.4, sampleRate = 22050) {
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
<audio id="a-blob" controls></audio>
<audio id="a-xorigin" controls></audio>
<div id="status">boot</div>
<script>
(function(){
  window.__volPage = {
    ready: false,
    osc: null,
    ctx: null,
    analyser: null,
    blobEl: null,
    xoEl: null,
    dynEl: null,
    lastRms: 0,
    err: ''
  };

  function rmsFromAnalyser(an) {
    if (!an) return 0;
    var buf = new Uint8Array(an.frequencyBinCount);
    an.getByteTimeDomainData(buf);
    var sum = 0;
    for (var i = 0; i < buf.length; i++) {
      var v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  window.__volPage.measureRms = function() {
    var v = rmsFromAnalyser(window.__volPage.analyser);
    window.__volPage.lastRms = v;
    return v;
  };

  window.__volPage.startAll = async function(xoUrl) {
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC();
    window.__volPage.ctx = ctx;
    var osc = ctx.createOscillator();
    osc.frequency.value = 523.25;
    var gain = ctx.createGain();
    gain.gain.value = 0.2;
    var analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    osc.connect(gain);
    gain.connect(analyser);
    analyser.connect(ctx.destination);
    osc.start();
    window.__volPage.osc = osc;
    window.__volPage.analyser = analyser;

    // WAV blob/data same-origin
    var sr = 22050, n = Math.floor(sr * 2), dataSize = n * 2;
    var ab = new ArrayBuffer(44 + dataSize);
    var dv = new DataView(ab);
    function wstr(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
    wstr(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    wstr(36, 'data'); dv.setUint32(40, dataSize, true);
    for (var i = 0; i < n; i++) {
      var s = Math.sin(2 * Math.PI * 440 * (i / sr)) * 0.3;
      dv.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, (s * 32767) | 0)), true);
    }
    var blob = new Blob([ab], { type: 'audio/wav' });
    var url = URL.createObjectURL(blob);
    var a = document.getElementById('a-blob');
    a.loop = true;
    a.src = url;
    window.__volPage.blobEl = a;
    try { await a.play(); } catch (e) { window.__volPage.err += 'blob:' + e; }

    var xo = document.getElementById('a-xorigin');
    xo.loop = true;
    xo.src = xoUrl;
    window.__volPage.xoEl = xo;
    try { await xo.play(); } catch (e2) { window.__volPage.err += 'xo:' + e2; }

    if (ctx.state === 'suspended') await ctx.resume();
    window.__volPage.ready = true;
    document.getElementById('status').textContent = 'ready';
    return true;
  };

  window.__volPage.addDynamic = async function() {
    var el = document.createElement('audio');
    el.id = 'a-dyn';
    el.loop = true;
    el.src = document.getElementById('a-blob').src;
    document.body.appendChild(el);
    window.__volPage.dynEl = el;
    try { await el.play(); } catch (e) { window.__volPage.err += 'dyn:' + e; }
    return true;
  };

  window.__volPage.readMediaVolumes = function() {
    function info(el) {
      if (!el) return null;
      return { volume: el.volume, muted: el.muted, paused: el.paused };
    }
    return {
      blob: info(window.__volPage.blobEl || document.getElementById('a-blob')),
      xo: info(window.__volPage.xoEl || document.getElementById('a-xorigin')),
      dyn: info(window.__volPage.dynEl || document.getElementById('a-dyn')),
      mh: window.__mhVol && window.__mhVol.getDiag ? window.__mhVol.getDiag() : null,
      level: window.__mhVol && window.__mhVol.get ? window.__mhVol.get() : null
    };
  };
})();
</script>
</body>
</html>`;

function startServers() {
  const wav = makeWavBuffer();
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
      // Sem CORS — simula cross-origin sem CORS
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': wav.length,
      });
      res.end(wav);
    });
    main.listen(0, '127.0.0.1', () => {
      xo.listen(0, '127.0.0.1', () => {
        const mainPort = main.address().port;
        const xoPort = xo.address().port;
        resolve({
          main,
          xo,
          pageUrl: `http://127.0.0.1:${mainPort}/`,
          xoUrl: `http://127.0.0.1:${xoPort}/tone.wav`,
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
    }, 240000);
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
    console.log('xo:', servers.xoUrl);
    await run('1', {
      MULTIHEIZ_VOLUME_TEST_URL: servers.pageUrl,
      MULTIHEIZ_VOLUME_XO_URL: servers.xoUrl,
    });
    await run('2', {
      MULTIHEIZ_VOLUME_TEST_URL: servers.pageUrl,
      MULTIHEIZ_VOLUME_XO_URL: servers.xoUrl,
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
