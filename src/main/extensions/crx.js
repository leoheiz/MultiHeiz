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
  fs.mkdirSync(destDir, { recursive: true });
  const adm = new AdmZip(zip);
  const entries = adm.getEntries();
  if (!entries.length) throw new Error('ZIP do CRX está vazio');
  adm.extractAllTo(destDir, true);
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
  return { crxVersion: version, files: entries.length };
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
