'use strict';

/**
 * Contador de mensagens não lidas por janela (1.3.0).
 *
 * Fonte: page-title-updated / page-favicon-updated / did-navigate (sem polling).
 * Favicon: sinal fraco SOMENTE para ponto (sem número), e só se a URL do favicon
 * contiver marca conhecida (unread / badge / notification) — conservador.
 *
 * Overlay do SO: Windows setOverlayIcon (PNG gerado sem deps); Linux/macOS
 * app.setBadgeCount (try/catch). Atualiza só quando o total muda.
 */

const zlib = require('node:zlib');
const { app, nativeImage } = require('electron');

/** @type {Map<string, { count: number|null, dot: boolean, fromFavicon?: boolean }>} */
const unreadByAccount = new Map();

/** @type {(() => import('electron').BrowserWindow|null)|null} */
let getMainWindow = null;
/** @type {(() => object)|null} */
let getState = null;
/** @type {((payload: object) => void)|null} */
let emitToRenderer = null;

/** @type {string} */
let lastOsKey = '';

/** Selftest spies (MULTIHEIZ_SELFTEST=badges). */
/** @type {Array<{ at: number, api: string, arg: unknown }>} */
let osBadgeSpies = [];

/**
 * Parser puro do título da página.
 * @param {string} title
 * @returns {{ count: number|null, dot: boolean }}
 */
function parseUnreadFromTitle(title) {
  const t = String(title || '').trim();
  if (!t) return { count: null, dot: false };

  const countPatterns = [
    /^\((\d+)\+?\)/,
    /\b(?:Inbox|Caixa de entrada)\s*\((\d+)\+?\)/i,
    /\((\d+)\+\)/,
    /\((\d+)\)/,
    /\b(\d+)\s*(?:new|novas?|nova)\b/i,
  ];
  for (const re of countPatterns) {
    const m = t.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 0) {
        return { count: n, dot: false };
      }
    }
  }

  // Discord e similares: • / (•) = não lidas sem número
  if (
    /^[•●]\s/.test(t) ||
    /^[•●]$/.test(t) ||
    /^\(\s*[•●]\s*\)/.test(t) ||
    /\(\s*[•●]\s*\)/.test(t)
  ) {
    return { count: null, dot: true };
  }

  return { count: null, dot: false };
}

/**
 * Favicon sugere não lidas? Conservador: só URL com unread/badge/notification.
 * @param {string} faviconUrl
 * @returns {boolean}
 */
function faviconSuggestsUnread(faviconUrl) {
  const u = String(faviconUrl || '').toLowerCase();
  if (!u || u.startsWith('data:')) return false;
  return /unread|badge|notification/.test(u);
}

/**
 * Texto do badge (99+ a partir de 99).
 * @param {number} count
 * @returns {string}
 */
function formatUnreadBadgeText(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n >= 99) return '99+';
  return String(n);
}

/**
 * Conta ativa para UI/total? Default ligado.
 * @param {object|null|undefined} account
 * @returns {boolean}
 */
function accountShowsUnread(account) {
  if (!account) return false;
  return account.showUnread !== false;
}

/**
 * @param {{ count: number|null, dot: boolean }|null|undefined} u
 * @returns {boolean}
 */
function hasUnreadSignal(u) {
  if (!u) return false;
  if (typeof u.count === 'number' && u.count > 0) return true;
  return !!u.dot;
}

/**
 * Total agregado (só janelas com contador ligado).
 * @returns {{ sum: number, dotOnly: boolean, any: boolean }}
 */
function computeUnreadTotal() {
  const st = getState ? getState() : { accounts: [] };
  const accounts = Array.isArray(st.accounts) ? st.accounts : [];
  let sum = 0;
  let anyDot = false;
  let anyCount = false;
  for (const acc of accounts) {
    if (!accountShowsUnread(acc)) continue;
    const u = unreadByAccount.get(acc.id);
    if (!u) continue;
    if (typeof u.count === 'number' && u.count > 0) {
      sum += u.count;
      anyCount = true;
    } else if (u.dot) {
      anyDot = true;
    }
  }
  return {
    sum,
    dotOnly: !anyCount && anyDot,
    any: anyCount || anyDot,
  };
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * PNG RGBA sem dependências.
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba
 * @returns {Buffer}
 */
function createPngRGBA(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Fonte 3×5 para dígitos e '+' (bits, MSB = esquerda). */
const FONT_3X5 = {
  0: [0b111, 0b101, 0b101, 0b101, 0b111],
  1: [0b010, 0b110, 0b010, 0b010, 0b111],
  2: [0b111, 0b001, 0b111, 0b100, 0b111],
  3: [0b111, 0b001, 0b111, 0b001, 0b111],
  4: [0b101, 0b101, 0b111, 0b001, 0b001],
  5: [0b111, 0b100, 0b111, 0b001, 0b111],
  6: [0b111, 0b100, 0b111, 0b101, 0b111],
  7: [0b111, 0b001, 0b001, 0b001, 0b001],
  8: [0b111, 0b101, 0b111, 0b101, 0b111],
  9: [0b111, 0b101, 0b111, 0b001, 0b111],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000],
  '•': [0b000, 0b010, 0b010, 0b010, 0b000],
};

/**
 * @param {string} label  ex. "3", "99+", "•"
 * @returns {import('electron').NativeImage}
 */
function createUnreadOverlayImage(label) {
  const size = 32;
  const rgba = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = 14;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        rgba[i] = 220;
        rgba[i + 1] = 53;
        rgba[i + 2] = 69;
        rgba[i + 3] = 255;
      }
    }
  }

  const text = String(label || '•');
  const chars = text === '•' ? ['•'] : text.split('');
  const scale = chars.length >= 3 ? 1 : 2;
  const glyphW = 3 * scale;
  const glyphH = 5 * scale;
  const gap = scale;
  const totalW = chars.length * glyphW + (chars.length - 1) * gap;
  let ox = Math.floor((size - totalW) / 2);
  const oy = Math.floor((size - glyphH) / 2);
  for (const ch of chars) {
    const key = ch === '+' ? '+' : ch === '•' ? '•' : ch;
    const rows = FONT_3X5[key] || FONT_3X5['•'];
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (!(rows[gy] & (1 << (2 - gx)))) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = ox + gx * scale + sx;
            const py = oy + gy * scale + sy;
            if (px < 0 || py < 0 || px >= size || py >= size) continue;
            const i = (py * size + px) * 4;
            rgba[i] = 255;
            rgba[i + 1] = 255;
            rgba[i + 2] = 255;
            rgba[i + 3] = 255;
          }
        }
      }
    }
    ox += glyphW + gap;
  }

  const png = createPngRGBA(size, size, rgba);
  return nativeImage.createFromBuffer(png);
}

/** @type {Map<string, import('electron').NativeImage>} */
const overlayImageCache = new Map();

function overlayImageForLabel(label) {
  const key = String(label || '•');
  let img = overlayImageCache.get(key);
  if (!img || img.isEmpty()) {
    img = createUnreadOverlayImage(key);
    overlayImageCache.set(key, img);
  }
  return img;
}

function noteOsSpy(api, arg) {
  if (String(process.env.MULTIHEIZ_SELFTEST || '') !== 'badges') return;
  osBadgeSpies.push({ at: Date.now(), api, arg });
}

/**
 * Aplica overlay/badge do SO (só se o total mudou).
 */
function refreshOsBadge() {
  const total = computeUnreadTotal();
  let key = '0';
  let description = '';
  /** @type {string|null} */
  let overlayLabel = null;

  if (!total.any) {
    key = '0';
  } else if (total.dotOnly) {
    key = 'dot';
    overlayLabel = '•';
    description = 'Mensagens não lidas';
  } else {
    const n = total.sum;
    key = 'n:' + n;
    overlayLabel = formatUnreadBadgeText(n);
    description =
      n === 1 ? '1 mensagem não lida' : `${formatUnreadBadgeText(n)} mensagens não lidas`;
  }

  if (key === lastOsKey) return;
  lastOsKey = key;

  const win = getMainWindow && getMainWindow();
  if (process.platform === 'win32') {
    try {
      if (!win || win.isDestroyed()) {
        /* skip */
      } else if (!overlayLabel) {
        win.setOverlayIcon(null, '');
        noteOsSpy('setOverlayIcon', null);
      } else {
        const img = overlayImageForLabel(overlayLabel);
        win.setOverlayIcon(img, description);
        noteOsSpy('setOverlayIcon', overlayLabel);
      }
    } catch {
      /* ignore */
    }
  }

  // Linux/macOS: número via setBadgeCount. Só pontos → 0 (API não tem “ponto”;
  // no Windows o overlay • cobre o caso).
  try {
    if (typeof app.setBadgeCount === 'function') {
      const n = total.any && !total.dotOnly ? Math.min(total.sum, 99) : 0;
      app.setBadgeCount(n);
      noteOsSpy('setBadgeCount', n);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Emite estado ao renderer + atualiza SO.
 * @param {string} accountId
 */
function emitUnread(accountId) {
  const u = unreadByAccount.get(accountId) || { count: null, dot: false };
  if (emitToRenderer) {
    emitToRenderer({
      type: 'panel:unread',
      accountId,
      count: typeof u.count === 'number' ? u.count : null,
      dot: !!u.dot,
    });
  }
  refreshOsBadge();
}

/**
 * @param {string} accountId
 * @param {{ count: number|null, dot: boolean, fromFavicon?: boolean }} next
 */
function setUnreadState(accountId, next) {
  const id = String(accountId || '');
  if (!id) return;
  const prev = unreadByAccount.get(id);
  const count = typeof next.count === 'number' && next.count > 0 ? next.count : null;
  const dot = !count && !!next.dot;
  const fromFavicon = !!next.fromFavicon && dot;
  if (!count && !dot) {
    if (!prev) {
      refreshOsBadge();
      return;
    }
    unreadByAccount.delete(id);
    emitUnread(id);
    return;
  }
  const same =
    prev &&
    prev.count === count &&
    !!prev.dot === dot &&
    !!prev.fromFavicon === fromFavicon;
  if (same) return;
  unreadByAccount.set(id, { count, dot, fromFavicon });
  emitUnread(id);
}

/**
 * @param {string} accountId
 * @param {string} title
 */
function handleTitleUpdated(accountId, title) {
  const parsed = parseUnreadFromTitle(title);
  setUnreadState(accountId, { ...parsed, fromFavicon: false });
}

/**
 * @param {string} accountId
 * @param {string[]|string} favicons
 */
function handleFaviconUpdated(accountId, favicons) {
  const id = String(accountId || '');
  if (!id) return;
  const list = Array.isArray(favicons) ? favicons : favicons ? [favicons] : [];
  const url = list.length ? String(list[0] || '') : '';
  const prev = unreadByAccount.get(id);
  // Título já indica contagem ou ponto → favicon não sobrescreve.
  if (prev && !prev.fromFavicon && hasUnreadSignal(prev)) return;
  if (faviconSuggestsUnread(url)) {
    setUnreadState(id, { count: null, dot: true, fromFavicon: true });
  } else if (prev && prev.fromFavicon) {
    setUnreadState(id, { count: null, dot: false });
  }
}

/**
 * Navegação: reavalia o título atual; zera sinal fraco de favicon até novo evento.
 * @param {string} accountId
 * @param {string} [title]
 */
function handleDidNavigate(accountId, title) {
  const parsed = parseUnreadFromTitle(title || '');
  setUnreadState(accountId, { ...parsed, fromFavicon: false });
}

/**
 * Remove contagem da janela (exclusão / área).
 * @param {string} accountId
 */
function clearAccount(accountId) {
  const id = String(accountId || '');
  if (!id) return;
  if (!unreadByAccount.has(id)) {
    refreshOsBadge();
    return;
  }
  unreadByAccount.delete(id);
  emitUnread(id);
}

/** Contador desligado ou estado mudou: recalcula total do SO. */
function refreshAfterAccountChange() {
  refreshOsBadge();
}

/**
 * @param {string} accountId
 * @returns {{ count: number|null, dot: boolean }|null}
 */
function getUnread(accountId) {
  const u = unreadByAccount.get(String(accountId || ''));
  if (!u) return null;
  return { count: u.count, dot: !!u.dot };
}

function getOsBadgeSpies() {
  return osBadgeSpies.slice();
}

function clearOsBadgeSpies() {
  osBadgeSpies = [];
}

/**
 * @param {{
 *   getMainWindow: () => import('electron').BrowserWindow|null,
 *   getState: () => object,
 *   emitToRenderer: (payload: object) => void,
 * }} opts
 */
function initUnread(opts) {
  getMainWindow = opts.getMainWindow;
  getState = opts.getState;
  emitToRenderer = opts.emitToRenderer;
  lastOsKey = '';
  unreadByAccount.clear();
}

module.exports = {
  parseUnreadFromTitle,
  faviconSuggestsUnread,
  formatUnreadBadgeText,
  accountShowsUnread,
  computeUnreadTotal,
  createUnreadOverlayImage,
  initUnread,
  handleTitleUpdated,
  handleFaviconUpdated,
  handleDidNavigate,
  clearAccount,
  refreshAfterAccountChange,
  refreshOsBadge,
  getUnread,
  getOsBadgeSpies,
  clearOsBadgeSpies,
};
