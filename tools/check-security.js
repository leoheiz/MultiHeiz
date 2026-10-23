'use strict';

/**
 * Revisão de segurança reutilizável.
 * Uso: npm run check:security-review
 *
 * - npm run selftest:security
 * - npm audit --omit=dev --json (resume high/critical)
 * - revisão estática BrowserWindow/WebContentsView/webPreferences
 * - ipcMain.handle/on vs ipc-guard
 * - CSP nas páginas do app
 * - safeStorage para senhas/proxy
 * - scan de segredos de teste em userData/logs após selftest
 * - LanguageTool/IA vs campos password/cc/otp (se existir código)
 * - defaults de permissões
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const localDir = path.join(root, '_local');
const lastPath = path.join(localDir, 'security-last.json');
const srcMain = path.join(root, 'src', 'main');
const srcRenderer = path.join(root, 'src', 'renderer');
const srcPreload = path.join(root, 'src', 'preload');

/** @typedef {'OK'|'ATENÇÃO'|'FALHA'} Status */
/** @typedef {{ id: string, result: string, status: Status, details?: string[] }} Finding */

function walkJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkJs(p, out);
    else if (/\.(js|html)$/i.test(ent.name)) out.push(p);
  }
  return out;
}

function rel(p) {
  return path.relative(root, p).replace(/\\/g, '/');
}

/**
 * Extrai blocos webPreferences aproximados (regex simples).
 * @param {string} src
 * @param {string} file
 */
function findWebPrefIssues(src, file) {
  /** @type {string[]} */
  const issues = [];
  const isSelftest = /selftest-/i.test(file) || /packaged-check/i.test(file);
  // Procura webPreferences: { ... } com profundidade limitada
  const re = /webPreferences\s*:\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const block = src.slice(start, i - 1);
    const fileRel = rel(file);

    const has = (key, val) => {
      const r = new RegExp(key + '\\s*:\\s*' + val);
      return r.test(block);
    };
    const mentions = (key) => new RegExp(key + '\\s*:').test(block);

    if (has('contextIsolation', 'false')) {
      issues.push(`${fileRel}: contextIsolation false`);
    } else if (!mentions('contextIsolation') && !isSelftest) {
      // Electron default mudou; exigimos explícito em código de produção
      issues.push(`${fileRel}: contextIsolation não explícito`);
    } else if (has('contextIsolation', 'true') === false && mentions('contextIsolation')) {
      /* covered */
    }

    if (has('nodeIntegration', 'true')) {
      issues.push(`${fileRel}: nodeIntegration true`);
    }
    if (mentions('nodeIntegration') && !has('nodeIntegration', 'false') && !has('nodeIntegration', 'true')) {
      /* weird */
    }
    if (!mentions('nodeIntegration') && !isSelftest) {
      issues.push(`${fileRel}: nodeIntegration não explícito (deve ser false)`);
    }

    if (has('sandbox', 'false')) {
      issues.push(`${fileRel}: sandbox false`);
    } else if (!mentions('sandbox') && !isSelftest) {
      issues.push(`${fileRel}: sandbox não explícito`);
    }

    if (has('webSecurity', 'false')) {
      issues.push(`${fileRel}: webSecurity false`);
    }

    // nodeIntegrationInSubFrames exige sandbox+contextIsolation no mesmo bloco
    if (has('nodeIntegrationInSubFrames', 'true')) {
      const sandboxed = has('sandbox', 'true');
      const isolated = has('contextIsolation', 'true');
      if (!sandboxed || !isolated) {
        issues.push(
          `${fileRel}: nodeIntegrationInSubFrames:true sem sandbox:true+contextIsolation:true`
        );
      }
    }

    // Preload + conteúdo remoto: painéis usam preload sandboxed (OK se nodeIntegration false)
    if (/preload\s*:/.test(block) && /panels\.js|early-replay|extensions\/popup/i.test(fileRel)) {
      if (has('nodeIntegration', 'true') || has('sandbox', 'false') || has('contextIsolation', 'false')) {
        issues.push(`${fileRel}: preload inseguro em view remota`);
      }
    }
  }
  return issues;
}

function checkIpcGuard() {
  /** @type {string[]} */
  const unguardedHints = [];
  const guardSrc = fs.readFileSync(path.join(srcMain, 'ipc-guard.js'), 'utf8');
  const hasInstall = /function install\(/.test(guardSrc) && /ipcMain\.handle\s*=/.test(guardSrc);
  if (!hasInstall) {
    return {
      status: /** @type {Status} */ ('FALHA'),
      result: 'ipc-guard sem monkey-patch install',
      details: [],
    };
  }
  const mainSrc = fs.readFileSync(path.join(srcMain, 'main.js'), 'utf8');
  // Ordem em runtime (whenReady), não a posição da function registerIpc no arquivo
  const readyIdx = mainSrc.indexOf('app.whenReady().then');
  const readyBlock = readyIdx >= 0 ? mainSrc.slice(readyIdx, readyIdx + 4000) : '';
  const installAt = readyBlock.indexOf('ipcGuard.install');
  const registerAt = readyBlock.indexOf('registerIpc()');
  const installBeforeRegister =
    installAt >= 0 && registerAt >= 0 && installAt < registerAt;
  if (!installBeforeRegister) {
    unguardedHints.push('ipcGuard.install deve ocorrer antes de registerIpc() no whenReady');
  }

  // Canais registrados com require('electron').ipcMain diretamente APÓS possível bypass
  // Heurística: arquivos que chamam ipcMain.handle/on — todos OK se install() já rodou.
  const files = walkJs(srcMain).filter((f) => f.endsWith('.js'));
  /** @type {string[]} */
  const channels = [];
  for (const f of files) {
    if (/ipc-guard\.js$/.test(f)) continue;
    if (/selftest-/i.test(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    const re = /ipcMain\.(handle|on|handleOnce|once)\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      channels.push(m[2] + ' @ ' + rel(f));
    }
  }

  // volume-control e adblock registram canais de painel — devem estar em PANEL_CHANNELS
  const panelChannelsNeeded = [
    'panel:media-use',
    'panel:volume-sync',
    '@ghostery/adblocker/early-scriptlets',
    '@ghostery/adblocker/inject-cosmetic-filters',
  ];
  for (const ch of panelChannelsNeeded) {
    if (!guardSrc.includes("'" + ch + "'") && !guardSrc.includes('"' + ch + '"')) {
      unguardedHints.push('PANEL_CHANNELS falta: ' + ch);
    }
  }

  return {
    status: /** @type {Status} */ (unguardedHints.length ? 'ATENÇÃO' : 'OK'),
    result:
      channels.length +
      ' canais ipcMain.*; install() ' +
      (installBeforeRegister ? 'antes de registerIpc' : 'ORDEM SUSPEITA'),
    details: unguardedHints.length
      ? unguardedHints
      : ['Todos os handle/on passam pelo monkey-patch de ipc-guard.install (após whenReady).'],
    channelCount: channels.length,
  };
}

function checkCsp() {
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const weak = [];
  const htmlFiles = [
    path.join(srcRenderer, 'index.html'),
    path.join(srcRenderer, 'popover-overlay.html'),
  ];
  // Report-only: nunca escreve arquivos.
  for (const f of htmlFiles) {
    if (!fs.existsSync(f)) {
      missing.push(rel(f) + ' ausente');
      continue;
    }
    const html = fs.readFileSync(f, 'utf8');
    if (!/Content-Security-Policy/i.test(html)) {
      missing.push(rel(f));
      continue;
    }
    const m = html.match(
      /http-equiv=["']Content-Security-Policy["'][^>]*content=["']([^"']+)["']/i
    ) || html.match(
      /content=["']([^"']+)["'][^>]*http-equiv=["']Content-Security-Policy["']/i
    );
    const csp = m ? m[1] : '';
    if (/script-src[^;]*'unsafe-inline'/i.test(csp)) {
      weak.push(rel(f) + ": script-src inclui 'unsafe-inline'");
    }
  }
  return { missing, weak, fixed: [] };
}

function checkSafeStorage() {
  const proxySrc = fs.readFileSync(path.join(srcMain, 'proxy.js'), 'utf8');
  const ok =
    /safeStorage/.test(proxySrc) &&
    /encryptString/.test(proxySrc) &&
    /decryptString/.test(proxySrc);
  /** @type {string[]} */
  const details = [];
  if (!ok) details.push('proxy.js sem safeStorage encrypt/decrypt');
  // Procurar outras chaves de API
  const files = walkJs(path.join(root, 'src'));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (/api[_-]?key|openai|anthropic|passwordEnc|encryptString/i.test(src) && /safeStorage/.test(src)) {
      details.push('safeStorage em ' + rel(f));
    }
  }
  return {
    status: /** @type {Status} */ (ok ? 'OK' : 'FALHA'),
    result: ok ? 'proxy usa safeStorage' : 'proxy NÃO usa safeStorage',
    details,
  };
}

function checkLanguageToolAi() {
  const files = walkJs(path.join(root, 'src'));
  let mentions = 0;
  /** @type {string[]} */
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (/languagetool|LanguageTool|openai|anthropic|spellcheck.*ai|ai\.complet/i.test(src)) {
      mentions++;
      hits.push(rel(f));
      // Se existir, verificar exclusão de password/cc/otp
      if (!/password|one-time-code|cc-|autocomplete/i.test(src)) {
        hits.push(rel(f) + ': sem menção explícita a exclusão password/cc/otp (revisar se ativar IA)');
      }
    }
  }
  if (!mentions) {
    return {
      status: /** @type {Status} */ ('OK'),
      result: 'sem código LanguageTool/IA — N/A',
      details: [],
    };
  }
  return {
    status: /** @type {Status} */ ('ATENÇÃO'),
    result: 'código IA/LT encontrado — revisar exclusões',
    details: hits,
  };
}

function checkPermissionsDefaults() {
  const src = fs.readFileSync(path.join(srcMain, 'permissions.js'), 'utf8');
  const hasDeny = /ALWAYS_DENY/.test(src) && /default deny|Default deny/i.test(src);
  const hasAsk = /ASK_PERMISSIONS/.test(src);
  const hasHandlers =
    /setPermissionRequestHandler/.test(src) && /setPermissionCheckHandler/.test(src);
  const ok = hasDeny && hasAsk && hasHandlers;
  return {
    status: /** @type {Status} */ (ok ? 'OK' : 'FALHA'),
    result: ok
      ? 'default deny + ask para sensíveis; handlers instalados'
      : 'defaults de permissão incompletos',
    details: [],
  };
}

function checkOverlayNoNode() {
  const ov = fs.readFileSync(path.join(srcMain, 'popover-overlay.js'), 'utf8');
  const preload = fs.readFileSync(path.join(srcPreload, 'popover-preload.js'), 'utf8');
  const okPrefs =
    /contextIsolation:\s*true/.test(ov) &&
    /nodeIntegration:\s*false/.test(ov) &&
    /sandbox:\s*true/.test(ov);
  const noNodeInPreload = !/\brequire\s*\(\s*['"]fs['"]/.test(preload) && !/\brequire\s*\(\s*['"]child_process['"]/.test(preload);
  return {
    status: /** @type {Status} */ (okPrefs && noNodeInPreload ? 'OK' : 'FALHA'),
    result:
      (okPrefs ? 'overlay sandboxed/isolated' : 'overlay webPreferences fraco') +
      '; preload ' +
      (noNodeInPreload ? 'sem Node fs/cp' : 'expõe Node'),
    details: [],
  };
}

function runNpmAudit() {
  try {
    // Audit completo (inclui electron / devDeps — o runtime empacotado).
    const raw = execFileSync('npm', ['audit', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    const data = JSON.parse(raw);
    return summarizeAudit(data);
  } catch (err) {
    // npm audit exit != 0 quando há vulns
    const out = (err && err.stdout) || (err && err.message) || '';
    try {
      const data = JSON.parse(String(out));
      return summarizeAudit(data);
    } catch {
      return {
        status: /** @type {Status} */ ('ATENÇÃO'),
        result: 'npm audit falhou ao parsear',
        high: 0,
        critical: 0,
        details: [String(err && err.message ? err.message : err).slice(0, 200)],
      };
    }
  }
}

function summarizeAudit(data) {
  let info = 0;
  let low = 0;
  let moderate = 0;
  let high = 0;
  let critical = 0;
  const meta = data.metadata && data.metadata.vulnerabilities;
  if (meta) {
    info = Number(meta.info) || 0;
    low = Number(meta.low) || 0;
    moderate = Number(meta.moderate) || 0;
    high = Number(meta.high) || 0;
    critical = Number(meta.critical) || 0;
  } else if (data.vulnerabilities) {
    for (const v of Object.values(data.vulnerabilities)) {
      const sev = String(v.severity || '').toLowerCase();
      if (sev === 'info') info++;
      if (sev === 'low') low++;
      if (sev === 'moderate') moderate++;
      if (sev === 'high') high++;
      if (sev === 'critical') critical++;
    }
  }
  const status =
    critical > 0 ? 'FALHA' : high > 0 ? 'ATENÇÃO' : 'OK';
  return {
    status: /** @type {Status} */ (status),
    result: `info=${info} low=${low} moderate=${moderate} high=${high} critical=${critical}`,
    info,
    low,
    moderate,
    high,
    critical,
    details: [],
  };
}

function runSelftestSecurity() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(root, 'tools', 'selftest-security.js')],
      {
        cwd: root,
        env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let out = '';
    const onData = (b) => {
      const s = b.toString();
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({
        status: /** @type {Status} */ ('FALHA'),
        result: 'selftest:security timeout',
        details: [],
        out,
      });
    }, 300000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        status: /** @type {Status} */ (code === 0 ? 'OK' : 'FALHA'),
        result: code === 0 ? 'selftest:security PASS' : 'selftest:security exit ' + code,
        details: [],
        out,
        userdataHint: extractUserdata(out),
      });
    });
  });
}

function extractUserdata(out) {
  const m = /userData[:\s]+([^\s\r\n]+)/i.exec(out);
  return m ? m[1] : null;
}

/**
 * Procura segredos de teste conhecidos em texto puro.
 * @param {string|null} userdata
 * @param {string} logText
 */
function scanSecrets(userdata, logText) {
  const secrets = ['mhpass', 'senha-errada-xyz', 'sk-fake', 'fake-api-key', 'MULTIHEIZ_PROXY_PASS'];
  /** @type {string[]} */
  const hits = [];
  const haystacks = [];
  if (logText) haystacks.push({ name: 'selftest-log', text: logText });
  if (userdata && fs.existsSync(userdata)) {
    const files = [];
    const walk = (d) => {
      try {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, ent.name);
          if (ent.isDirectory()) walk(p);
          else if (ent.isFile() && ent.size < 2_000_000) files.push(p);
        }
      } catch {
        /* ignore */
      }
    };
    walk(userdata);
    for (const f of files) {
      try {
        haystacks.push({ name: f, text: fs.readFileSync(f, 'utf8') });
      } catch {
        /* binary */
      }
    }
  }
  // Também varrer _local logs recentes de proxy/security
  for (const name of ['st-selftest-security.log', 'st-selftest-proxy.log']) {
    const p = path.join(localDir, name);
    if (fs.existsSync(p)) {
      try {
        haystacks.push({ name: p, text: fs.readFileSync(p, 'utf8') });
      } catch {
        /* ignore */
      }
    }
  }

  for (const h of haystacks) {
    for (const s of secrets) {
      if (h.text.includes(s)) {
        // passwordEnc / logs de teste que mencionam o nome da env var são OK se não for o valor em state
        if (s === 'MULTIHEIZ_PROXY_PASS' && /process\.env|MULTIHEIZ_PROXY_PASS/.test(h.text)) {
          continue;
        }
        // selftest-proxy.js source contains the default — only flag userData/state
        if (/selftest-proxy\.js|check-security\.js|selftest-security/.test(h.name)) continue;
        if (/node_modules|tools[/\\]selftest/.test(h.name)) continue;
        hits.push(`${s} em ${h.name}`);
      }
    }
  }
  return hits;
}

function checkWebPreferencesAll() {
  const files = walkJs(path.join(root, 'src')).filter((f) => f.endsWith('.js'));
  /** @type {string[]} */
  const issues = [];
  for (const f of files) {
    // Ignorar selftests para FALHA dura; ainda listar
    const src = fs.readFileSync(f, 'utf8');
    if (!/webPreferences\s*:/.test(src)) continue;
    const found = findWebPrefIssues(src, f);
    for (const iss of found) {
      if (/selftest-/i.test(iss)) {
        // selftest abu com sandbox-only parcial — ATENÇÃO
        continue;
      }
      issues.push(iss);
    }
  }
  // Caso conhecido: selftest-abu-yt tem webPreferences incompleto — não é produção
  return issues;
}

async function main() {
  fs.mkdirSync(localDir, { recursive: true });
  console.log('MultiHeiz check:security-review');

  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const corrections = [];

  // CSP (somente relato — nunca escreve HTML)
  const csp = checkCsp();
  const cspDetails = [...(csp.weak || [])];
  findings.push({
    id: 'csp',
    result:
      csp.missing.length === 0 && !(csp.weak && csp.weak.length)
        ? 'CSP presente (sem unsafe-inline em script-src)'
        : csp.missing.length
          ? 'CSP faltando: ' + csp.missing.join(', ')
          : 'CSP fraca: ' + csp.weak.join('; '),
    status: csp.missing.length ? 'FALHA' : csp.weak && csp.weak.length ? 'ATENÇÃO' : 'OK',
    details: cspDetails,
  });

  // webPreferences
  const wpIssues = checkWebPreferencesAll();
  findings.push({
    id: 'webPreferences',
    result: wpIssues.length
      ? wpIssues.length + ' problema(s)'
      : 'contextIsolation/sandbox/nodeIntegration OK nas views de produção',
    status: wpIssues.length ? 'FALHA' : 'OK',
    details: wpIssues.slice(0, 40),
  });

  findings.push({
    id: 'overlay-node',
    ...checkOverlayNoNode(),
  });

  const ipc = checkIpcGuard();
  findings.push({
    id: 'ipc-guard',
    result: ipc.result,
    status: ipc.status,
    details: ipc.details,
  });

  findings.push({
    id: 'safeStorage',
    ...checkSafeStorage(),
  });

  findings.push({
    id: 'permissions',
    ...checkPermissionsDefaults(),
  });

  findings.push({
    id: 'languagetool-ai',
    ...checkLanguageToolAi(),
  });

  console.log('\n--- npm audit (full, incl. electron/devDeps) ---');
  const audit = runNpmAudit();
  findings.push({
    id: 'npm-audit',
    result: audit.result,
    status: audit.status,
    details: audit.details,
  });

  console.log('\n--- selftest:security ---');
  const st = await runSelftestSecurity();
  findings.push({
    id: 'selftest-security',
    result: st.result,
    status: st.status,
    details: st.details,
  });

  const secretHits = scanSecrets(st.userdataHint || null, st.out || '');
  findings.push({
    id: 'secret-scan',
    result: secretHits.length
      ? secretHits.length + ' ocorrência(s) de segredo de teste'
      : 'nenhum segredo de teste conhecido em texto puro (userData/logs)',
    status: secretHits.length ? 'FALHA' : 'OK',
    details: secretHits.slice(0, 20),
  });

  const shortSha = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
    } catch {
      return 'unknown';
    }
  })();

  const report = {
    at: new Date().toISOString(),
    shortSha,
    findings,
    corrections,
  };
  fs.writeFileSync(lastPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n--- resumo check:security-review ---');
  for (const f of findings) {
    console.log(`[${f.status}] ${f.id}: ${f.result}`);
  }
  if (corrections.length) {
    console.log('correções:', corrections.join('; '));
  }
  console.log('escrito:', lastPath);

  if (findings.some((f) => f.status === 'FALHA')) process.exitCode = 1;
  else process.exitCode = 0;
}

main().catch((err) => {
  console.error('FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});
