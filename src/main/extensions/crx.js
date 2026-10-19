'use strict';

/**
 * CRX3 unpack with signature verification + safe zip extract.
 * CRX2 and unsigned CRX are rejected. Unpacked-folder installs stay separate.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const CRX_MAGIC = Buffer.from('Cr24');
const CRX3_SIGNED_PREFIX = Buffer.from('CRX3 SignedData\x00', 'utf8');

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
 * @param {number} value
 * @returns {Buffer}
 */
function encodeVarint(value) {
  const bytes = [];
  let remaining = value >>> 0;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

/**
 * @param {number} fieldNumber
 * @param {Buffer} value
 */
function encodeBytesField(fieldNumber, value) {
  return Buffer.concat([
    encodeVarint((fieldNumber << 3) | 2),
    encodeVarint(value.length),
    value,
  ]);
}

/**
 * Minimal protobuf reader for length-delimited (and skip other) fields.
 * @param {Buffer} buf
 * @returns {Map<number, Buffer[]>}
 */
function parseProtobufFields(buf) {
  /** @type {Map<number, Buffer[]>} */
  const fields = new Map();
  let i = 0;
  while (i < buf.length) {
    let tag = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) throw new Error('Cabeçalho CRX3 protobuf truncado');
      const b = buf[i++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 35) throw new Error('Tag protobuf inválida no CRX3');
    }
    const fieldNumber = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 2) {
      let len = 0;
      shift = 0;
      for (;;) {
        if (i >= buf.length) throw new Error('Comprimento protobuf truncado');
        const b = buf[i++];
        len |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
        if (shift > 35) throw new Error('Comprimento protobuf inválido');
      }
      if (len < 0 || i + len > buf.length) {
        throw new Error('Campo protobuf fora dos limites');
      }
      const value = buf.subarray(i, i + len);
      i += len;
      if (!fields.has(fieldNumber)) fields.set(fieldNumber, []);
      fields.get(fieldNumber).push(value);
    } else if (wireType === 0) {
      while (i < buf.length) {
        const b = buf[i++];
        if (!(b & 0x80)) break;
      }
    } else if (wireType === 1) {
      i += 8;
    } else if (wireType === 5) {
      i += 4;
    } else {
      throw new Error('Tipo wire protobuf não suportado no CRX3: ' + wireType);
    }
  }
  return fields;
}

/**
 * @param {Buffer} proofBuf
 * @returns {{ publicKey: Buffer, signature: Buffer }}
 */
function parseAsymmetricKeyProof(proofBuf) {
  const fields = parseProtobufFields(proofBuf);
  const pubs = fields.get(1) || [];
  const sigs = fields.get(2) || [];
  if (!pubs.length || !sigs.length) {
    throw new Error('Prova assimétrica CRX3 incompleta');
  }
  return { publicKey: pubs[0], signature: sigs[0] };
}

/**
 * @param {Buffer} signedHeaderData
 * @returns {Buffer} crx_id (16 bytes)
 */
function parseSignedDataCrxId(signedHeaderData) {
  const fields = parseProtobufFields(signedHeaderData);
  const ids = fields.get(1) || [];
  if (!ids.length || ids[0].length !== 16) {
    throw new Error('signed_header_data CRX3 sem crx_id válido');
  }
  return ids[0];
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
 * Extension id (a–p) from 16-byte crx_id.
 * @param {Buffer} crxId
 */
function idFromCrxId(crxId) {
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (crxId[i] >> 4));
    id += String.fromCharCode(97 + (crxId[i] & 0xf));
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
 * @param {Buffer} publicKeyDer SPKI
 * @param {Buffer} signature
 * @param {Buffer} signedPayload
 * @param {Buffer} expectedCrxId
 */
function proofMatchesCrxId(publicKeyDer, signature, signedPayload, expectedCrxId) {
  const keyHash = crypto.createHash('sha256').update(publicKeyDer).digest();
  const crxIdFromKey = keyHash.subarray(0, 16);
  if (!crxIdFromKey.equals(expectedCrxId)) return false;
  try {
    const key = crypto.createPublicKey({
      key: publicKeyDer,
      format: 'der',
      type: 'spki',
    });
    return crypto.verify('sha256', signedPayload, key, signature);
  } catch {
    return false;
  }
}

/**
 * Verify CRX3 header signatures and return zip + extension id.
 * @param {Buffer} buf
 * @param {{ expectedId?: string|null }} [opts]
 * @returns {{ version: number, zip: Buffer, extensionId: string, crxId: Buffer }}
 */
function verifyAndStripCrx3(buf, opts = {}) {
  if (!buf || buf.length < 16) {
    throw new Error('Arquivo CRX muito pequeno');
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    throw new Error('CRX sem assinatura válida (ZIP cru rejeitado)');
  }
  if (buf.subarray(0, 4).compare(CRX_MAGIC) !== 0) {
    throw new Error('Não é um arquivo CRX (magic Cr24 ausente)');
  }
  const version = buf.readUInt32LE(4);
  if (version === 2) {
    throw new Error('CRX2 rejeitado — use CRX3 assinado');
  }
  if (version !== 3) {
    throw new Error('Versão CRX não suportada: ' + version);
  }

  const headerSize = buf.readUInt32LE(8);
  const zipStart = 12 + headerSize;
  if (headerSize <= 0 || zipStart > buf.length) {
    throw new Error('CRX3 header inválido');
  }
  const header = buf.subarray(12, zipStart);
  const zip = buf.subarray(zipStart);
  if (zip.length < 4 || zip[0] !== 0x50 || zip[1] !== 0x4b) {
    throw new Error('Payload CRX não é um ZIP válido');
  }

  const fields = parseProtobufFields(header);
  const signedHeaderList = fields.get(10000) || [];
  if (!signedHeaderList.length) {
    throw new Error('CRX3 sem signed_header_data — assinatura ausente');
  }
  const signedHeaderData = signedHeaderList[0];
  const crxId = parseSignedDataCrxId(signedHeaderData);

  const signedPayload = Buffer.concat([
    CRX3_SIGNED_PREFIX,
    (() => {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(signedHeaderData.length, 0);
      return len;
    })(),
    signedHeaderData,
    zip,
  ]);

  const rsaProofs = (fields.get(2) || []).map(parseAsymmetricKeyProof);
  const ecdsaProofs = (fields.get(3) || []).map(parseAsymmetricKeyProof);
  const allProofs = rsaProofs.concat(ecdsaProofs);
  if (!allProofs.length) {
    throw new Error('CRX3 sem provas de assinatura (RSA/ECDSA)');
  }

  let matched = false;
  for (const proof of allProofs) {
    if (
      proofMatchesCrxId(proof.publicKey, proof.signature, signedPayload, crxId)
    ) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    throw new Error('Assinatura CRX3 inválida ou adulterada');
  }

  const extensionId = idFromCrxId(crxId);
  const expectedId = opts.expectedId ? String(opts.expectedId).toLowerCase() : null;
  if (expectedId) {
    if (!/^[a-p]{32}$/.test(expectedId)) {
      throw new Error('ID de extensão esperado inválido');
    }
    if (extensionId !== expectedId) {
      throw new Error(
        'ID da extensão não corresponde à chave do CRX (esperado ' +
          expectedId +
          ', obtido ' +
          extensionId +
          ')'
      );
    }
  }

  return { version: 3, zip, extensionId, crxId };
}

/**
 * @deprecated use verifyAndStripCrx3 — kept for callers that only need zip after verify
 * @param {Buffer} buf
 * @returns {{ version: number, zip: Buffer }}
 */
function stripCrxHeader(buf) {
  const r = verifyAndStripCrx3(buf);
  return { version: r.version, zip: r.zip };
}

/**
 * Unpack verified CRX3 into destDir.
 * @param {Buffer} buf
 * @param {string} destDir
 * @param {{ expectedId?: string|null }} [opts]
 * @returns {{ crxVersion: number, files: number, extensionId: string }}
 */
function unpackCrxToDir(buf, destDir, opts = {}) {
  const { version, zip, extensionId } = verifyAndStripCrx3(buf, opts);
  const files = extractZipSafely(zip, destDir);
  const manifestPath = path.join(destDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    const kids = fs.readdirSync(destDir).filter((n) => !n.startsWith('.'));
    if (kids.length === 1) {
      const nested = path.join(destDir, kids[0]);
      if (
        fs.statSync(nested).isDirectory() &&
        fs.existsSync(path.join(nested, 'manifest.json'))
      ) {
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
  return { crxVersion: version, files, extensionId };
}

/**
 * Build signed CRX3 around zip buffer.
 * @param {Buffer} zipBuf
 * @param {crypto.KeyObject} [privateKey]
 * @returns {{ buffer: Buffer, extensionId: string, publicKeyDer: Buffer, privateKey: crypto.KeyObject }}
 */
function buildSignedCrx3(zipBuf, privateKey) {
  const key =
    privateKey ||
    crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const publicKeyDer = crypto.createPublicKey(key).export({
    type: 'spki',
    format: 'der',
  });
  const crxId = crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
  const signedHeaderData = encodeBytesField(1, crxId);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(signedHeaderData.length, 0);
  const signedPayload = Buffer.concat([
    CRX3_SIGNED_PREFIX,
    lenBuf,
    signedHeaderData,
    zipBuf,
  ]);
  const signature = crypto.sign('sha256', signedPayload, key);
  const proof = Buffer.concat([
    encodeBytesField(1, publicKeyDer),
    encodeBytesField(2, signature),
  ]);
  const header = Buffer.concat([
    encodeBytesField(2, proof),
    encodeBytesField(10000, signedHeaderData),
  ]);
  const out = Buffer.alloc(12 + header.length + zipBuf.length);
  CRX_MAGIC.copy(out, 0);
  out.writeUInt32LE(3, 4);
  out.writeUInt32LE(header.length, 8);
  header.copy(out, 12);
  zipBuf.copy(out, 12 + header.length);
  return {
    buffer: out,
    extensionId: idFromCrxId(crxId),
    publicKeyDer,
    privateKey: key,
  };
}

/**
 * Zip a directory (folder contents at zip root).
 * @param {string} dir
 * @returns {Buffer}
 */
function zipDirectory(dir) {
  const zip = new AdmZip();
  zip.addLocalFolder(dir);
  return zip.toBuffer();
}

/**
 * Pack directory as signed CRX3 (tests / selftest).
 * @param {string} dir
 * @param {string} outPath
 * @param {{ privateKey?: crypto.KeyObject }} [opts]
 * @returns {{ outPath: string, extensionId: string }}
 */
function packDirAsCrx3(dir, outPath, opts = {}) {
  const zipBuf = zipDirectory(dir);
  const built = buildSignedCrx3(zipBuf, opts.privateKey);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, built.buffer);
  return { outPath, extensionId: built.extensionId };
}

/**
 * Runtime fixtures for security selftests (valid / tampered / wrong id / CRX2).
 * @param {string} [fixtureDir] directory with a minimal extension (manifest.json)
 * @returns {{
 *   valid: { buffer: Buffer, extensionId: string },
 *   tampered: { buffer: Buffer, extensionId: string },
 *   wrongId: { buffer: Buffer, extensionId: string, expectedId: string },
 *   crx2: { buffer: Buffer }
 * }}
 */
function buildCrx3TestFixtures(fixtureDir) {
  let zipBuf;
  if (fixtureDir && fs.existsSync(path.join(fixtureDir, 'manifest.json'))) {
    zipBuf = zipDirectory(fixtureDir);
  } else {
    const zip = new AdmZip();
    zip.addFile(
      'manifest.json',
      Buffer.from(
        JSON.stringify({
          manifest_version: 3,
          name: 'MultiHeiz CRX Fixture',
          version: '1.0.0',
        }),
        'utf8'
      )
    );
    zipBuf = zip.toBuffer();
  }

  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const valid = buildSignedCrx3(zipBuf, privateKey);

  const tamperedBuf = Buffer.from(valid.buffer);
  // Flip a byte inside the zip payload (after header) to break the signature.
  const headerSize = tamperedBuf.readUInt32LE(8);
  const zipOff = 12 + headerSize;
  if (zipOff < tamperedBuf.length) {
    tamperedBuf[zipOff + Math.min(4, tamperedBuf.length - zipOff - 1)] ^= 0xff;
  }

  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherPub = crypto.createPublicKey(other.privateKey).export({
    type: 'spki',
    format: 'der',
  });
  const wrongExpectedId = idFromBytes(otherPub);

  // Minimal CRX2 (rejected): magic + version 2 + empty pubkey/sig + zip
  const crx2 = Buffer.alloc(16 + zipBuf.length);
  CRX_MAGIC.copy(crx2, 0);
  crx2.writeUInt32LE(2, 4);
  crx2.writeUInt32LE(0, 8); // pubkey len
  crx2.writeUInt32LE(0, 12); // sig len
  zipBuf.copy(crx2, 16);

  return {
    valid: { buffer: valid.buffer, extensionId: valid.extensionId },
    tampered: { buffer: tamperedBuf, extensionId: valid.extensionId },
    wrongId: {
      buffer: valid.buffer,
      extensionId: valid.extensionId,
      expectedId: wrongExpectedId,
    },
    crx2: { buffer: crx2 },
  };
}

module.exports = {
  stripCrxHeader,
  verifyAndStripCrx3,
  unpackCrxToDir,
  packDirAsCrx3,
  buildSignedCrx3,
  buildCrx3TestFixtures,
  idFromBytes,
  idFromCrxId,
  idFromManifestKey,
};
