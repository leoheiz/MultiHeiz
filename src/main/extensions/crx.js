'use strict';

/**
 * CRX2 / CRX3 unpack (header strip + zip extract).
 * Does not verify publisher signatures — for local/user install only.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const CRX_MAGIC = Buffer.from('Cr24');

/** Zip-slip / zip-bomb limits for CRX unpack (unsigned CRX still accepted in phase 1). */
const MAX_ZIP_ENTRIES = 20_000;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
/** Unix S_IFMT / S_IFLNK in external attributes (high 16 bits). */
const UNIX_S_IFMT = 0o170000;
const UNIX_S_IFLNK = 0o120000;

/**
 * @param {number} attr
 */
function isZipSymlinkAttr(attr) {
  const mode = (Number(attr) >>> 16) & 0xffff;
  return (mode & UNIX_S_IFMT) === UNIX_S_IFLNK;
}

/**
 * Resolve a zip entry path under destDir; rejects absolutes, drives, .., and escapes.
 * @param {string} entryName
 * @param {string} destDir
 * @returns {{ target: string, isDir: boolean }}
 */
function resolveSafeZipTarget(entryName, destDir) {
  const raw = String(entryName || '');
  if (!raw || raw.includes('\0')) {
    throw new Error('Entrada ZIP inválida');
  }
  const normalized = raw.replace(/\\/g, '/');
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.startsWith('/') ||
    normalized.startsWith('\\')
  ) {
    throw new Error('Entrada ZIP com caminho absoluto rejeitada: ' + raw);
  }
  const parts = normalized.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new Error('Entrada ZIP com .. rejeitada: ' + raw);
  }
  const destRoot = path.resolve(destDir);
  const target = parts.length ? path.resolve(destRoot, ...parts) : destRoot;
  const rel = path.relative(destRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Entrada ZIP fora do destino: ' + raw);
  }
  return { target, isDir: normalized.endsWith('/') };
}

/**
 * Extract zip buffer entry-by-entry with zip-slip / symlink / size guards.
 * @param {Buffer} zipBuf
 * @param {string} destDir
 * @returns {number} entry count
 */
function extractZipSafely(zipBuf, destDir) {
  const adm = new AdmZip(zipBuf);
  const entries = adm.getEntries();
  if (!entries.length) throw new Error('ZIP do CRX está vazio');
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error('ZIP do CRX excede limite de entradas (' + MAX_ZIP_ENTRIES + ')');
  }
  fs.mkdirSync(destDir, { recursive: true });
  let totalBytes = 0;
  for (const entry of entries) {
    if (isZipSymlinkAttr(entry.attr)) {
      throw new Error('Entrada ZIP symlink rejeitada: ' + entry.entryName);
    }
    const { target, isDir } = resolveSafeZipTarget(entry.entryName, destDir);
    if (entry.isDirectory || isDir) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    const data = entry.getData();
    totalBytes += data.length;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('ZIP do CRX excede limite de tamanho (512 MB)');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  return entries.length;
}

/**
 * @param {Buffer} buf
 * @returns {{ version: number, zip: Buffer }}
 */
function stripCrxHeader(buf) {
  if (!buf || buf.length < 16) {
    throw new Error('Arquivo CRX muito pequeno');
  }
  // Some downloads are already zip
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    return { version: 0, zip: buf };
  }
  if (buf.subarray(0, 4).compare(CRX_MAGIC) !== 0) {
    throw new Error('Não é um arquivo CRX (magic Cr24 ausente)');
  }
  const version = buf.readUInt32LE(4);
  if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    const zipStart = 16 + pubKeyLen + sigLen;
    if (zipStart >= buf.length) throw new Error('CRX2 header inválido');
    return { version: 2, zip: buf.subarray(zipStart) };
  }
  if (version === 3) {
    const headerSize = buf.readUInt32LE(8);
    const zipStart = 12 + headerSize;
    if (zipStart >= buf.length) throw new Error('CRX3 header inválido');
    return { version: 3, zip: buf.subarray(zipStart) };
  }
  throw new Error('Versão CRX não suportada: ' + version);
}

/**
 * Stable 32-char chrome-like id from bytes (a–p alphabet).
 * @param {Buffer} data
 */
function idFromBytes(data) {
  const hash = crypto.createHash('sha256').update(data).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0xf));
  }
  return id;
}

/**
 * Chrome extension id from SPKI/DER public key in manifest.key (base64).
 * @param {string} keyB64
 */
function idFromManifestKey(keyB64) {
  const der = Buffer.from(String(keyB64).replace(/\s+/g, ''), 'base64');
  return idFromBytes(der);
}

/**
 * Unpack CRX or zip buffer into destDir (must not exist or be empty).
 * @param {Buffer} buf
 * @param {string} destDir
 * @returns {{ crxVersion: number, files: number }}
 */
function unpackCrxToDir(buf, destDir) {
  const { version, zip } = stripCrxHeader(buf);
  if (zip[0] !== 0x50 || zip[1] !== 0x4b) {
    throw new Error('Payload CRX não é um ZIP válido');
  }
  const files = extractZipSafely(zip, destDir);
  const manifestPath = path.join(destDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    // Some CRXs nest a single root folder
    const kids = fs.readdirSync(destDir).filter((n) => !n.startsWith('.'));
    if (kids.length === 1) {
      const nested = path.join(destDir, kids[0]);
      if (fs.statSync(nested).isDirectory() && fs.existsSync(path.join(nested, 'manifest.json'))) {
        const tmp = destDir + '.nested-tmp';
        fs.renameSync(nested, tmp);
        for (const n of fs.readdirSync(destDir)) {
          fs.rmSync(path.join(destDir, n), { recursive: true, force: true });
        }
        for (const n of fs.readdirSync(tmp)) {
          fs.renameSync(path.join(tmp, n), path.join(destDir, n));
        }
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
  if (!fs.existsSync(path.join(destDir, 'manifest.json'))) {
    throw new Error('manifest.json não encontrado após unpack');
  }
  return { crxVersion: version, files };
}

/**
 * Build a minimal unsigned CRX3 (empty header) around a directory — for tests only.
 * @param {string} dir
 * @param {string} outPath
 */
function packDirAsCrx3(dir, outPath) {
  const zip = new AdmZip();
  zip.addLocalFolder(dir);
  const zipBuf = zip.toBuffer();
  const header = Buffer.alloc(0);
  const out = Buffer.alloc(12 + header.length + zipBuf.length);
  CRX_MAGIC.copy(out, 0);
  out.writeUInt32LE(3, 4);
  out.writeUInt32LE(header.length, 8);
  zipBuf.copy(out, 12);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out);
  return outPath;
}

module.exports = {
  stripCrxHeader,
  unpackCrxToDir,
  packDirAsCrx3,
  idFromBytes,
  idFromManifestKey,
};
