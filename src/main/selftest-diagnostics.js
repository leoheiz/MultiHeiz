'use strict';

/**
 * In-process diagnostics selftest (MULTIHEIZ_SELFTEST=diagnostics).
 * Seeds fake PII/secrets, builds report, asserts sanitizer + GitHub issue URL.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

/**
 * @param {object} ctx
 */
async function runDiagnosticsSelftest(ctx) {
  const { updateState, flushSave, sleep } = ctx || {};
  const diagnostics = require('./diagnostics');
  const diagLog = require('./diag-log');

  console.log('SELFTEST diagnostics');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  const fakeEmail = 'fulano.teste@example.com';
  const fakeUrl = 'https://secret.example.org/private?token=abc123';
  const fakeProxyPass = 'ProxyPass-Segredo-999';
  const fakeAiKey = 'sk-test-1234567890abcdef';
  const fakeUser = 'LeoFakeDiagUser';
  const fakePath = process.platform === 'win32'
    ? `C:\\Users\\${fakeUser}\\AppData\\Roaming\\MultiHeiz\\secret.txt`
    : `/home/${fakeUser}/.config/MultiHeiz/secret.txt`;

  // Path embeds fake username; URL embeds secret host — both must be scrubbed in the report.
  diagLog.recordMainError('falha ao abrir ' + fakeUrl + ' path=' + fakePath, {
    path: fakePath,
  });
  diagLog.flushQueue();

  if (typeof updateState === 'function') {
    updateState((s) => {
      if (!s.settings || typeof s.settings !== 'object') s.settings = {};
      if (!s.settings.aiWrite) s.settings.aiWrite = {};
      s.settings.aiWrite.enabled = true;
      s.settings.aiWrite.apiKey = fakeAiKey;
      s.settings.aiWrite.apiKeyEnc = null;
      if (!s.workspaces.some((w) => w.id === 'ws-default')) {
        s.workspaces.push({ id: 'ws-default', name: 'Default' });
      }
      s.activeWorkspaceId = 'ws-default';
      s.accounts = [
        {
          id: 'acc-diag-1',
          name: fakeEmail,
          workspaceId: 'ws-default',
          color: '#4a9',
          catalogId: 'whatsapp',
          startUrl: fakeUrl,
          lastUrl: fakeUrl,
          proxyPassword: fakeProxyPass,
          proxy: {
            mode: 'http',
            host: '127.0.0.1',
            port: 8080,
            username: 'proxyuser',
            password: fakeProxyPass,
          },
        },
        {
          id: 'acc-diag-2',
          name: 'Custom',
          workspaceId: 'ws-default',
          color: '#a94',
          startUrl: 'https://example.com/',
          lastUrl: 'https://example.com/',
        },
      ];
    });
    if (typeof flushSave === 'function') flushSave();
  }

  const outPath =
    process.env.MULTIHEIZ_DIAG_OUT ||
    path.join(app.getPath('temp'), 'multiheiz-diag-selftest.txt');
  process.env.MULTIHEIZ_DIAG_OUT = outPath;

  const preview = diagnostics.previewDiagnostics();
  assert(preview && preview.ok && preview.preview, 'preview ok');
  const report = preview.preview;

  const banned = [fakeEmail, fakeUrl, 'secret.example.org', fakeProxyPass, fakeAiKey, fakeUser, 'token=abc123'];
  for (const b of banned) {
    assert(!report.includes(b), 'report must not contain: ' + b);
  }
  assert(/<url>|<email>|<token>|<user>|%USERPROFILE%|~/.test(report), 'sanitizer placeholders present');
  assert(/## Versão|app:/i.test(report), 'version section');
  assert(report.includes(app.getVersion()), 'app version in report');
  assert(/## Sistema|platform:/i.test(report), 'OS section');
  assert(/## GPU|getGPUFeatureStatus/i.test(report), 'GPU section');
  assert(/## Settings|## Adblock|## Crash count/i.test(report), 'required sections');
  console.log('PASS: report sanitized + sections present');

  const exported = await diagnostics.exportDiagnostics(null, {});
  assert(exported && exported.ok && exported.path, 'export to fixed path');
  assert(exported.selftest === true, 'selftest export flag');
  assert(fs.existsSync(exported.path), 'export file exists');
  const disk = fs.readFileSync(exported.path, 'utf8');
  for (const b of banned) {
    assert(!disk.includes(b), 'saved report must not contain: ' + b);
  }
  console.log('PASS: export to fixed temp path (no dialog)');

  const issue = diagnostics.openGithubIssue();
  assert(issue && issue.ok && issue.url, 'github issue url');
  assert(issue.stubbed === true, 'selftest stubs openExternal');
  assert(issue.url.startsWith(diagnostics.GITHUB_ISSUES_NEW), 'issues/new base');
  assert(issue.url.includes(encodeURIComponent(app.getVersion())) || issue.url.includes(app.getVersion()), 'issue has version');
  assert(!issue.url.includes(fakeEmail), 'issue URL no email');
  assert(!issue.url.includes('secret.example'), 'issue URL no panel host');
  assert(!issue.url.includes(fakeAiKey), 'issue URL no AI key');
  assert(!/token=abc123/.test(decodeURIComponent(issue.url)), 'issue URL no token');
  // Body should only mention version/OS — not report contents
  const decoded = decodeURIComponent(issue.url);
  assert(!decoded.includes(report.slice(0, 80)), 'issue must not embed report');
  console.log('PASS: GitHub issue URL has version/OS only');

  // Unit: sanitizeText directly
  const sample = [
    fakeEmail,
    fakeUrl,
    fakeAiKey,
    'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFBPJxXgtfc',
    fakePath,
    'https://easylist.to/easylist/easylist.txt',
  ].join('\n');
  const cleaned = diagnostics.sanitizeText(sample, {
    username: fakeUser,
    homedir: process.platform === 'win32' ? `C:\\Users\\${fakeUser}` : `/home/${fakeUser}`,
  });
  assert(!cleaned.includes(fakeEmail), 'sanitize email');
  assert(!cleaned.includes(fakeUrl), 'sanitize url');
  assert(cleaned.includes('<url>') || cleaned.includes('easylist.to'), 'url redaction');
  assert(cleaned.includes('https://easylist.to'), 'known filter host kept');
  assert(!cleaned.includes(fakeAiKey), 'sanitize ai key');
  assert(!cleaned.includes(fakeUser), 'sanitize username');
  console.log('PASS: sanitizeText unit checks');

  if (typeof sleep === 'function') await sleep(50);

  console.log('PASS: selftest diagnostics complete');
  app.exit(0);
}

module.exports = { runDiagnosticsSelftest };
