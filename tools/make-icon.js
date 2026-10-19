'use strict';

/**
 * Gera um icone original MultiHeiz (PNG 256 + ICO simples) sem dependencias.
 * Motivo visual: "M" em paineis — azul/teal sobre fundo escuro.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const OUT_DIR = path.join(__dirname, '..', 'build');
const ICONS_DIR = path.join(OUT_DIR, 'icons');
/** Tamanhos Linux (electron-builder: NxN.png em build/icons). */
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

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
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

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

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function paintIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const nx = x / (size - 1);
      const ny = y / (size - 1);
      // fundo gradiente escuro
      rgba[i] = lerp(22, 36, nx * 0.4 + ny * 0.6);
      rgba[i + 1] = lerp(26, 48, ny);
      rgba[i + 2] = lerp(34, 58, nx);
      rgba[i + 3] = 255;

      // moldura arredondada
      const m = 0.08;
      const inside = nx > m && nx < 1 - m && ny > m && ny < 1 - m;
      if (!inside) continue;

      // três “painéis” verticais
      const gap = 0.04;
      const panelW = (1 - 2 * m - 2 * gap) / 3;
      for (let p = 0; p < 3; p++) {
        const x0 = m + p * (panelW + gap);
        const x1 = x0 + panelW;
        if (nx >= x0 && nx <= x1 && ny > m + 0.1 && ny < 1 - m - 0.08) {
          const colors = [
            [61, 139, 253],
            [32, 201, 151],
            [253, 126, 20],
          ];
          const c = colors[p];
          const shade = 0.75 + 0.25 * (1 - ny);
          rgba[i] = Math.min(255, Math.round(c[0] * shade));
          rgba[i + 1] = Math.min(255, Math.round(c[1] * shade));
          rgba[i + 2] = Math.min(255, Math.round(c[2] * shade));
        }
      }

      // letra "M" central clara
      const cx = 0.5;
      const bar = 0.055;
      const midY0 = 0.30;
      const midY1 = 0.70;
      const leftX = cx - 0.16;
      const rightX = cx + 0.16;
      const onLeft = Math.abs(nx - leftX) < bar && ny > midY0 && ny < midY1;
      const onRight = Math.abs(nx - rightX) < bar && ny > midY0 && ny < midY1;
      // diagonais do M (v)
      const t = (ny - midY0) / (0.5 - midY0);
      const onDiagL =
        ny >= midY0 &&
        ny <= 0.52 &&
        Math.abs(nx - (leftX + t * (cx - leftX))) < bar * 0.95;
      const onDiagR =
        ny >= midY0 &&
        ny <= 0.52 &&
        Math.abs(nx - (rightX - t * (rightX - cx))) < bar * 0.95;
      if (onLeft || onRight || onDiagL || onDiagR) {
        rgba[i] = 245;
        rgba[i + 1] = 248;
        rgba[i + 2] = 255;
      }
    }
  }
  return rgba;
}

function createIco(pngBuf) {
  // ICO com um PNG embutido (Vista+)
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuf]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(ICONS_DIR, { recursive: true });

const rgba = paintIcon(SIZE);
const png = createPngRGBA(SIZE, SIZE, rgba);
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), createIco(png));

for (const n of LINUX_SIZES) {
  const rgbaN = n === SIZE ? rgba : paintIcon(n);
  const pngN = n === SIZE ? png : createPngRGBA(n, n, rgbaN);
  fs.writeFileSync(path.join(ICONS_DIR, `${n}x${n}.png`), pngN);
}

console.log(
  'Ícones gerados em build/icon.png, build/icon.ico e build/icons/{16..512}x{16..512}.png'
);
