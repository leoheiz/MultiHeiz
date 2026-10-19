'use strict';

/**
 * Portable Windows self-update: download MultiHeiz-*-portable.exe from GitHub
 * releases, verify size/hash, replace PORTABLE_EXECUTABLE_FILE via helper script.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, shell } = require('electron');

const PORTABLE_ASSET_RE = /^MultiHeiz-(\d+\.\d+\.\d+)-portable\.exe$/i;

/** @type {AbortController | null} */
let activeAbort = null;
/** @type {string | null} */
let downloadedExePath = null;
/** @type {{ version: string, size: number, digest?: string, sha512?: string } | null} */
let pendingAsset = null;

function log(logger, level, msg, meta) {
  if (logger && typeof logger[level] === 'function') {
    logger[level](msg, meta);
  } else {
    console.log(`[updater:portable] ${msg}`, meta || '');
  }
}

function tempUpdateDir() {
  return path.join(app.getPath('temp'), 'MultiHeiz-update');
}

function portableTargetPath() {
  const fake = process.env.MULTIHEIZ_FAKE_PORTABLE_FILE;
  if (fake) return path.resolve(fake);
  const envPath = process.env.PORTABLE_EXECUTABLE_FILE;
  if (envPath) return path.resolve(envPath);
  return null;
}

function feedUrl() {
  return (
    process.env.MULTIHEIZ_UPDATE_FEED_URL ||
    'https://api.github.com/repos/leoheiz/MultiHeiz/releases/latest'
  );
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
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, headers: object, body: Buffer }>}
 */
function httpGetBuffer(url, headers = {}, redirectLeft = 8) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https;
    const req = mod.get(
      url,
      {
        headers: {
          'User-Agent': `MultiHeiz/${app.getVersion()}`,
          Accept: '*/*',
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (
          status >= 300 &&
          status < 400 &&
          res.headers.location &&
          redirectLeft > 0
        ) {
          const next = new URL(res.headers.location, url).href;
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
  // electron-builder latest.yml: path / url + sha512 under files: or top-level
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
  // Top-level only if path matches portable
  if (new RegExp(`(?:^|\\n)path:\\s*${escaped}\\s*\\n`, 'i').test(text)) {
    const m3 = text.match(/(?:^|\n)sha512:\s*(\S+)/i);
    if (m3) return m3[1];
  }
  return null;
}

/**
 * @param {object} release GitHub release JSON
 * @param {string} version
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
      /* ignore */
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
  const url = feedUrl();
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
  const { onProgress, logger } = opts;
  if (!asset || !asset.url) {
    return { ok: false, error: 'Asset inválido' };
  }
  cancelDownload();
  const controller = new AbortController();
  activeAbort = controller;

  const dir = tempUpdateDir();
  fs.mkdirSync(dir, { recursive: true });
  const finalName = asset.name || `MultiHeiz-${asset.version}-portable.exe`;
  const partPath = path.join(dir, finalName + '.part');
  const finalPath = path.join(dir, finalName);

  try {
    if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
  } catch {
    /* ignore */
  }

  log(logger, 'info', 'portable download start', {
    url: asset.url,
    size: asset.size,
    dest: finalPath,
  });

  const result = await downloadToFile(asset.url, partPath, {
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

  // Verify size
  let st;
  try {
    st = fs.statSync(partPath);
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Arquivo temporário ausente' };
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

  const fileBuf = fs.readFileSync(partPath);
  if (asset.digest && /^sha256:/i.test(asset.digest)) {
    const expected = asset.digest.replace(/^sha256:/i, '').toLowerCase();
    const actual = crypto.createHash('sha256').update(fileBuf).digest('hex');
    if (actual !== expected) {
      log(logger, 'error', 'portable sha256 mismatch', { expected, actual });
      try {
        fs.unlinkSync(partPath);
      } catch {
        /* ignore */
      }
      return { ok: false, error: 'Hash SHA-256 não confere' };
    }
  } else if (asset.sha512) {
    const actual = crypto.createHash('sha512').update(fileBuf).digest('base64');
    if (actual !== asset.sha512) {
      log(logger, 'error', 'portable sha512 mismatch');
      try {
        fs.unlinkSync(partPath);
      } catch {
        /* ignore */
      }
      return { ok: false, error: 'Hash SHA-512 não confere' };
    }
  } else {
    log(logger, 'warn', 'portable download: size check only (no hash)', {
      size: st.size,
    });
  }

  try {
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    fs.renameSync(partPath, finalPath);
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Falha ao finalizar download' };
  }

  downloadedExePath = finalPath;
  pendingAsset = asset;
  log(logger, 'info', 'portable download complete', { path: finalPath });
  return { ok: true, path: finalPath, asset };
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
      const mod = currentUrl.startsWith('http://') ? http : https;
      const req = mod.get(
        currentUrl,
        {
          headers: {
            'User-Agent': `MultiHeiz/${app.getVersion()}`,
            Accept: 'application/octet-stream',
          },
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            follow(new URL(res.headers.location, currentUrl).href, redirectsLeft - 1);
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
          const total =
            expectedSize ||
            Number(res.headers['content-length']) ||
            0;
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

    follow(url, 8);
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
 * Write helper .cmd and spawn detached. On success quits the app.
 * @param {{ logger?: object, skipQuit?: boolean }} [opts]
 */
function applyPortableAndRelaunch(opts = {}) {
  const { logger, skipQuit } = opts;
  const target = portableTargetPath();
  const source = downloadedExePath;
  if (!source || !fs.existsSync(source)) {
    return { ok: false, error: 'Arquivo de atualização não encontrado' };
  }
  if (!target) {
    return { ok: false, error: 'Caminho do executável portátil desconhecido' };
  }

  const targetDir = path.dirname(target);
  if (!canWriteDir(targetDir)) {
    return {
      ok: false,
      error: 'Sem permissão para escrever na pasta do executável',
      notWritable: true,
      downloadPath: source,
      downloadDir: path.dirname(source),
    };
  }

  const dir = tempUpdateDir();
  fs.mkdirSync(dir, { recursive: true });
  const helperPath = path.join(dir, `apply-update-${process.pid}.ps1`);
  const backupPath = target + '.old';
  const skipPidWait = process.env.MULTIHEIZ_PORTABLE_SKIP_PID_WAIT === '1';
  const pid = skipPidWait ? -1 : process.pid;
  const relaunchCmd = process.env.MULTIHEIZ_PORTABLE_RELAUNCH_CMD;

  const psEscape = (p) => String(p).replace(/'/g, "''");
  const logPath = path.join(dir, `apply-update-${process.pid}.log`);
  const ps = [
    '$ErrorActionPreference = "Continue"',
    `$target = '${psEscape(target)}'`,
    `$source = '${psEscape(source)}'`,
    `$backup = '${psEscape(backupPath)}'`,
    `$pidWait = ${pid}`,
    `$helper = '${psEscape(helperPath)}'`,
    `$logFile = '${psEscape(logPath)}'`,
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
    '$ok = $false',
    'for ($c = 0; $c -lt 15; $c++) {',
    '  try {',
    '    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }',
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
    '  if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $target -Force -ErrorAction SilentlyContinue }',
    '  Log "fail"',
    '  exit 1',
    '}',
    'if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }',
  ];
  if (relaunchCmd) {
    ps.push('try {');
    ps.push('  ' + relaunchCmd);
    ps.push('  Log "relaunch-ok"');
    ps.push('} catch { Log ("relaunch-fail " + $_.Exception.Message) }');
  } else {
    ps.push('Start-Process -FilePath $target');
    ps.push('Log "relaunched"');
  }
  ps.push('Remove-Item -LiteralPath $helper -Force -ErrorAction SilentlyContinue');
  ps.push('Log "done"');
  ps.push('exit 0');

  // UTF-8 with BOM helps Windows PowerShell 5.1 parse non-ASCII paths
  fs.writeFileSync(helperPath, '\uFEFF' + ps.join('\r\n'), 'utf8');
  log(logger, 'info', 'portable apply helper written', { helperPath, target, source });

  const waitForHelper = process.env.MULTIHEIZ_PORTABLE_SKIP_PID_WAIT === '1';
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helperPath],
    {
      detached: !waitForHelper,
      stdio: 'ignore',
      windowsHide: true,
      cwd: dir,
    }
  );
  if (waitForHelper) {
    // Selftest: wait for helper exit so assertions can run
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
  return { ok: true, helperPath, target, source, logPath, child };
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
}

/**
 * Clean leftover .old next to portable exe and temp parts.
 */
function cleanupPortableLeftovers(logger) {
  try {
    const target = portableTargetPath();
    if (target) {
      const old = target + '.old';
      if (fs.existsSync(old)) {
        fs.unlinkSync(old);
        log(logger, 'info', 'removed portable .old backup', { old });
      }
    }
    const dir = tempUpdateDir();
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.part') || /^apply-update-.*\.cmd$/i.test(name)) {
          try {
            fs.unlinkSync(path.join(dir, name));
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
  httpGetBuffer,
};
