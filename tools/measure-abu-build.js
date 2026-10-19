'use strict';

/**
 * Measure Ghostery engine build time/memory for default lists ± ABU sets.
 * Each scenario runs in a fresh child process so RSS/heap are not polluted.
 *
 * Uso: node tools/measure-abu-build.js
 *      node tools/measure-abu-build.js --scenario=a|b|c   (internal child)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const scenarioArg = process.argv.find((a) => a.startsWith('--scenario='));
const isChild = !!scenarioArg;

const ABU_LIGHT = ['abu_ad', 'abu_security', 'abu_anticircumvention', 'abu_spanish_portuguese'];
const ABU_PRIVACY = ['abu_privacy'];

function memSnap() {
  const m = process.memoryUsage();
  return {
    rssMb: Math.round((m.rss / (1024 * 1024)) * 10) / 10,
    heapUsedMb: Math.round((m.heapUsed / (1024 * 1024)) * 10) / 10,
  };
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MultiHeiz-Adblock-measure/1.2.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function runScenario(name, listIds, cacheDir) {
  const { FiltersEngine } = require('@ghostery/adblocker');
  const { LISTS } = require('../src/main/adblock/lists');
  const { preprocessAbuList, shouldPreprocessList, emptyStats, mergeStats } =
    require('../src/main/adblock/preprocess');

  async function ensureList(id) {
    const def = LISTS[id];
    if (!def) throw new Error('unknown list ' + id);
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = path.join(cacheDir, def.file);
    if (fs.existsSync(file) && fs.statSync(file).size > 100) {
      return fs.readFileSync(file, 'utf8');
    }
    process.stderr.write(`  download ${id}… `);
    const body = await fetchText(def.url);
    fs.writeFileSync(file, body, 'utf8');
    process.stderr.write(`${(Buffer.byteLength(body) / (1024 * 1024)).toFixed(1)} MB\n`);
    return body;
  }

  if (global.gc) global.gc();
  const before = memSnap();
  const t0 = Date.now();
  const chunks = [];
  const preprocess = emptyStats();
  for (const id of listIds) {
    let body = await ensureList(id);
    const def = LISTS[id];
    if (shouldPreprocessList(def)) {
      const pre = await preprocessAbuList(body);
      mergeStats(preprocess, pre.stats);
      body = pre.text;
    }
    chunks.push(body);
  }
  const text = chunks.join('\n');
  const tGather = Date.now() - t0;
  const tParse0 = Date.now();
  const engine = FiltersEngine.parse(text, {
    loadNetworkFilters: true,
    loadCosmeticFilters: true,
    loadGenericCosmeticsFilters: true,
    enableCompression: true,
    enableOptimizations: true,
  });
  const parseMs = Date.now() - tParse0;
  const totalMs = Date.now() - t0;
  const after = memSnap();
  let network = 0;
  let cosmetic = 0;
  try {
    const f = engine.getFilters();
    network = f.networkFilters.length;
    cosmetic = f.cosmeticFilters.length;
  } catch {
    /* ignore */
  }
  return {
    name,
    listCount: listIds.length,
    gatherMs: tGather,
    parseMs,
    buildMs: totalMs,
    before,
    after,
    deltaRssMb: Math.round((after.rssMb - before.rssMb) * 10) / 10,
    deltaHeapMb: Math.round((after.heapUsedMb - before.heapUsedMb) * 10) / 10,
    network,
    cosmetic,
    preprocess,
  };
}

async function childMain() {
  const key = scenarioArg.split('=')[1];
  const cacheDir = process.env.MULTIHEIZ_ABU_CACHE;
  if (!cacheDir) throw new Error('MULTIHEIZ_ABU_CACHE required');
  const { defaultListFlags } = require('../src/main/adblock/lists');
  const defaults = Object.keys(defaultListFlags()).filter((id) => defaultListFlags()[id]);
  const map = {
    a: { name: '(a) defaults', ids: defaults },
    b: { name: '(b) defaults + ABU light', ids: [...defaults, ...ABU_LIGHT] },
    c: { name: '(c) (b) + abu_privacy', ids: [...defaults, ...ABU_LIGHT, ...ABU_PRIVACY] },
  };
  const sc = map[key];
  if (!sc) throw new Error('unknown scenario ' + key);
  const result = await runScenario(sc.name, sc.ids, cacheDir);
  process.stdout.write(JSON.stringify(result));
}

async function parentMain() {
  const cacheDir = process.env.MULTIHEIZ_USERDATA
    ? path.join(process.env.MULTIHEIZ_USERDATA, 'adblock')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-abu-measure-'));
  fs.mkdirSync(cacheDir, { recursive: true });

  console.log('MultiHeiz measure-abu-build');
  console.log('cacheDir:', cacheDir);

  // Prefetch all lists in parent so children only parse
  const { LISTS, defaultListFlags } = require('../src/main/adblock/lists');
  const defaults = Object.keys(defaultListFlags()).filter((id) => defaultListFlags()[id]);
  const allIds = [...defaults, ...ABU_LIGHT, ...ABU_PRIVACY];
  console.log('\nDownloading / caching lists…');
  for (const id of allIds) {
    const def = LISTS[id];
    const file = path.join(cacheDir, def.file);
    if (fs.existsSync(file) && fs.statSync(file).size > 100) {
      console.log(`  cached ${id}`);
      continue;
    }
    process.stdout.write(`  download ${id}… `);
    const body = await fetchText(def.url);
    fs.writeFileSync(file, body, 'utf8');
    console.log(`${(Buffer.byteLength(body) / (1024 * 1024)).toFixed(1)} MB`);
  }

  const results = [];
  for (const key of ['a', 'b', 'c']) {
    console.log(`\nMeasuring scenario ${key} (fresh process)…`);
    const r = spawnSync(
      process.execPath,
      ['--expose-gc', path.join(root, 'tools', 'measure-abu-build.js'), `--scenario=${key}`],
      {
        cwd: root,
        env: { ...process.env, MULTIHEIZ_ABU_CACHE: cacheDir },
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    if (r.status !== 0) {
      console.error(r.stderr || r.stdout);
      throw new Error(`scenario ${key} failed status=${r.status}`);
    }
    const result = JSON.parse(r.stdout.trim().split('\n').pop());
    results.push(result);
    console.log(
      `  buildMs=${result.buildMs} ΔRSS=${result.deltaRssMb} Δheap=${result.deltaHeapMb} net=${result.network} cos=${result.cosmetic} conv/drop=${result.preprocess.scriptletsConverted}/${result.preprocess.scriptletsDropped}`
    );
  }

  const outPath = path.join(cacheDir, 'abu-build-measure.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        when: new Date().toISOString(),
        platform: process.platform,
        node: process.version,
        cacheDir,
        results,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log('\nWrote', outPath);

  console.log('\n--- markdown snippet ---');
  console.log(
    '| Scenario | build (ms) | ΔRSS (MB) | Δheap (MB) | RSS after (MB) | network | cosmetic | scriptlets conv/drop | AG-only dropped |'
  );
  console.log(
    '|----------|------------|-----------|------------|----------------|---------|----------|----------------------|-----------------|'
  );
  for (const r of results) {
    console.log(
      `| ${r.name} | ${r.buildMs} | ${r.deltaRssMb} | ${r.deltaHeapMb} | ${r.after.rssMb} | ${r.network} | ${r.cosmetic} | ${r.preprocess.scriptletsConverted}/${r.preprocess.scriptletsDropped} | ${r.preprocess.adguardOnlyDropped} |`
    );
  }

  const c = results[2];
  const heavy =
    c && (c.deltaRssMb > 400 || c.buildMs > 15000 || c.after.rssMb > 900);
  console.log(
    '\nPrivacy default OFF recommendation:',
    heavy ? 'KEEP OFF (heavy)' : 'optional (within budget)',
    `ΔRSS=${c.deltaRssMb} buildMs=${c.buildMs} rssAfter=${c.after.rssMb}`
  );
}

(isChild ? childMain() : parentMain()).catch((err) => {
  console.error('FAIL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
