'use strict';

/**
 * Fonte injetada no MAIN WORLD de cada frame de painel.
 * Controla volume 0–200% via GainNode (+ limitador suave acima de 100%)
 * com fallback element.volume para mídia cross-origin sem CORS.
 *
 * Limitações documentadas:
 * - WebRTC / MediaStream em <audio|video>: só element.volume (≤100%), sem
 *   createMediaElementSource — evita eco/quebra em chamadas.
 * - Cross-origin sem CORS: element.volume ≤100%, reforço ignorado nesse elemento.
 * - Iframes cross-process / sandboxed sem preload: podem não receber a injeção.
 * - Não cria AudioContext antes de reprodução/gesto (autoplay).
 */

/**
 * @returns {string} IIFE para executeInMainWorld / executeJavaScript
 */
function getVolumeInjectSource() {
  return `(function(){
  try {
    if (window.__mhVolCtlDone) return;
    window.__mhVolCtlDone = 1;
  } catch (e0) { return; }

  var level = 1;
  var AC = window.AudioContext || window.webkitAudioContext;
  var sharedCtx = null;
  var sharedChain = null;
  var ctxChains = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var allChains = [];
  var routed = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var seenEls = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  var pageVolMap = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var corsTried = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  var corsFailed = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  var liveBoostTried = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  var tracked = [];
  var HasWeakRef = typeof WeakRef !== 'undefined';
  var origConnect = null;
  var hookConnectInstalled = false;
  var writingVolume = false;
  var origVolDesc = null;
  var origVolGet = null;
  var origVolSet = null;
  var testAnalysers = [];
  var diag = {
    mediaRouted: 0,
    mediaElementFallback: 0,
    mediaStreamSkipped: 0,
    webaudioRouted: 0,
    lastMode: '',
    lastError: '',
    corsUpgrades: 0,
    corsReverts: 0,
    liveBoostAttempts: 0
  };

  function clampLevel(v) {
    var n = Number(v);
    if (!isFinite(n)) return 1;
    if (n < 0) return 0;
    if (n > 2) return 2;
    return n;
  }

  function clamp01(v) {
    var n = Number(v);
    if (!isFinite(n)) return 1;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  function ensureSharedCtx() {
    if (!AC) return null;
    if (!sharedCtx) {
      try { sharedCtx = new AC(); } catch (e1) { diag.lastError = String(e1 && e1.message || e1); return null; }
    }
    return sharedCtx;
  }

  function resumeCtx(ctx) {
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        var p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(function(){});
      }
    } catch (e2) {}
  }

  function makeChain(ctx) {
    var gain = ctx.createGain();
    var comp = ctx.createDynamicsCompressor();
    try {
      comp.threshold.setValueAtTime(-12, ctx.currentTime);
      comp.knee.setValueAtTime(12, ctx.currentTime);
      comp.ratio.setValueAtTime(8, ctx.currentTime);
      comp.attack.setValueAtTime(0.003, ctx.currentTime);
      comp.release.setValueAtTime(0.12, ctx.currentTime);
    } catch (e3) {}
    gain.gain.value = level;
    if (origConnect) {
      origConnect.call(gain, comp);
      origConnect.call(comp, ctx.destination);
    } else {
      gain.connect(comp);
      comp.connect(ctx.destination);
    }
    var chain = { gain: gain, compressor: comp, ctx: ctx };
    allChains.push(chain);
    return chain;
  }

  function getSharedChain() {
    var ctx = ensureSharedCtx();
    if (!ctx) return null;
    if (!sharedChain) sharedChain = makeChain(ctx);
    return sharedChain;
  }

  function getCtxChain(ctx) {
    if (!ctx) return null;
    if (ctxChains) {
      var c = ctxChains.get(ctx);
      if (c) return c;
      c = makeChain(ctx);
      ctxChains.set(ctx, c);
      return c;
    }
    return makeChain(ctx);
  }

  function applyChainGain(chain) {
    if (!chain || !chain.gain) return;
    try { chain.gain.gain.value = level; } catch (e4) {}
  }

  function applyAllGains() {
    for (var i = 0; i < allChains.length; i++) applyChainGain(allChains[i]);
  }

  function tapChain(chain) {
    if (!chain || !chain.ctx || !chain.compressor) return null;
    if (chain.testAnalyser) return chain.testAnalyser;
    try {
      var an = chain.ctx.createAnalyser();
      an.fftSize = 2048;
      try { chain.compressor.disconnect(); } catch (eTap0) {}
      if (origConnect) {
        origConnect.call(chain.compressor, an);
        origConnect.call(an, chain.ctx.destination);
      } else {
        chain.compressor.connect(an);
        an.connect(chain.ctx.destination);
      }
      chain.testAnalyser = an;
      testAnalysers.push(an);
      return an;
    } catch (eTap1) {
      diag.lastError = String(eTap1 && eTap1.message || eTap1);
      return null;
    }
  }

  function enableTestTap() {
    try {
      getSharedChain();
    } catch (eTap2) {}
    var last = null;
    for (var i = 0; i < allChains.length; i++) {
      var an = tapChain(allChains[i]);
      if (an) last = an;
    }
    return last;
  }

  function rmsOfAnalyser(an) {
    if (!an) return 0;
    try {
      var buf = new Uint8Array(an.frequencyBinCount);
      an.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) {
        var v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / buf.length);
    } catch (eTap3) {
      return 0;
    }
  }

  function measureTestRms() {
    try {
      enableTestTap();
      var best = 0;
      for (var i = 0; i < allChains.length; i++) {
        var an = allChains[i] && allChains[i].testAnalyser;
        var r = rmsOfAnalyser(an);
        if (r > best) best = r;
      }
      for (var j = 0; j < testAnalysers.length; j++) {
        var r2 = rmsOfAnalyser(testAnalysers[j]);
        if (r2 > best) best = r2;
      }
      return best;
    } catch (eTap4) {
      return 0;
    }
  }

  function isMediaStreamEl(el) {
    try {
      if (!el || !el.srcObject) return false;
      if (typeof MediaStream !== 'undefined' && el.srcObject instanceof MediaStream) return true;
    } catch (e5) {}
    return false;
  }

  function getSrcString(el) {
    try { return el.currentSrc || el.src || ''; } catch (e6) { return ''; }
  }

  function isCrossOriginHttpSrc(src) {
    try {
      if (!src || typeof src !== 'string') return false;
      if (src.indexOf('blob:') === 0 || src.indexOf('data:') === 0 || src.indexOf('mediastream:') === 0) {
        return false;
      }
      var u = new URL(src, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return u.origin !== location.origin;
    } catch (e7) {
      return false;
    }
  }

  function hasCorsAttr(el) {
    try {
      var co = el.crossOrigin;
      return co === 'anonymous' || co === 'use-credentials';
    } catch (e8) {
      return false;
    }
  }

  function isLikelyCrossOriginNoCors(el) {
    try {
      if (isMediaStreamEl(el)) return false;
      if (corsFailed && corsFailed.has(el)) return true;
      var src = getSrcString(el);
      if (!isCrossOriginHttpSrc(src)) return false;
      if (hasCorsAttr(el)) return false;
      return true;
    } catch (e9) {
      return true;
    }
  }

  function getPageVolume(el) {
    if (pageVolMap && pageVolMap.has(el)) return pageVolMap.get(el);
    try {
      if (origVolGet) return clamp01(origVolGet.call(el));
      return clamp01(el.volume);
    } catch (e10) {
      return 1;
    }
  }

  function setNativeVolume(el, v) {
    writingVolume = true;
    try {
      if (origVolSet) origVolSet.call(el, clamp01(v));
      else el.volume = clamp01(v);
    } catch (e11) {
    } finally {
      writingVolume = false;
    }
  }

  function applyElementVolume(el) {
    try {
      var pageV = getPageVolume(el);
      var eff = pageV * (level > 1 ? 1 : level);
      setNativeVolume(el, eff);
    } catch (e12) {}
  }

  function applyGainElementVolume(el) {
    try {
      setNativeVolume(el, getPageVolume(el));
    } catch (e13) {}
  }

  function cleanupTracked() {
    var next = [];
    for (var i = 0; i < tracked.length; i++) {
      var item = tracked[i];
      var el = null;
      try {
        if (HasWeakRef && item && typeof item.deref === 'function') el = item.deref();
        else el = item;
      } catch (e14) { el = null; }
      if (el) next.push(item);
    }
    tracked = next;
  }

  function listTrackedElements() {
    cleanupTracked();
    var out = [];
    for (var i = 0; i < tracked.length; i++) {
      var item = tracked[i];
      var el = null;
      try {
        if (HasWeakRef && item && typeof item.deref === 'function') el = item.deref();
        else el = item;
      } catch (e15) { el = null; }
      if (el) out.push(el);
    }
    return out;
  }

  function trackElement(el) {
    if (!el) return;
    if (seenEls) {
      if (seenEls.has(el)) return;
      seenEls.add(el);
    }
    try {
      if (pageVolMap && !pageVolMap.has(el)) {
        var initial = 1;
        try {
          if (origVolGet) initial = clamp01(origVolGet.call(el));
          else initial = clamp01(el.volume);
        } catch (e16) { initial = 1; }
        pageVolMap.set(el, initial);
      }
    } catch (e17) {}
    try {
      tracked.push(HasWeakRef ? new WeakRef(el) : el);
    } catch (e18) {
      tracked.push(el);
    }
    var onPlay = function() {
      routeMediaElement(el);
      var chain = sharedChain;
      if (chain) resumeCtx(chain.ctx);
      else resumeCtx(ensureSharedCtx());
    };
    try {
      el.addEventListener('play', onPlay, true);
      el.addEventListener('playing', onPlay, true);
    } catch (e19) {}
    try {
      if (!el.paused) onPlay();
    } catch (e20) {}
  }

  function markCorsFailed(el, reason) {
    try {
      if (corsFailed) corsFailed.add(el);
      if (routed) {
        routed.set(el, { mode: 'element', reason: reason || 'cross-origin-no-cors' });
      }
      diag.mediaElementFallback += 1;
      diag.lastMode = 'element-cors';
      applyElementVolume(el);
    } catch (e21) {}
  }

  function revertCorsUpgrade(el, src, wasPlaying) {
    try {
      diag.corsReverts += 1;
      if (corsFailed) corsFailed.add(el);
      try { el.removeAttribute('crossorigin'); } catch (e22) {}
      try { el.crossOrigin = null; } catch (e23) {}
      try {
        if (src) el.src = src;
      } catch (e24) {}
      try { el.load(); } catch (e25) {}
      // Sempre tentar play: o erro CORS costuma ocorrer antes do 1º frame
      // (wasPlaying pode ser false mesmo com play() já chamado pela página).
      try {
        var p = el.play();
        if (p && typeof p.catch === 'function') p.catch(function(){});
      } catch (e26) {}
      markCorsFailed(el, 'cross-origin-no-cors');
    } catch (e27) {
      markCorsFailed(el, 'cross-origin-no-cors');
    }
  }

  function maybeUpgradeCrossOrigin(el, pendingSrc) {
    try {
      if (!el || isMediaStreamEl(el)) return false;
      var src = pendingSrc || getSrcString(el);
      if (!isCrossOriginHttpSrc(src)) return false;
      if (hasCorsAttr(el)) return false;
      if (corsFailed && corsFailed.has(el)) return false;
      if (corsTried && corsTried.has(el)) return false;
      var rs = 0;
      try { rs = el.readyState || 0; } catch (e28) { rs = 0; }
      if (rs > 0) return false;
      if (corsTried) corsTried.add(el);
      try {
        el.crossOrigin = 'anonymous';
        diag.corsUpgrades += 1;
      } catch (e29) {
        return false;
      }
      var reverted = false;
      var onErr = function() {
        if (reverted) return;
        reverted = true;
        try { el.removeEventListener('error', onErr, true); } catch (e30) {}
        var playing = false;
        try { playing = !el.paused; } catch (e31) {}
        revertCorsUpgrade(el, src, playing);
      };
      try { el.addEventListener('error', onErr, true); } catch (e32) {}
      setTimeout(function() {
        try { el.removeEventListener('error', onErr, true); } catch (e33) {}
      }, 8000);
      return true;
    } catch (e34) {
      return false;
    }
  }

  function tryLiveBoostReload(el) {
    try {
      if (!el || level <= 1) return false;
      if (!routed || !routed.has(el)) return false;
      var info = routed.get(el);
      if (!info || info.mode !== 'element') return false;
      if (info.reason !== 'cross-origin' && info.reason !== 'cross-origin-no-cors') return false;
      if (liveBoostTried && liveBoostTried.has(el)) return false;
      var dur = NaN;
      try { dur = el.duration; } catch (e35) { dur = NaN; }
      // Só streams ao vivo (Infinity). NaN/finito: NÃO recarregar (quebraria WAV/VOD).
      if (dur !== Infinity) return false;
      var src = getSrcString(el);
      if (!isCrossOriginHttpSrc(src)) return false;
      if (liveBoostTried) liveBoostTried.add(el);
      diag.liveBoostAttempts += 1;
      var wasPlaying = false;
      try { wasPlaying = !el.paused; } catch (e36) {}
      try {
        if (corsFailed) corsFailed.delete(el);
      } catch (e37) {}
      try { routed.delete(el); } catch (e38) {}
      try { el.crossOrigin = 'anonymous'; } catch (e39) {}
      try { el.src = src; } catch (e40) {}
      try { el.load(); } catch (e41) {}
      if (wasPlaying) {
        try {
          var p = el.play();
          if (p && typeof p.catch === 'function') p.catch(function(){});
        } catch (e42) {}
      }
      var reverted = false;
      var onErr = function() {
        if (reverted) return;
        reverted = true;
        try { el.removeEventListener('error', onErr, true); } catch (e43) {}
        revertCorsUpgrade(el, src, wasPlaying);
      };
      try { el.addEventListener('error', onErr, true); } catch (e44) {}
      setTimeout(function() {
        try { el.removeEventListener('error', onErr, true); } catch (e45) {}
        try { routeMediaElement(el); } catch (e46) {}
      }, 1500);
      return true;
    } catch (e47) {
      return false;
    }
  }

  /**
   * Cross-origin: NUNCA chamar createMediaElementSource antes de saber se CORS
   * funcionou — senão a saída fica muda para sempre (MediaElementSource captura
   * o elemento). Aguarda canplay/loadeddata; em error reverte p/ element.volume.
   */
  function scheduleRouteWhenReady(el) {
    if (!el) return;
    try {
      if (el.__mhVolWaitReady) return;
      el.__mhVolWaitReady = 1;
    } catch (e48a) {
      return;
    }
    var done = false;
    var srcSnap = getSrcString(el);
    var finish = function(ok) {
      if (done) return;
      done = true;
      try { el.__mhVolWaitReady = 0; } catch (e48b) {}
      try { el.removeEventListener('canplay', onOk, true); } catch (e48c) {}
      try { el.removeEventListener('loadeddata', onOk, true); } catch (e48d) {}
      try { el.removeEventListener('error', onErr, true); } catch (e48e) {}
      if (!ok) return;
      try {
        if (routed && routed.has(el)) {
          var pinfo = routed.get(el);
          if (pinfo && pinfo.mode === 'pending') routed.delete(el);
        }
      } catch (e48f) {}
      try { routeMediaElement(el, true); } catch (e48g) {}
    };
    var onOk = function() { finish(true); };
    var onErr = function() {
      try {
        var playing = false;
        try { playing = !el.paused; } catch (e48h) {}
        revertCorsUpgrade(el, srcSnap, playing);
      } catch (e48i) {
        markCorsFailed(el, 'cross-origin-no-cors');
      }
      finish(false);
    };
    try { el.addEventListener('canplay', onOk, true); } catch (e48j) {}
    try { el.addEventListener('loadeddata', onOk, true); } catch (e48k) {}
    try { el.addEventListener('error', onErr, true); } catch (e48l) {}
    var rs = 0;
    try { rs = el.readyState || 0; } catch (e48m) { rs = 0; }
    if (rs >= 2) {
      setTimeout(function() { finish(true); }, 0);
    } else {
      setTimeout(function() {
        if (done) return;
        var rs2 = 0;
        try { rs2 = el.readyState || 0; } catch (e48n) { rs2 = 0; }
        if (rs2 >= 2) finish(true);
      }, 8000);
    }
  }

  function tryGainRoute(el) {
    if (!AC) {
      routed.set(el, { mode: 'element', reason: 'no-ac' });
      diag.mediaElementFallback += 1;
      applyElementVolume(el);
      return;
    }
    try {
      var chain = getSharedChain();
      if (!chain) throw new Error('no-chain');
      resumeCtx(chain.ctx);
      var srcNode = chain.ctx.createMediaElementSource(el);
      if (origConnect) origConnect.call(srcNode, chain.gain);
      else srcNode.connect(chain.gain);
      applyGainElementVolume(el);
      routed.set(el, { mode: 'gain', reason: 'ok' });
      diag.mediaRouted += 1;
      diag.lastMode = 'gain';
      applyChainGain(chain);
    } catch (e48) {
      diag.lastError = String(e48 && e48.message || e48);
      var reason = 'create-failed';
      try {
        if (isCrossOriginHttpSrc(getSrcString(el))) reason = 'cross-origin-no-cors';
      } catch (e49) {}
      if (reason === 'cross-origin-no-cors' && corsFailed) {
        try { corsFailed.add(el); } catch (e49b) {}
      }
      routed.set(el, { mode: 'element', reason: reason });
      diag.mediaElementFallback += 1;
      diag.lastMode = 'element-fallback';
      applyElementVolume(el);
    }
  }

  function routeMediaElement(el, forceReady) {
    if (!el || !routed) return;
    if (routed.has(el)) {
      var info0 = routed.get(el);
      if (info0 && info0.mode === 'pending') {
        applyElementVolume(el);
        if (forceReady) {
          try { routed.delete(el); } catch (e49c) {}
        } else {
          return;
        }
      } else if (info0 && info0.mode === 'element') {
        if (level > 1) tryLiveBoostReload(el);
        applyElementVolume(el);
        return;
      } else if (info0 && info0.mode === 'gain') {
        applyGainElementVolume(el);
        return;
      } else {
        return;
      }
    }
    if (isMediaStreamEl(el)) {
      routed.set(el, { mode: 'element', reason: 'mediastream' });
      diag.mediaStreamSkipped += 1;
      diag.lastMode = 'element-mediastream';
      applyElementVolume(el);
      return;
    }
    if (corsFailed && corsFailed.has(el)) {
      routed.set(el, { mode: 'element', reason: 'cross-origin-no-cors' });
      diag.mediaElementFallback += 1;
      diag.lastMode = 'element-cors';
      applyElementVolume(el);
      return;
    }

    var src = getSrcString(el);
    var xo = isCrossOriginHttpSrc(src);

    // Cross-origin sem atributo CORS: tentar anonymous cedo; se não der, element.
    if (xo && !hasCorsAttr(el)) {
      maybeUpgradeCrossOrigin(el, src);
      if (corsFailed && corsFailed.has(el)) {
        routed.set(el, { mode: 'element', reason: 'cross-origin-no-cors' });
        diag.mediaElementFallback += 1;
        diag.lastMode = 'element-cors';
        applyElementVolume(el);
        return;
      }
      if (!hasCorsAttr(el)) {
        routed.set(el, { mode: 'element', reason: 'cross-origin-no-cors' });
        diag.mediaElementFallback += 1;
        diag.lastMode = 'element-cors';
        applyElementVolume(el);
        return;
      }
    }

    // Cross-origin com CORS attr: só GainNode depois de canplay (evita silêncio).
    if (xo && hasCorsAttr(el) && !forceReady) {
      var rs = 0;
      try { rs = el.readyState || 0; } catch (e49d) { rs = 0; }
      if (rs < 2) {
        routed.set(el, { mode: 'pending', reason: 'await-cors' });
        diag.lastMode = 'pending-cors';
        applyElementVolume(el);
        scheduleRouteWhenReady(el);
        return;
      }
    }

    tryGainRoute(el);
  }

  function scanDocument(root) {
    try {
      var list = (root || document).querySelectorAll('audio,video');
      for (var i = 0; i < list.length; i++) trackElement(list[i]);
    } catch (e50) {}
  }

  function installVolumeInterceptor() {
    try {
      var proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
      if (!proto || proto.__mhVolVolHook) return;
      origVolDesc = Object.getOwnPropertyDescriptor(proto, 'volume');
      if (!origVolDesc) {
        var cur = proto;
        while (cur && !origVolDesc) {
          origVolDesc = Object.getOwnPropertyDescriptor(cur, 'volume');
          cur = Object.getPrototypeOf(cur);
        }
      }
      if (!origVolDesc || !origVolDesc.get || !origVolDesc.set) return;
      origVolGet = origVolDesc.get;
      origVolSet = origVolDesc.set;
      Object.defineProperty(proto, 'volume', {
        configurable: true,
        enumerable: !!origVolDesc.enumerable,
        get: function() {
          try {
            if (pageVolMap && pageVolMap.has(this)) return pageVolMap.get(this);
          } catch (e51) {}
          try { return origVolGet.call(this); } catch (e52) { return 1; }
        },
        set: function(v) {
          if (writingVolume) {
            try { return origVolSet.call(this, v); } catch (e53) { return; }
          }
          trackElement(this);
          var pageV = clamp01(v);
          try { if (pageVolMap) pageVolMap.set(this, pageV); } catch (e54) {}
          try {
            if (routed && routed.has(this)) {
              var info = routed.get(this);
              if (info && info.mode === 'gain') {
                setNativeVolume(this, pageV);
                return;
              }
            }
          } catch (e55) {}
          var eff = pageV * (level > 1 ? 1 : level);
          setNativeVolume(this, eff);
        }
      });
      proto.__mhVolVolHook = 1;
    } catch (e56) {
      diag.lastError = String(e56 && e56.message || e56);
    }
  }

  function installSrcHooks() {
    try {
      var proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
      if (!proto || proto.__mhVolSrcHook) return;

      var srcDesc = Object.getOwnPropertyDescriptor(proto, 'src');
      if (!srcDesc) {
        var cur = proto;
        while (cur && !srcDesc) {
          srcDesc = Object.getOwnPropertyDescriptor(cur, 'src');
          cur = Object.getPrototypeOf(cur);
        }
      }
      if (srcDesc && srcDesc.set) {
        var origSrcSet = srcDesc.set;
        var origSrcGet = srcDesc.get;
        Object.defineProperty(proto, 'src', {
          configurable: true,
          enumerable: !!srcDesc.enumerable,
          get: function() {
            try { return origSrcGet.call(this); } catch (e57) { return ''; }
          },
          set: function(v) {
            trackElement(this);
            try { maybeUpgradeCrossOrigin(this, String(v || '')); } catch (e58) {}
            return origSrcSet.call(this, v);
          }
        });
      }

      var soDesc = Object.getOwnPropertyDescriptor(proto, 'srcObject');
      if (!soDesc) {
        var cur2 = proto;
        while (cur2 && !soDesc) {
          soDesc = Object.getOwnPropertyDescriptor(cur2, 'srcObject');
          cur2 = Object.getPrototypeOf(cur2);
        }
      }
      if (soDesc && soDesc.set) {
        var origSoSet = soDesc.set;
        var origSoGet = soDesc.get;
        Object.defineProperty(proto, 'srcObject', {
          configurable: true,
          enumerable: !!soDesc.enumerable,
          get: function() {
            try { return origSoGet.call(this); } catch (e59) { return null; }
          },
          set: function(v) {
            trackElement(this);
            return origSoSet.call(this, v);
          }
        });
      }

      var origSetAttribute = proto.setAttribute;
      if (typeof origSetAttribute === 'function') {
        proto.setAttribute = function(name, value) {
          try {
            if (String(name).toLowerCase() === 'src') {
              trackElement(this);
              maybeUpgradeCrossOrigin(this, String(value || ''));
            }
          } catch (e60) {}
          return origSetAttribute.apply(this, arguments);
        };
      }

      var origLoad = proto.load;
      if (typeof origLoad === 'function') {
        proto.load = function() {
          try {
            trackElement(this);
            maybeUpgradeCrossOrigin(this, getSrcString(this));
          } catch (e61) {}
          return origLoad.apply(this, arguments);
        };
      }

      var origPlay = proto.play;
      if (typeof origPlay === 'function') {
        proto.play = function() {
          try {
            trackElement(this);
            maybeUpgradeCrossOrigin(this, getSrcString(this));
            routeMediaElement(this);
            if (sharedChain) resumeCtx(sharedChain.ctx);
            else resumeCtx(ensureSharedCtx());
          } catch (e62) {}
          return origPlay.apply(this, arguments);
        };
      }

      proto.__mhVolSrcHook = 1;
      proto.__mhVolPlayHook = 1;
    } catch (e63) {
      diag.lastError = String(e63 && e63.message || e63);
    }
  }

  function observeRoot(root) {
    if (!root || typeof MutationObserver === 'undefined') return;
    try {
      var mo = new MutationObserver(function(muts) {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (!m.addedNodes) continue;
          for (var j = 0; j < m.addedNodes.length; j++) {
            var n = m.addedNodes[j];
            if (!n) continue;
            if (n.tagName === 'AUDIO' || n.tagName === 'VIDEO') trackElement(n);
            else if (n.querySelectorAll) {
              try {
                var inner = n.querySelectorAll('audio,video');
                for (var k = 0; k < inner.length; k++) trackElement(inner[k]);
              } catch (e64) {}
            }
          }
        }
      });
      mo.observe(root, { childList: true, subtree: true });
    } catch (e65) {}
  }

  function installMediaHooks() {
    installVolumeInterceptor();
    installSrcHooks();
    try {
      if (document && document.documentElement) observeRoot(document.documentElement);
    } catch (e65b) {}
    try {
      var origAttach = Element.prototype.attachShadow;
      if (typeof origAttach === 'function' && !Element.prototype.__mhVolShadowHook) {
        Element.prototype.attachShadow = function() {
          var root = origAttach.apply(this, arguments);
          try { observeRoot(root); scanDocument(root); } catch (e65c) {}
          return root;
        };
        Element.prototype.__mhVolShadowHook = 1;
      }
    } catch (e65d) {}
    scanDocument(document);
  }

  function installWebAudioHook() {
    if (!AC || hookConnectInstalled) return;
    try {
      origConnect = AudioNode.prototype.connect;
      if (typeof origConnect !== 'function') return;
      AudioNode.prototype.connect = function(dest) {
        try {
          if (dest && this && this.context && dest === this.context.destination) {
            var chain = getCtxChain(this.context);
            if (chain && chain.gain && this !== chain.gain && this !== chain.compressor && !(chain.testAnalyser && this === chain.testAnalyser)) {
              diag.webaudioRouted += 1;
              diag.lastMode = 'webaudio';
              applyChainGain(chain);
              resumeCtx(this.context);
              return origConnect.call(this, chain.gain);
            }
          }
        } catch (e66) {}
        return origConnect.apply(this, arguments);
      };
      hookConnectInstalled = true;
    } catch (e67) {
      diag.lastError = String(e67 && e67.message || e67);
    }
  }

  function applyTrackedLevels() {
    var els = listTrackedElements();
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      try {
        if (!routed || !routed.has(el)) {
          var paused = true;
          try { paused = !!el.paused; } catch (e68) { paused = true; }
          if (!paused) routeMediaElement(el);
          else applyElementVolume(el);
          continue;
        }
        var info = routed.get(el);
        if (info && info.mode === 'pending') {
          applyElementVolume(el);
        } else if (info && info.mode === 'element') {
          if (level > 1) tryLiveBoostReload(el);
          applyElementVolume(el);
        } else if (info && info.mode === 'gain') {
          applyGainElementVolume(el);
        }
      } catch (e69) {}
    }
    try {
      var domList = document.querySelectorAll('audio,video');
      for (var j = 0; j < domList.length; j++) {
        trackElement(domList[j]);
        if (!routed || !routed.has(domList[j])) {
          try {
            if (!domList[j].paused) routeMediaElement(domList[j]);
          } catch (e70) {}
        }
      }
    } catch (e71) {}
  }

  function computeBoostUnavailable() {
    if (!(level > 1)) return false;
    var els = listTrackedElements();
    var sawPlaying = false;
    var sawElementPlaying = false;
    var sawCorsElement = false;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      try {
        var info = routed && routed.get(el);
        var paused = true;
        try { paused = !!el.paused; } catch (e72a) { paused = true; }
        if (info && info.mode === 'element' &&
            (info.reason === 'cross-origin-no-cors' || info.reason === 'cross-origin')) {
          sawCorsElement = true;
        }
        if (!paused) {
          sawPlaying = true;
          if (info && (info.mode === 'element' || info.mode === 'pending')) sawElementPlaying = true;
        }
      } catch (e72) {}
    }
    if (sawElementPlaying) return true;
    // CORS-element sem boost, mesmo se pausou tras falha de reload
    if (sawCorsElement && !sawPlaying) return true;
    return false;
  }

  function elementDiagList() {
    var els = listTrackedElements();
    var out = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      try {
        var info = routed && routed.get(el);
        var eff = null;
        try {
          writingVolume = true;
          eff = origVolGet ? origVolGet.call(el) : el.volume;
        } catch (e73) {
          eff = null;
        } finally {
          writingVolume = false;
        }
        out.push({
          mode: info ? info.mode : '',
          reason: info ? info.reason : '',
          paused: !!el.paused,
          pageVolume: getPageVolume(el),
          effectiveVolume: eff,
          tag: el.tagName || '',
          detached: !(el.isConnected)
        });
      } catch (e74) {}
    }
    return out;
  }

  function setLevel(v) {
    level = clampLevel(v);
    applyAllGains();
    applyTrackedLevels();
    return level;
  }

  installWebAudioHook();
  installMediaHooks();

  try {
    Object.defineProperty(window, '__mhVol', {
      value: {
        set: setLevel,
        get: function() { return level; },
        getDiag: function() {
          return {
            level: level,
            mediaRouted: diag.mediaRouted,
            mediaElementFallback: diag.mediaElementFallback,
            mediaStreamSkipped: diag.mediaStreamSkipped,
            webaudioRouted: diag.webaudioRouted,
            lastMode: diag.lastMode,
            lastError: diag.lastError,
            hasSharedCtx: !!sharedCtx,
            sharedGain: sharedChain && sharedChain.gain ? sharedChain.gain.gain.value : null,
            chainCount: allChains.length,
            trackedCount: listTrackedElements().length,
            corsUpgrades: diag.corsUpgrades,
            corsReverts: diag.corsReverts,
            liveBoostAttempts: diag.liveBoostAttempts,
            boostUnavailable: computeBoostUnavailable(),
            elements: elementDiagList()
          };
        },
        enableTestTap: enableTestTap,
        measureTestRms: measureTestRms
      },
      writable: false,
      configurable: false,
      enumerable: false
    });
  } catch (e75) {
    window.__mhVol = {
      set: setLevel,
      get: function() { return level; },
      getDiag: function() {
        return {
          level: level,
          boostUnavailable: computeBoostUnavailable(),
          elements: elementDiagList(),
          mediaRouted: diag.mediaRouted,
          mediaElementFallback: diag.mediaElementFallback,
          lastMode: diag.lastMode
        };
      },
      enableTestTap: enableTestTap,
      measureTestRms: measureTestRms
    };
  }
})();`;
}

module.exports = {
  getVolumeInjectSource,
};
