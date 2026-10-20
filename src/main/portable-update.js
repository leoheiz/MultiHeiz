'use strict';

/**
 * Portable Windows self-update: download MultiHeiz-*-portable.exe from GitHub
 * releases, verify cryptographic hash, replace PORTABLE_EXECUTABLE_FILE via helper script.
 *
 * Destination policy (final .exe never stays in temp):
 * - Prefer the same folder as PORTABLE_EXECUTABLE_FILE / DIR (or MULTIHEIZ_FAKE_PORTABLE_FILE).
 * - If that folder is not writable → app.getPath('downloads'), relaunch from there, warn in pt-BR.
 * - If portable path is unknown → Downloads (safe: user still gets a verified file; no in-place replace).
 * Helper .ps1 and apply logs may live under temp (MultiHeiz-update-*).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, shell } = require('electron');

const PORTABLE_ASSET_RE = /^MultiHeiz-(\d+\.\d+\.\d+)-portable\.exe$/i;
const MAX_REDIRECTS = 5;
const NO_HASH_MSG =
  'Atualização sem hash criptográfico (SHA-256 ou SHA-512) — instalação recusada';

/** Exact hosts allowed for update feed / asset downloads (production). */
const GITHUB_UPDATE_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'codeload.github.com',
]);

/** @type {AbortController | null} */
let activeAbort = null;
/** @type {string | null} */
let downloadedExePath = null;
/** @type {string | null} unique mkdtemp dir for helper .ps1 / logs (not the final exe) */
let activeTempDir = null;
/** @type {{ version: string, size: number, digest?: string, sha512?: string, name?: string, url?: string } | null} */
let pendingAsset = null;
/** @type {ReturnType<typeof resolvePortableUpdateDestination> | null} */
let activeDest = null;

function log(logger, level, msg, meta) {
  if (logger && typeof logger[level] === 'function') {
    logger[level](msg, meta);
  } else {
    console.log(`[updater:portable] ${msg}`, meta || '');
  }
}

function isSelftest() {
  return !!process.env.MULTIHEIZ_SELFTEST;
}

/**
 * @param {string} hostname
 */
function isAllowedUpdateHost(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (GITHUB_UPDATE_HOSTS.has(h)) return true;
  if (isSelftest() && (h === '127.0.0.1' || h === 'localhost' || h === '::1')) {
    return true;
  }
  return false;
}

/**
 * Validate URL for feed/download: https + allowlisted host, or http to loopback only in selftest.
 * @param {string} urlStr
 * @param {{ forFeed?: boolean }} [opts]
 */
function assertAllowedUpdateUrl(urlStr, opts = {}) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error('URL de atualização inválida');
  }
  const host = u.hostname.toLowerCase();
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  if (u.protocol === 'https:') {
    if (!isAllowedUpdateHost(host)) {
      throw new Error('Host de atualização não permitido: ' + host);
    }
    return u.href;
  }
  if (u.protocol === 'http:') {
    if (opts.forFeed && isSelftest() && isLoopback) {
      return u.href;
    }
    if (!opts.forFeed && isSelftest() && isLoopback && isAllowedUpdateHost(host)) {
      return u.href;
    }
    throw new Error('Atualização exige HTTPS (HTTP só permitido em selftest local)');
  }
  throw new Error('Esquema de URL de atualização não permitido: ' + u.protocol);
}

function tempUpdateDir() {
  if (activeTempDir && fs.existsSync(activeTempDir)) return activeTempDir;
  return path.join(app.getPath('temp'), 'MultiHeiz-update');
}

/** Temp dir for helper script / logs only — never the final portable .exe. */
function ensureUniqueTempDir() {
  if (activeTempDir && fs.existsSync(activeTempDir)) return activeTempDir;
  activeTempDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'MultiHeiz-update-'));
  return activeTempDir;
}

function portableTargetPath() {
  const fake = process.env.MULTIHEIZ_FAKE_PORTABLE_FILE;
  if (fake) return path.resolve(fake);
  const envPath = process.env.PORTABLE_EXECUTABLE_FILE;
  if (envPath) return path.resolve(envPath);
  return null;
}

function portableEnvDir() {
  const file = portableTargetPath();
  if (file) return path.dirname(file);
  const envDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (envDir) return path.resolve(envDir);
  return null;
}

function downloadsDirPath() {
  try {
    return app.getPath('downloads');
  } catch {
    return path.join(app.getPath('temp'), 'Downloads');
  }
}

/**
 * Pure destination resolver for portable updates (testable without Electron I/O).
 *
 * @param {{
 *   envFile?: string | null,
 *   envDir?: string | null,
 *   downloadsDir?: string | null,
 *   canWrite?: boolean | ((dir: string) => boolean),
 *   version?: string,
 *   assetName?: string,
 * }} opts
 * @returns {{
 *   dir: string | null,
 *   finalPath: string | null,
 *   mode: 'same-folder' | 'downloads' | 'none',
 *   relaunchPath: string | null,
 *   originalExe: string | null,
 *   message?: string,
 * }}
 */
function resolvePortableUpdateDestination(opts = {}) {
  const downloadsDir = opts.downloadsDir ? path.resolve(String(opts.downloadsDir)) : null;
  const envFile = opts.envFile ? path.resolve(String(opts.envFile)) : null;
  const envDir = opts.envDir ? path.resolve(String(opts.envDir)) : null;
  const version = opts.version || '0.0.0';
  const finalName =
    opts.assetName || `MultiHeiz-${version}-portable.exe`;

  const portableDir = envFile ? path.dirname(envFile) : envDir;
  const originalExe = envFile || (envDir ? path.join(envDir, 'MultiHeiz-portable.exe') : null);

  const checkWrite = (dir) => {
    if (typeof opts.canWrite === 'function') return !!opts.canWrite(dir);
    if (typeof opts.canWrite === 'boolean') return opts.canWrite;
    return canWriteDir(dir);
  };

  if (!portableDir) {
    // Safest when path unknown: Downloads (verified file for the user; no in-place replace).
    if (!downloadsDir) {
      return {
        dir: null,
        finalPath: null,
        mode: 'none',
        relaunchPath: null,
        originalExe: null,
        message: 'Caminho do executável portátil desconhecido',
      };
    }
    const finalPath = path.join(downloadsDir, finalName);
    return {
      dir: downloadsDir,
      finalPath,
      mode: 'downloads',
      relaunchPath: finalPath,
      originalExe: null,
      message:
        'Caminho do executável portátil desconhecido; a nova versão será salva em Downloads: ' +
        finalPath,
    };
  }

  if (checkWrite(portableDir)) {
    let finalPath = path.join(portableDir, finalName);
    // Avoid overwriting the running exe during download — keep a distinct name.
    if (originalExe && path.resolve(finalPath) === path.resolve(originalExe)) {
      finalPath = originalExe + '.new';
    }
    return {
      dir: portableDir,
      finalPath,
      mode: 'same-folder',
      relaunchPath: originalExe || finalPath,
      originalExe,
    };
  }

  if (!downloadsDir) {
    return {
      dir: null,
      finalPath: null,
      mode: 'none',
      relaunchPath: null,
      originalExe,
      message: 'Sem permissão para escrever na pasta do executável',
    };
  }

  const finalPath = path.join(downloadsDir, finalName);
  return {
    dir: downloadsDir,
    finalPath,
    mode: 'downloads',
    relaunchPath: finalPath,
    originalExe,
    message:
      'Sem permissão na pasta do MultiHeiz; a nova versão foi salva em Downloads: ' + finalPath,
  };
}

/**
 * Resolve destination using live env + disk write check.
 * @param {{ version?: string, assetName?: string, canWrite?: boolean | ((dir: string) => boolean) }} [opts]
 */
function resolveLivePortableDestination(opts = {}) {
  return resolvePortableUpdateDestination({
    envFile:
      process.env.MULTIHEIZ_FAKE_PORTABLE_FILE ||
      process.env.PORTABLE_EXECUTABLE_FILE ||
      null,
    envDir: process.env.PORTABLE_EXECUTABLE_DIR || null,
    downloadsDir: downloadsDirPath(),
    canWrite: opts.canWrite != null ? opts.canWrite : canWriteDir,
    version: opts.version,
    assetName: opts.assetName,
  });
}

function feedUrl() {
  const raw =
    process.env.MULTIHEIZ_UPDATE_FEED_URL ||
    'https://api.github.com/repos/leoheiz/MultiHeiz/releases/latest';
  return assertAllowedUpdateUrl(raw, { forFeed: true });
}

/**
 * @param {string} a
 * @param {string} b
 */
function compareSemver(a, b) {
  const pa = String(a || '0.0.0')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  const pb = String(b || '0.0.0')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  const aa = pa ? [Number(pa[1]), Number(pa[2]), Number(pa[3])] : [0, 0, 0];
  const bb = pb ? [Number(pb[1]), Number(pb[2]), Number(pb[3])] : [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return 0;
}

/**
 * @param {object} asset
 * @returns {boolean}
 */
function assetHasCryptoHash(asset) {
  if (!asset) return false;
  if (asset.sha512 && String(asset.sha512).trim()) return true;
  if (asset.digest && /^sha256:/i.test(String(asset.digest))) return true;
  return false;
}

/**
 * @param {Buffer|string} fileData
 * @param {object} asset
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function verifyAssetHash(fileData, asset) {
  if (!assetHasCryptoHash(asset)) {
    return { ok: false, error: NO_HASH_MSG };
  }
  const fileBuf = Buffer.isBuffer(fileData) ? fileData : fs.readFileSync(fileData);
  if (asset.digest && /^sha256:/i.test(String(asset.digest))) {
    const expected = String(asset.digest)
      .replace(/^sha256:/i, '')
      .toLowerCase()
      .trim();
    const actual = crypto.createHash('sha256').update(fileBuf).digest('hex');
    if (actual !== expected) {
      return { ok: false, error: 'Hash SHA-256 não confere' };
    }
    return { ok: true };
  }
  if (asset.sha512) {
    const actual = crypto.createHash('sha512').update(fileBuf).digest('base64');
    if (actual !== String(asset.sha512).trim()) {
      return { ok: false, error: 'Hash SHA-512 não confere' };
    }
    return { ok: true };
  }
  return { ok: false, error: NO_HASH_MSG };
}

/**
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, headers: object, body: Buffer }>}
 */
function httpGetBuffer(url, headers = {}, redirectLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let safeUrl;
    try {
      safeUrl = assertAllowedUpdateUrl(url, { forFeed: true });
    } catch (err) {
      reject(err);
      return;
    }
    const mod = safeUrl.startsWith('http://') ? http : https;
    const req = mod.get(
      safeUrl,
      {
        headers: {
          'User-Agent': `MultiHeiz/${app.getVersion()}`,
          Accept: '*/*',
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          if (redirectLeft <= 0) {
            res.resume();
            reject(new Error('Muitos redirecionamentos na atualização'));
            return;
          }
          let next;
          try {
            next = assertAllowedUpdateUrl(new URL(res.headers.location, safeUrl).href, {
              forFeed: true,
            });
          } catch (err) {
            res.resume();
            reject(err);
            return;
          }
          res.resume();
          httpGetBuffer(next, headers, redirectLeft - 1).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
  });
}

/**
 * Parse optional sha512 for portable from latest.yml body.
 * @param {string} yml
 * @param {string} fileName
 */
function sha512FromLatestYml(yml, fileName) {
  if (!yml || !fileName) return null;
  const text = String(yml);
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(
    `(?:^|\\n)\\s*-\\s*url:\\s*${escaped}[\\s\\S]*?sha512:\\s*(\\S+)`,
    'i'
  );
  const m1 = text.match(blockRe);
  if (m1) return m1[1];
  const pathRe = new RegExp(
    `(?:^|\\n)\\s*-\\s*path:\\s*${escaped}[\\s\\S]*?sha512:\\s*(\\S+)`,
    'i'
  );
  const m2 = text.match(pathRe);
  if (m2) return m2[1];
  if (new RegExp(`(?:^|\\n)path:\\s*${escaped}\\s*\\n`, 'i').test(text)) {
    const m3 = text.match(/(?:^|\n)sha512:\s*(\S+)/i);
    if (m3) return m3[1];
  }
  return null;
}

/**
 * @param {object} release GitHub release JSON
 * @param {object} asset
 */
async function enrichPortableHashes(release, asset) {
  const assets = (release && release.assets) || [];
  const ymlAsset = assets.find(
    (a) => String(a.name || '').toLowerCase() === 'latest.yml'
  );
  let sha512 = null;
  if (ymlAsset && ymlAsset.browser_download_url) {
    try {
      const r = await httpGetBuffer(ymlAsset.browser_download_url);
      if (r.status >= 200 && r.status < 300) {
        sha512 = sha512FromLatestYml(r.body.toString('utf8'), asset.name);
      }
    } catch {
      /* ignore — hash may still come from digest */
    }
  }
  const digest = asset.digest ? String(asset.digest) : null;
  return {
    name: asset.name,
    version: asset.version,
    size: Number(asset.size) || 0,
    url: asset.browser_download_url || asset.url,
    digest,
    sha512,
  };
}

/**
 * Find portable asset on a GitHub release object.
 * @param {object} release
 */
function findPortableAsset(release) {
  const assets = (release && release.assets) || [];
  for (const a of assets) {
    const name = String(a.name || '');
    const m = name.match(PORTABLE_ASSET_RE);
    if (!m) continue;
    return {
      name,
      version: m[1],
      size: Number(a.size) || 0,
      browser_download_url: a.browser_download_url,
      url: a.url,
      digest: a.digest,
    };
  }
  return null;
}

/**
 * @param {{ logger?: object }} [opts]
 * @returns {Promise<{ ok: boolean, upToDate?: boolean, version?: string, asset?: object, error?: string, statusCode?: number }>}
 */
async function checkPortableUpdate(opts = {}) {
  const { logger } = opts;
  const current = app.getVersion();
  let url;
  try {
    url = feedUrl();
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Feed de atualização inválido' };
  }
  log(logger, 'info', 'portable check', { url, current });
  try {
    const r = await httpGetBuffer(url, {
      Accept: 'application/vnd.github+json',
    });
    if (r.status === 403) {
      return {
        ok: false,
        error: 'Limite da API do GitHub (403) — tente mais tarde',
        statusCode: 403,
      };
    }
    if (r.status === 404) {
      return {
        ok: false,
        error: 'Repositório privado ou sem releases públicas',
        statusCode: 404,
      };
    }
    if (r.status < 200 || r.status >= 300) {
      return { ok: false, error: `HTTP ${r.status}`, statusCode: r.status };
    }
    const data = JSON.parse(r.body.toString('utf8'));
    const tag = String((data && data.tag_name) || '').replace(/^v/i, '');
    if (!tag) return { ok: false, error: 'Release sem versão' };
    if (compareSemver(current, tag) >= 0) {
      return { ok: true, upToDate: true, version: tag };
    }
    const rawAsset = findPortableAsset(data);
    if (!rawAsset) {
      return {
        ok: false,
        error: `Release ${tag} sem asset portátil`,
        version: tag,
      };
    }
    const asset = await enrichPortableHashes(data, rawAsset);
    if (!assetHasCryptoHash(asset)) {
      return {
        ok: false,
        error: NO_HASH_MSG,
        version: tag,
      };
    }
    pendingAsset = asset;
    return { ok: true, upToDate: false, version: tag, asset };
  } catch (err) {
    const msg = (err && err.message) || 'Falha de rede';
    if (/ENOTFOUND|ECONNREFUSED|network|offline|getaddrinfo/i.test(msg)) {
      return { ok: false, error: 'Sem conexão' };
    }
    return { ok: false, error: msg };
  }
}

/**
 * Download with progress. Calls onProgress({ percent, bytesPerSecond, transferred, total }).
 * @param {object} asset
 * @param {{ onProgress?: Function, logger?: object }} [opts]
 */
async function downloadPortableAsset(asset, opts = {}) {
  const { onProgress, logger, canWrite } = opts;
  if (!asset || !asset.url) {
    return { ok: false, error: 'Asset inválido' };
  }
  if (!assetHasCryptoHash(asset)) {
    return { ok: false, error: NO_HASH_MSG };
  }
  cancelDownload();
  const controller = new AbortController();
  activeAbort = controller;

  const finalName = asset.name || `MultiHeiz-${asset.version}-portable.exe`;
  const dest = resolveLivePortableDestination({
    version: asset.version,
    assetName: finalName,
    canWrite: canWrite != null ? canWrite : canWriteDir,
  });
  activeDest = dest;

  if (dest.mode === 'none' || !dest.finalPath || !dest.dir) {
    activeAbort = null;
    return {
      ok: false,
      error: dest.message || 'Caminho do executável portátil desconhecido',
    };
  }

  try {
    fs.mkdirSync(dest.dir, { recursive: true });
  } catch (err) {
    activeAbort = null;
    return {
      ok: false,
      error: (err && err.message) || 'Não foi possível criar a pasta de destino',
    };
  }

  const finalPath = dest.finalPath;
  const partPath = finalPath + '.part';

  try {
    if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
  } catch {
    /* ignore */
  }

  log(logger, 'info', 'portable download start', {
    url: asset.url,
    size: asset.size,
    dest: finalPath,
    mode: dest.mode,
  });

  let downloadUrl;
  try {
    downloadUrl = assertAllowedUpdateUrl(asset.url);
  } catch (err) {
    activeAbort = null;
    return { ok: false, error: (err && err.message) || 'URL de download inválida' };
  }

  const result = await downloadToFile(downloadUrl, partPath, {
    expectedSize: asset.size,
    signal: controller.signal,
    onProgress,
  });

  activeAbort = null;
  if (!result.ok) {
    try {
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
    } catch {
      /* ignore */
    }
    return result;
  }

  let st;
  try {
    st = fs.statSync(partPath);
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Arquivo parcial ausente' };
  }
  if (asset.size > 0 && st.size !== asset.size) {
    log(logger, 'error', 'portable size mismatch', {
      expected: asset.size,
      actual: st.size,
    });
    try {
      fs.unlinkSync(partPath);
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: `Tamanho inválido (esperado ${asset.size}, obtido ${st.size})`,
    };
  }

  const hashCheck = verifyAssetHash(partPath, asset);
  if (!hashCheck.ok) {
    log(logger, 'error', 'portable hash verify failed', { error: hashCheck.error });
    try {
      fs.unlinkSync(partPath);
    } catch {
      /* ignore */
    }
    return hashCheck;
  }

  try {
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    fs.renameSync(partPath, finalPath);
  } catch (err) {
    // If rename across volumes fails, try copy+unlink
    try {
      fs.copyFileSync(partPath, finalPath);
      fs.unlinkSync(partPath);
    } catch (err2) {
      return {
        ok: false,
        error: (err2 && err2.message) || (err && err.message) || 'Falha ao finalizar download',
      };
    }
  }

  // Safety: final exe must not remain under the helper temp prefix
  try {
    const tempRoot = path.resolve(app.getPath('temp'));
    const resolvedFinal = path.resolve(finalPath);
    if (
      resolvedFinal.toLowerCase().startsWith(path.join(tempRoot, 'MultiHeiz-update').toLowerCase())
    ) {
      log(logger, 'error', 'portable final path under update temp — refusing', {
        path: finalPath,
      });
      try {
        fs.unlinkSync(finalPath);
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        error: 'Destino inválido: o executável final não pode ficar na pasta temporária',
      };
    }
  } catch {
    /* ignore temp check failures */
  }

  downloadedExePath = finalPath;
  pendingAsset = asset;
  log(logger, 'info', 'portable download complete', {
    path: finalPath,
    mode: dest.mode,
  });
  return {
    ok: true,
    path: finalPath,
    asset,
    mode: dest.mode,
    message: dest.message || null,
    relaunchPath: dest.relaunchPath,
    notWritable: dest.mode === 'downloads',
  };
}

/**
 * @param {string} url
 * @param {string} destPath
 * @param {{ expectedSize?: number, signal?: AbortSignal, onProgress?: Function }} opts
 */
function downloadToFile(url, destPath, opts = {}) {
  const { expectedSize, signal, onProgress } = opts;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const follow = (currentUrl, redirectsLeft) => {
      if (signal && signal.aborted) {
        finish({ ok: false, error: 'Download cancelado', cancelled: true });
        return;
      }
      let safeUrl;
      try {
        safeUrl = assertAllowedUpdateUrl(currentUrl);
      } catch (err) {
        finish({ ok: false, error: (err && err.message) || 'URL não permitida' });
        return;
      }
      const mod = safeUrl.startsWith('http://') ? http : https;
      const req = mod.get(
        safeUrl,
        {
          headers: {
            'User-Agent': `MultiHeiz/${app.getVersion()}`,
            Accept: 'application/octet-stream',
          },
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            if (redirectsLeft <= 0) {
              res.resume();
              finish({ ok: false, error: 'Muitos redirecionamentos na atualização' });
              return;
            }
            let next;
            try {
              next = assertAllowedUpdateUrl(new URL(res.headers.location, safeUrl).href);
            } catch (err) {
              res.resume();
              finish({ ok: false, error: (err && err.message) || 'Redirect não permitido' });
              return;
            }
            res.resume();
            follow(next, redirectsLeft - 1);
            return;
          }
          if (status === 403) {
            finish({ ok: false, error: 'Limite da API do GitHub (403) — tente mais tarde' });
            return;
          }
          if (status < 200 || status >= 300) {
            finish({ ok: false, error: `Download HTTP ${status}` });
            return;
          }
          const total = expectedSize || Number(res.headers['content-length']) || 0;
          const out = fs.createWriteStream(destPath);
          let transferred = 0;
          let lastT = Date.now();
          let lastBytes = 0;
          let bytesPerSecond = 0;

          const onAbort = () => {
            try {
              req.destroy();
            } catch {
              /* ignore */
            }
            try {
              out.destroy();
            } catch {
              /* ignore */
            }
            finish({ ok: false, error: 'Download cancelado', cancelled: true });
          };
          if (signal) {
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
          }

          res.on('data', (chunk) => {
            transferred += chunk.length;
            const now = Date.now();
            const dt = now - lastT;
            if (dt >= 400) {
              bytesPerSecond = ((transferred - lastBytes) * 1000) / dt;
              lastT = now;
              lastBytes = transferred;
            }
            if (typeof onProgress === 'function') {
              const percent =
                total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : null;
              onProgress({
                percent,
                transferred,
                total,
                bytesPerSecond,
              });
            }
          });
          res.pipe(out);
          out.on('finish', () => {
            out.close(() => finish({ ok: true }));
          });
          out.on('error', (err) => {
            const msg = (err && err.message) || 'Erro de disco';
            if (/ENOSPC/i.test(msg)) {
              finish({ ok: false, error: 'Disco cheio' });
            } else {
              finish({ ok: false, error: msg });
            }
          });
          res.on('error', (err) => {
            finish({ ok: false, error: (err && err.message) || 'Falha de rede' });
          });
        }
      );
      req.on('error', (err) => {
        const msg = (err && err.message) || 'Falha de rede';
        if (/ENOTFOUND|ECONNREFUSED|network|offline|getaddrinfo/i.test(msg)) {
          finish({ ok: false, error: 'Sem conexão' });
        } else {
          finish({ ok: false, error: msg });
        }
      });
    };

    follow(url, MAX_REDIRECTS);
  });
}

function cancelDownload() {
  if (activeAbort) {
    try {
      activeAbort.abort();
    } catch {
      /* ignore */
    }
    activeAbort = null;
  }
}

function canWriteDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probe = path.join(dirPath, `.mh-write-${process.pid}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete downloaded file and clear state after failed verify.
 * @param {string} [filePath]
 */
function wipeDownloaded(filePath) {
  const p = filePath || downloadedExePath;
  if (p) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  downloadedExePath = null;
}

/**
 * Write helper .ps1 (in temp) and spawn detached. On success quits the app.
 * Re-verifies hash immediately before writing/running the helper.
 * same-folder: replace original exe then relaunch it.
 * downloads: relaunch the Downloads copy (no replace of the non-writable original).
 * @param {{ logger?: object, skipQuit?: boolean }} [opts]
 */
function applyPortableAndRelaunch(opts = {}) {
  const { logger, skipQuit } = opts;
  const source = downloadedExePath;
  if (!source || !fs.existsSync(source)) {
    return { ok: false, error: 'Arquivo de atualização não encontrado' };
  }

  const asset = pendingAsset;
  if (!asset || !assetHasCryptoHash(asset)) {
    wipeDownloaded(source);
    return { ok: false, error: NO_HASH_MSG };
  }
  const recheck = verifyAssetHash(source, asset);
  if (!recheck.ok) {
    log(logger, 'error', 'portable hash re-check failed before apply', {
      error: recheck.error,
    });
    wipeDownloaded(source);
    return recheck;
  }

  const dest =
    activeDest && activeDest.finalPath
      ? activeDest
      : resolveLivePortableDestination({
          version: asset.version,
          assetName: asset.name,
        });

  const replaceInPlace = dest.mode === 'same-folder' && !!dest.originalExe;
  const target = replaceInPlace ? dest.originalExe : source;
  const relaunchPath = dest.relaunchPath || source;

  if (replaceInPlace) {
    const targetDir = path.dirname(target);
    if (!canWriteDir(targetDir)) {
      return {
        ok: false,
        error:
          dest.message ||
          'Sem permissão na pasta do MultiHeiz; a nova versão foi salva em: ' + source,
        notWritable: true,
        downloadPath: source,
        downloadDir: path.dirname(source),
      };
    }
  }

  const helperDir = ensureUniqueTempDir();
  fs.mkdirSync(helperDir, { recursive: true });
  const helperPath = path.join(helperDir, `apply-update-${process.pid}.ps1`);
  const backupPath = replaceInPlace ? target + '.old' : null;
  const skipPidWait = process.env.MULTIHEIZ_PORTABLE_SKIP_PID_WAIT === '1';
  const pid = skipPidWait ? -1 : process.pid;
  const relaunchCmd =
    isSelftest() && process.env.MULTIHEIZ_PORTABLE_RELAUNCH_CMD
      ? process.env.MULTIHEIZ_PORTABLE_RELAUNCH_CMD
      : null;

  const psEscape = (p) => String(p).replace(/'/g, "''");
  const logPath = path.join(helperDir, `apply-update-${process.pid}.log`);
  const ps = [
    '$ErrorActionPreference = "Continue"',
    `$target = '${psEscape(target)}'`,
    `$source = '${psEscape(source)}'`,
    `$relaunch = '${psEscape(relaunchPath)}'`,
    `$backup = '${psEscape(backupPath || '')}'`,
    `$pidWait = ${pid}`,
    `$helper = '${psEscape(helperPath)}'`,
    `$logFile = '${psEscape(logPath)}'`,
    `$doReplace = $${replaceInPlace ? 'true' : 'false'}`,
    'function Log($m) { Add-Content -LiteralPath $logFile -Value $m -ErrorAction SilentlyContinue }',
    'Log "start"',
    'if ($pidWait -gt 0) {',
    '  for ($i = 0; $i -lt 60; $i++) {',
    '    $p = Get-Process -Id $pidWait -ErrorAction SilentlyContinue',
    '    if (-not $p) { break }',
    '    Start-Sleep -Seconds 1',
    '  }',
    '}',
    'Log "after-wait"',
  ];

  if (replaceInPlace) {
    ps.push(
      '$ok = $false',
      'for ($c = 0; $c -lt 15; $c++) {',
      '  try {',
      '    if ($backup -and (Test-Path -LiteralPath $backup)) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }',
      '    if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $backup -Force }',
      '    Copy-Item -LiteralPath $source -Destination $target -Force',
      '    $ok = $true',
      '    Log "copied try=$c"',
      '    break',
      '  } catch {',
      '    Log ("copy-fail " + $_.Exception.Message)',
      '    Start-Sleep -Seconds 1',
      '  }',
      '}',
      'if (-not $ok) {',
      '  if ($backup -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $target -Force -ErrorAction SilentlyContinue }',
      '  Log "fail"',
      '  exit 1',
      '}',
      'if ($backup -and (Test-Path -LiteralPath $backup)) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }',
      // Drop versioned download if it is distinct from the replaced target
      'if ($source -ne $target -and (Test-Path -LiteralPath $source)) {',
      '  Remove-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue',
      '  Log "removed-source-copy"',
      '}'
    );
  } else {
    ps.push('Log "downloads-relaunch-only"');
  }

  if (relaunchCmd) {
    ps.push('try {');
    ps.push('  ' + relaunchCmd);
    ps.push('  Log "relaunch-ok"');
    ps.push('} catch { Log ("relaunch-fail " + $_.Exception.Message) }');
  } else {
    ps.push('Start-Process -FilePath $relaunch');
    ps.push('Log "relaunched"');
  }
  ps.push('Remove-Item -LiteralPath $helper -Force -ErrorAction SilentlyContinue');
  ps.push('Log "done"');
  ps.push('exit 0');

  // UTF-8 with BOM helps Windows PowerShell 5.1 parse non-ASCII paths
  fs.writeFileSync(helperPath, '\uFEFF' + ps.join('\r\n'), 'utf8');
  log(logger, 'info', 'portable apply helper written', {
    helperPath,
    target,
    source,
    relaunchPath,
    mode: dest.mode,
  });

  const waitForHelper = process.env.MULTIHEIZ_PORTABLE_SKIP_PID_WAIT === '1';
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helperPath],
    {
      detached: !waitForHelper,
      stdio: 'ignore',
      windowsHide: true,
      cwd: helperDir,
    }
  );
  if (waitForHelper) {
    child.on('error', (err) => {
      log(logger, 'error', 'portable helper spawn error', { error: err && err.message });
    });
  } else {
    child.unref();
  }

  if (!skipQuit) {
    setTimeout(() => {
      try {
        app.quit();
      } catch {
        /* ignore */
      }
    }, 200);
  }
  return {
    ok: true,
    helperPath,
    target,
    source,
    relaunchPath,
    logPath,
    child,
    mode: dest.mode,
  };
}

function openDownloadedFolder() {
  if (downloadedExePath && fs.existsSync(downloadedExePath)) {
    shell.showItemInFolder(downloadedExePath);
    return { ok: true, path: downloadedExePath };
  }
  const dir = tempUpdateDir();
  if (fs.existsSync(dir)) {
    shell.openPath(dir);
    return { ok: true, path: dir };
  }
  return { ok: false, error: 'Nenhum download encontrado' };
}

function getDownloadedPath() {
  return downloadedExePath;
}

function getPendingAsset() {
  return pendingAsset;
}

function resetPortableStateForTest() {
  cancelDownload();
  downloadedExePath = null;
  pendingAsset = null;
  activeTempDir = null;
  activeDest = null;
}

/**
 * Remove leftover .old / .part / .new next to portable exe, Downloads, and helper temp.
 */
function cleanupPortableLeftovers(logger) {
  try {
    const dirs = new Set();
    const target = portableTargetPath();
    if (target) {
      dirs.add(path.dirname(target));
      for (const suffix of ['.old', '.new', '.part']) {
        const p = target + suffix;
        if (fs.existsSync(p)) {
          try {
            fs.unlinkSync(p);
            log(logger, 'info', 'removed portable leftover', { path: p });
          } catch {
            /* ignore */
          }
        }
      }
    }
    try {
      dirs.add(downloadsDirPath());
    } catch {
      /* ignore */
    }
    if (activeDest && activeDest.dir) dirs.add(activeDest.dir);
    for (const dir of dirs) {
      if (!dir || !fs.existsSync(dir)) continue;
      try {
        for (const name of fs.readdirSync(dir)) {
          if (
            /\.part$/i.test(name) ||
            /\.old$/i.test(name) ||
            /MultiHeiz-.*-portable\.exe\.new$/i.test(name)
          ) {
            try {
              fs.unlinkSync(path.join(dir, name));
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (activeTempDir && fs.existsSync(activeTempDir)) {
      for (const name of fs.readdirSync(activeTempDir)) {
        if (
          name.endsWith('.part') ||
          /^apply-update-.*\.(cmd|ps1)$/i.test(name)
        ) {
          try {
            fs.unlinkSync(path.join(activeTempDir, name));
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch (err) {
    log(logger, 'warn', 'portable cleanup', { error: err && err.message });
  }
}

module.exports = {
  PORTABLE_ASSET_RE,
  compareSemver,
  portableTargetPath,
  portableEnvDir,
  feedUrl,
  findPortableAsset,
  sha512FromLatestYml,
  checkPortableUpdate,
  downloadPortableAsset,
  cancelDownload,
  applyPortableAndRelaunch,
  openDownloadedFolder,
  getDownloadedPath,
  getPendingAsset,
  resetPortableStateForTest,
  cleanupPortableLeftovers,
  canWriteDir,
  tempUpdateDir,
  ensureUniqueTempDir,
  httpGetBuffer,
  assertAllowedUpdateUrl,
  isAllowedUpdateHost,
  assetHasCryptoHash,
  verifyAssetHash,
  resolvePortableUpdateDestination,
  resolveLivePortableDestination,
  downloadsDirPath,
  NO_HASH_MSG,
  GITHUB_UPDATE_HOSTS,
  MAX_REDIRECTS,
};
