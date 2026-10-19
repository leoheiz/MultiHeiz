'use strict';

/**
 * Read-only dry-run against the LIVE public GitHub releases.
 * Confirms what a 1.0.0 client would see for NSIS (latest.yml) and portable asset.
 * Uso: npm run check:update-live
 */

const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

const OWNER = 'leoheiz';
const REPO = 'MultiHeiz';
const CLIENT_VERSION = '1.0.0';

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https;
    const req = mod.get(
      url,
      {
        headers: {
          'User-Agent': 'MultiHeiz-check-update-live/1.1.0',
          Accept: '*/*',
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          get(new URL(res.headers.location, url).href, headers).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks) })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
  });
}

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

function parseLatestYml(text) {
  const version = (text.match(/(?:^|\n)version:\s*(\S+)/) || [])[1] || null;
  const pathName = (text.match(/(?:^|\n)path:\s*(\S+)/) || [])[1] || null;
  const sha512 = (text.match(/(?:^|\n)sha512:\s*(\S+)/) || [])[1] || null;
  const files = [];
  const fileBlocks = text.split(/\n\s*-\s+/).slice(1);
  for (const block of fileBlocks) {
    const url = (block.match(/url:\s*(\S+)/) || [])[1];
    const sha = (block.match(/sha512:\s*(\S+)/) || [])[1];
    if (url) files.push({ url, sha512: sha || null });
  }
  return { version, path: pathName, sha512, files, raw: text };
}

async function main() {
  const report = {
    clientVersion: CLIENT_VERSION,
    ok: true,
    nsis: null,
    portable: null,
    errors: [],
  };

  console.log('MultiHeiz check:update-live (read-only)');
  console.log('Simulated client version:', CLIENT_VERSION);

  // latest.yml (NSIS / electron-updater)
  const ymlUrl = `https://github.com/${OWNER}/${REPO}/releases/latest/download/latest.yml`;
  try {
    const ymlRes = await get(ymlUrl);
    if (ymlRes.status < 200 || ymlRes.status >= 300) {
      report.ok = false;
      report.errors.push(`latest.yml HTTP ${ymlRes.status}`);
      console.log('FAIL: latest.yml HTTP', ymlRes.status);
    } else {
      const parsed = parseLatestYml(ymlRes.body.toString('utf8'));
      const remote = parsed.version;
      const available = remote && compareSemver(CLIENT_VERSION, remote) < 0;
      const setupName =
        parsed.path ||
        (parsed.files.find((f) => /setup\.exe$/i.test(f.url || '')) || {}).url ||
        null;
      const hasSha = !!(parsed.sha512 || (parsed.files[0] && parsed.files[0].sha512));
      report.nsis = {
        version: remote,
        availableFor100: !!available,
        path: setupName,
        sha512Present: hasSha,
        sha512Prefix: (parsed.sha512 || '').slice(0, 24) || null,
      };
      console.log('NSIS latest.yml version:', remote);
      console.log('  1.0.0 would see update:', available ? 'YES' : 'NO');
      console.log('  setup path/name:', setupName);
      console.log('  sha512 present:', hasSha);
      if (!available || !setupName || !/setup\.exe$/i.test(String(setupName)) || !hasSha) {
        report.ok = false;
        report.errors.push('NSIS latest.yml incomplete or no newer version');
      }
    }
  } catch (err) {
    report.ok = false;
    report.errors.push('latest.yml: ' + ((err && err.message) || err));
    console.log('FAIL: latest.yml', err && err.message);
  }

  // GitHub API — portable asset
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
  try {
    const apiRes = await get(apiUrl, { Accept: 'application/vnd.github+json' });
    if (apiRes.status < 200 || apiRes.status >= 300) {
      report.ok = false;
      report.errors.push(`GitHub API HTTP ${apiRes.status}`);
      console.log('FAIL: GitHub API HTTP', apiRes.status);
    } else {
      const data = JSON.parse(apiRes.body.toString('utf8'));
      const tag = String(data.tag_name || '').replace(/^v/i, '');
      const portableRe = /^MultiHeiz-(\d+\.\d+\.\d+)-portable\.exe$/i;
      const asset = (data.assets || []).find((a) => portableRe.test(a.name || ''));
      if (!asset) {
        report.ok = false;
        report.errors.push('No portable asset on latest release');
        console.log('FAIL: no portable asset');
      } else {
        const m = asset.name.match(portableRe);
        report.portable = {
          tag,
          name: asset.name,
          version: m[1],
          size: asset.size,
          digest: asset.digest || null,
          availableFor100: compareSemver(CLIENT_VERSION, tag) < 0,
        };
        console.log('Portable asset:', asset.name);
        console.log('  size:', asset.size);
        console.log('  digest:', asset.digest || '(none)');
        console.log('  1.0.0 would see update:', report.portable.availableFor100 ? 'YES' : 'NO');
        if (!report.portable.availableFor100 || !asset.size) {
          report.ok = false;
          report.errors.push('Portable asset missing size or not newer than 1.0.0');
        }
      }
    }
  } catch (err) {
    report.ok = false;
    report.errors.push('API: ' + ((err && err.message) || err));
    console.log('FAIL: API', err && err.message);
  }

  // Semver sanity (offline)
  if (!(compareSemver('1.0.10', '1.0.9') > 0)) {
    report.ok = false;
    report.errors.push('semver 1.0.10 > 1.0.9 failed');
  } else {
    console.log('PASS: semver 1.0.10 > 1.0.9');
  }

  console.log('---');
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
