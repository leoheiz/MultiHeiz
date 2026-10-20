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
  var origConnect = null;
  var hookConnectInstalled = false;
  var diag = {
    mediaRouted: 0,
    mediaElementFallback: 0,
    mediaStreamSkipped: 0,
    webaudioRouted: 0,
    lastMode: '',
    lastError: ''
  };

  function clampLevel(v) {
    var n = Number(v);
    if (!isFinite(n)) return 1;
    if (n < 0) return 0;
    if (n > 2) return 2;
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

  function isMediaStreamEl(el) {
    try {
      if (!el || !el.srcObject) return false;
      if (typeof MediaStream !== 'undefined' && el.srcObject instanceof MediaStream) return true;
    } catch (e5) {}
    return false;
  }

  function isLikelyCrossOriginNoCors(el) {
    try {
      if (isMediaStreamEl(el)) return false;
      var src = '';
      try { src = el.currentSrc || el.src || ''; } catch (e6) { src = ''; }
      if (!src || src.indexOf('blob:') === 0 || src.indexOf('data:') === 0 || src.indexOf('mediastream:') === 0) {
        return false;
      }
      var u = new URL(src, location.href);
      if (u.origin === location.origin) return false;
      var co = el.crossOrigin;
      if (co === 'anonymous' || co === 'use-credentials') return false;
      return true;
    } catch (e7) {
      return true;
    }
  }

  function applyElementVolume(el) {
    try {
      var v = level > 1 ? 1 : level;
      el.volume = v;
    } catch (e8) {}
  }

  function routeMediaElement(el) {
    if (!el || !routed) return;
    if (routed.has(el)) {
      var info0 = routed.get(el);
      if (info0 && info0.mode === 'element') applyElementVolume(el);
      return;
    }
    if (isMediaStreamEl(el)) {
      routed.set(el, { mode: 'element', reason: 'mediastream' });
      diag.mediaStreamSkipped += 1;
      diag.lastMode = 'element-mediastream';
      applyElementVolume(el);
      return;
    }
    if (isLikelyCrossOriginNoCors(el)) {
      routed.set(el, { mode: 'element', reason: 'cross-origin' });
      diag.mediaElementFallback += 1;
      diag.lastMode = 'element-cors';
      applyElementVolume(el);
      return;
    }
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
      try { el.volume = 1; } catch (e9) {}
      routed.set(el, { mode: 'gain', reason: 'ok' });
      diag.mediaRouted += 1;
      diag.lastMode = 'gain';
      applyChainGain(chain);
    } catch (e10) {
      diag.lastError = String(e10 && e10.message || e10);
      routed.set(el, { mode: 'element', reason: 'create-failed' });
      diag.mediaElementFallback += 1;
      diag.lastMode = 'element-fallback';
      applyElementVolume(el);
    }
  }

  function watchElement(el) {
    if (!el) return;
    if (seenEls) {
      if (seenEls.has(el)) return;
      seenEls.add(el);
    }
    var onPlay = function() {
      routeMediaElement(el);
      var chain = sharedChain;
      if (chain) resumeCtx(chain.ctx);
    };
    try {
      el.addEventListener('play', onPlay, true);
      el.addEventListener('playing', onPlay, true);
    } catch (e11) {}
    try {
      if (!el.paused) onPlay();
    } catch (e12) {}
  }

  function scanDocument(root) {
    try {
      var list = (root || document).querySelectorAll('audio,video');
      for (var i = 0; i < list.length; i++) watchElement(list[i]);
    } catch (e13) {}
  }

  function installMediaHooks() {
    try {
      var proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
      if (proto && !proto.__mhVolPlayHook) {
        var origPlay = proto.play;
        if (typeof origPlay === 'function') {
          proto.play = function() {
            try { watchElement(this); routeMediaElement(this); } catch (e14) {}
            return origPlay.apply(this, arguments);
          };
          proto.__mhVolPlayHook = 1;
        }
      }
    } catch (e15) {}
    try {
      if (typeof MutationObserver !== 'undefined' && document && document.documentElement) {
        var mo = new MutationObserver(function(muts) {
          for (var i = 0; i < muts.length; i++) {
            var m = muts[i];
            if (!m.addedNodes) continue;
            for (var j = 0; j < m.addedNodes.length; j++) {
              var n = m.addedNodes[j];
              if (!n) continue;
              if (n.tagName === 'AUDIO' || n.tagName === 'VIDEO') watchElement(n);
              else if (n.querySelectorAll) {
                try {
                  var inner = n.querySelectorAll('audio,video');
                  for (var k = 0; k < inner.length; k++) watchElement(inner[k]);
                } catch (e16) {}
              }
            }
          }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
      }
    } catch (e17) {}
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
            if (chain && chain.gain && this !== chain.gain && this !== chain.compressor) {
              diag.webaudioRouted += 1;
              diag.lastMode = 'webaudio';
              applyChainGain(chain);
              resumeCtx(this.context);
              return origConnect.call(this, chain.gain);
            }
          }
        } catch (e18) {}
        return origConnect.apply(this, arguments);
      };
      hookConnectInstalled = true;
    } catch (e19) {
      diag.lastError = String(e19 && e19.message || e19);
    }
  }

  function setLevel(v) {
    level = clampLevel(v);
    applyAllGains();
    try {
      var list = document.querySelectorAll('audio,video');
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!routed || !routed.has(el)) {
          if (!el.paused) routeMediaElement(el);
          continue;
        }
        var info = routed.get(el);
        if (info && info.mode === 'element') applyElementVolume(el);
        else if (info && info.mode === 'gain') {
          try { el.volume = 1; } catch (e20) {}
        }
      }
    } catch (e21) {}
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
            chainCount: allChains.length
          };
        }
      },
      writable: false,
      configurable: false,
      enumerable: false
    });
  } catch (e22) {
    window.__mhVol = {
      set: setLevel,
      get: function() { return level; },
      getDiag: function() { return diag; }
    };
  }
})();`;
}

module.exports = {
  getVolumeInjectSource,
};
