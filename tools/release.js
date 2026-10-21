'use strict';

/**
 * Após dist:win / dist:linux: copia artefatos da versão atual para
 * releases/<versão>/, mantém só as 2 versões mais recentes, e atualiza
 * MultiHeiz-portable.exe na raiz (Windows).
 * No CI (process.env.CI) é no-op — o workflow publica via electron-builder.
 */

const fs = require('node:fs');
const path = require('node:path');

if (process.env.CI) {
  console.log('[release] CI detectado — skip (publicação via electron-builder --publish)');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const RELEASES = path.join(ROOT, 'releases');
const ROOT_PORTABLE = path.join(ROOT, 'MultiHeiz-portable.exe');

const pkg = require(path.join(ROOT, 'package.json'));
const version = pkg.version;

function parseSemver(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemverDesc(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return String(b).localeCompare(String(a));
  if (!pa) return 1;
  if (!pb) return -1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
  console.log('[release] copiado:', path.relative(ROOT, src), '->', path.relative(ROOT, dest));
}

function collectArtifacts(ver, distDir) {
  const dist = distDir || DIST;
  if (!fs.existsSync(dist)) {
    console.warn('[release] dist/ inexistente — nada a copiar');
    return [];
  }

  const names = fs.readdirSync(dist);
  const wanted = [];

  const winPortable = 'MultiHeiz-' + ver + '-portable.exe';
  const winSetup = 'MultiHeiz-' + ver + '-setup.exe';
  for (const name of [winPortable, winSetup]) {
    if (names.includes(name)) wanted.push(name);
  }

  // electron-updater: latest.yml + blockmaps (differential NSIS / AppImage)
  for (const name of ['latest.yml', 'latest-linux.yml']) {
    if (names.includes(name)) wanted.push(name);
  }

  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.appimage') && name.includes(ver)) {
      wanted.push(name);
    }
    if (lower.endsWith('.deb') && name.includes(ver)) {
      wanted.push(name);
    }
    if (lower.endsWith('.blockmap')) {
      // setup.exe.blockmap, AppImage.blockmap, portable blockmap if present
      if (name.includes(ver) || /MultiHeiz/i.test(name)) {
        wanted.push(name);
      }
    }
    if (name === 'SHA256SUMS.txt') {
      wanted.push(name);
    }
  }

  return [...new Set(wanted)];
}

function pruneOldReleases(keep) {
  if (keep === undefined) keep = 2;
  if (!fs.existsSync(RELEASES)) return;

  const dirs = fs
    .readdirSync(RELEASES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && parseSemver(d.name))
    .map((d) => d.name)
    .sort(compareSemverDesc);

  const toDelete = dirs.slice(keep);
  const oldRoot = path.join(ROOT, '_local', 'old-releases');
  for (const ver of toDelete) {
    const dir = path.join(RELEASES, ver);
    const dest = path.join(oldRoot, ver);
    try {
      fs.mkdirSync(oldRoot, { recursive: true });
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      fs.renameSync(dir, dest);
      console.log(
        '[release] versão antiga movida:',
        path.relative(ROOT, dir),
        '->',
        path.relative(ROOT, dest)
      );
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(
        '[release] removida versão antiga (fallback):',
        path.relative(ROOT, dir),
        err && err.message ? err.message : ''
      );
    }
  }

  if (dirs.length) {
    console.log('[release] versões em releases/:', dirs.slice(0, keep).join(', ') || '(nenhuma)');
  }
}

function copyRootPortable(ver) {
  const src = path.join(DIST, 'MultiHeiz-' + ver + '-portable.exe');
  if (!fs.existsSync(src)) {
    console.log('[release] portable win não encontrado em dist/ — skip raiz');
    return false;
  }

  try {
    fs.copyFileSync(src, ROOT_PORTABLE);
    console.log('[release] raiz atualizada:', path.basename(ROOT_PORTABLE));
    return true;
  } catch (err) {
    const code = err && err.code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
      console.warn(
        '[release] AVISO: não foi possível atualizar MultiHeiz-portable.exe na raiz' +
          ' (' + code + '). Feche o app se estiver aberto e rode de novo, ou copie manualmente.'
      );
      return false;
    }
    throw err;
  }
}

function main() {
  console.log('[release] versão:', version);

  // Generate SHA256SUMS.txt for whatever is currently in dist/
  try {
    const { main: writeSums } = require('./sha256sums');
    writeSums();
  } catch (err) {
    console.warn('[release] sha256sums:', err && err.message ? err.message : err);
  }

  const artifacts = collectArtifacts(version);
  if (!artifacts.length) {
    console.warn('[release] nenhum artefato da versão', version, 'em dist/');
  } else {
    const destDir = path.join(RELEASES, version);
    ensureDir(destDir);
    for (const name of artifacts) {
      copyFile(path.join(DIST, name), path.join(destDir, name));
    }
  }

  pruneOldReleases(2);
  copyRootPortable(version);
  console.log('[release] ok');
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[release] erro:', err.message || err);
    process.exit(1);
  }
}

module.exports = {
  collectArtifacts,
  pruneOldReleases,
  copyRootPortable,
  parseSemver,
  compareSemverDesc,
};
