'use strict';

/**
 * Selftest: in-app update notes (changelog.json + novidades view model).
 * Uso: npm run selftest:changelog
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function assert(cond, msg, extra) {
  if (!cond) {
    console.log('FAIL:', msg, extra !== undefined ? extra : '');
    process.exit(1);
  }
}

const FORBIDDEN =
  /\b(htzfm|r[aá]dio|radio|youtube|google|claude|certisign|talkjs|whatsapp|ipc|preload|\bcss\b|selftest)\b/i;

function entryBlob(ver) {
  return (ver.entries || []).map((e) => String(e.text || '')).join('\n');
}

function hasGroups(ver) {
  const tags = new Set((ver.entries || []).map((e) => String(e.tag || '')));
  const hasNov = tags.has('Novo') || tags.has('Melhoria');
  const hasCor = tags.has('Correção');
  return hasNov && hasCor;
}

function checkVersion(ver, label) {
  assert(ver, `missing ${label}`);
  assert(hasGroups(ver), `${label} must have Novidades + Correções (Novo/Melhoria + Correção)`);
  const blob = `${ver.title || ''}\n${entryBlob(ver)}`;
  const bad = blob.match(FORBIDDEN);
  assert(!bad, `${label} contains forbidden word`, bad && bad[0]);
  assert(!/\b[0-9a-f]{7,40}\b/i.test(blob), `${label} looks like commit id`);
  assert(!/\.(js|json|css|html|md)\b/i.test(blob), `${label} mentions file names`);
  console.log(`PASS: ${label} clean + both groups`);
}

/** Build Novidades/Correções markdown from changelog entries (same grouping as UI). */
function toNotesSections(ver) {
  const nov = [];
  const cor = [];
  for (const e of ver.entries || []) {
    const line = `- ${String(e.text || '').trim()}`;
    if (String(e.tag || '') === 'Correção') cor.push(line);
    else nov.push(line);
  }
  return (
    `### Novidades\n${nov.join('\n')}\n\n### Correções\n${cor.join('\n')}`
  );
}

function extractNotesSections(md) {
  const m = String(md || '').match(
    /### Novidades\r?\n([\s\S]*?)\r?\n### Correções\r?\n([\s\S]*?)(?=\r?\n### |\r?\n\*\*Por comando\*\*|\r?\n## |$)/
  );
  assert(m, 'release-notes has ### Novidades + ### Correções');
  const nov = m[1]
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const cor = m[2]
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('###'));
  return { nov, cor, blob: `### Novidades\n${nov.join('\n')}\n\n### Correções\n${cor.join('\n')}` };
}

function main() {
  console.log('MultiHeiz selftest:changelog');

  const changelogPath = path.join(root, 'src', 'changelog.json');
  const data = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
  assert(data && Array.isArray(data.versions), 'changelog.versions');

  const v131 = data.versions.find((v) => v.version === '1.3.1');
  const v130 = data.versions.find((v) => v.version === '1.3.0');
  checkVersion(v131, '1.3.1');
  checkVersion(v130, '1.3.0');

  const notesPath = path.join(root, '_local', 'release-notes-1.3.1.md');
  assert(fs.existsSync(notesPath), 'release-notes-1.3.1.md exists');
  const notes = fs.readFileSync(notesPath, 'utf8');
  const badNotes = notes.match(/\b(htzfm|youtube|google|claude|certisign|talkjs|whatsapp)\b/i);
  assert(!badNotes, 'release-notes-1.3.1.md has site name', badNotes && badNotes[0]);
  assert(notes.includes('### Downloads'), 'release-notes keeps Downloads');
  assert(notes.includes('**Por comando**'), 'release-notes keeps Por comando');
  assert(/SmartScreen|pode ser perigoso|assinatura digital/i.test(notes), 'release-notes keeps SmartScreen note');
  assert(/ko-fi\.com/i.test(notes), 'release-notes keeps support footer');
  console.log('PASS: release-notes-1.3.1.md footer sections intact');

  const expected = toNotesSections(v131);
  const extracted = extractNotesSections(notes);
  assert(
    extracted.blob === expected,
    'release-notes Novidades/Correções identical to changelog 1.3.1',
    { expected: expected.slice(0, 200), got: extracted.blob.slice(0, 200) }
  );
  console.log('PASS: changelog 1.3.1 === release-notes Novidades/Correções');

  const changelog = require('../src/main/changelog');
  changelog.reloadChangelogForTest();
  const view = changelog.getNovidadesViewModel(data);
  assert(view.versions.length === 2, 'view shows exactly 2 versions', view.versions.length);
  assert(view.versions[0].version === '1.3.1', 'first is 1.3.1');
  assert(view.versions[1].version === '1.3.0', 'second is 1.3.0');
  for (const ver of view.versions) {
    const names = (ver.groups || []).map((g) => g.name);
    assert(names.includes('Novidades'), `${ver.version} group Novidades`, names);
    assert(names.includes('Correções'), `${ver.version} group Correções`, names);
  }
  assert(
    view.releasesUrl === 'https://github.com/leoheiz/MultiHeiz/releases',
    'releasesUrl',
    view.releasesUrl
  );
  assert(
    view.allReleasesLabel === 'Ver todas as notas de versão',
    'allReleasesLabel',
    view.allReleasesLabel
  );
  console.log('PASS: view model 2 versions + groups + releases link');

  const uiSrc = fs.readFileSync(path.join(root, 'src', 'renderer', 'v16-ui.js'), 'utf8');
  assert(uiSrc.includes('novidades-all-releases'), 'UI has all-releases link id');
  assert(uiSrc.includes('updatesOpenReleases'), 'UI opens releases via updatesOpenReleases');
  assert(uiSrc.includes('novidades-group'), 'UI renders group headers');
  assert(uiSrc.includes('novidades-entry-text'), 'UI wraps entry text');
  assert(uiSrc.includes('formatNovidadesDate'), 'UI formats date DD/MM/YYYY');
  assert(!/tagClass\s*\(/.test(uiSrc), 'UI no longer uses tagClass badges');
  assert(
    !/tag\.className\s*=\s*tagClass|tag-novo|textContent\s*=\s*entryTag/.test(uiSrc),
    'UI does not render Novo/Melhoria/Correção badges'
  );
  console.log('PASS: renderer wires groups + releases link (no badges)');

  const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
  assert(html.includes('id="novidades-list"'), 'HTML novidades-list');
  assert(html.includes('mh-scroll-dark'), 'HTML dark scrollbar class on list');
  assert(!html.includes('id="novidades-intro"'), 'HTML no intro subtitle under fixed header');
  console.log('PASS: HTML single-scroll novidades shell');

  const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
  assert(css.includes('novidades-entry-text'), 'CSS entry wrap');
  assert(css.includes('overflow-wrap'), 'CSS overflow-wrap');
  assert(/\.dlg-novidades\s*\{[^}]*width:\s*min\(720px,\s*90vw\)/s.test(css), 'CSS width min(720px, 90vw)');
  assert(
    /\.dlg-novidades\s*\{[^}]*overflow:\s*hidden/s.test(css),
    'CSS dlg-novidades overflow hidden (no outer scroll)'
  );
  assert(
    /\.novidades-list\s*\{[^}]*overflow-y:\s*auto/s.test(css),
    'CSS novidades-list is the scroll container'
  );
  assert(css.includes('.mh-scroll-dark'), 'CSS dark scrollbar helper');
  assert(
    /\.novidades-group\s*\{[^}]*font-size:\s*0\.95rem/s.test(css),
    'CSS group headings readable (~0.95rem)'
  );
  assert(!/\.tag-novo\s*\{/.test(css), 'CSS no Novo badge styles');
  console.log('PASS: CSS single scroll + readable headings + no badge styles');

  const validated = changelog.validateChangelog(data);
  assert(validated.ok, 'validateChangelog', validated);
  console.log('PASS: validateChangelog');

  /* ---- Configurações modal proportions (FIX-11 item 8) ---- */
  assert(
    /id="dlg-settings"[\s\S]*?class="settings-main"/.test(html) ||
      html.includes('class="settings-main"'),
    'HTML settings-main wrapper'
  );
  assert(
    /settings-nav[^>]*mh-scroll-dark/.test(html) &&
      /form-settings[^>]*mh-scroll-dark/.test(html),
    'HTML settings nav + body use dark scrollbar'
  );
  assert(html.includes('about-identity'), 'HTML Sobre version+engine one line');
  assert(html.includes('about-actions-row'), 'HTML Sobre buttons in a row');
  assert(html.includes('about-licenses-details'), 'HTML licenses collapsible');
  assert(html.includes('Ver licenças'), 'HTML Ver licenças summary');
  assert(html.includes('btn-open-third-party-notices'), 'HTML third-party notices link');
  assert(
    !/não empacota electron-chrome-extensions GPL-3/.test(html),
    'HTML no long GPL-3 extensions legalese'
  );
  assert(
    /\.dlg-settings-wide\s*\{[^}]*width:\s*min\(1000px,\s*92vw\)/s.test(css),
    'CSS settings width min(1000px, 92vw)'
  );
  assert(
    /\.dlg-settings-wide\s*\{[^}]*height:\s*min\(760px,\s*88vh\)/s.test(css),
    'CSS settings height min(760px, 88vh)'
  );
  assert(
    /\.dlg-settings-wide\s*\{[^}]*overflow:\s*hidden/s.test(css),
    'CSS settings dialog no outer scroll'
  );
  assert(/\.settings-nav\s*\{[^}]*width:\s*200px/s.test(css), 'CSS nav ~200px');
  assert(
    /\.settings-body\s*\{[^}]*overflow-y:\s*auto/s.test(css),
    'CSS body is the content scroll'
  );
  assert(/\.settings-pane\s*\{[^}]*max-width:\s*70ch/s.test(css), 'CSS max text width ~70ch');
  assert(
    /\.settings-body\s*\{[^}]*font-size:\s*13\.5px/s.test(css),
    'CSS body ~13-14px'
  );
  const noticesPath = path.join(root, 'THIRD_PARTY_NOTICES.md');
  assert(fs.existsSync(noticesPath), 'THIRD_PARTY_NOTICES.md exists');
  const notices = fs.readFileSync(noticesPath, 'utf8');
  assert(
    /electron-chrome-extensions/i.test(notices),
    'THIRD_PARTY_NOTICES has extensions legal details'
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert(
    Array.isArray(pkg.build && pkg.build.files) &&
      pkg.build.files.includes('THIRD_PARTY_NOTICES.md'),
    'electron-builder files includes THIRD_PARTY_NOTICES.md'
  );
  assert(
    Array.isArray(pkg.build && pkg.build.extraResources) &&
      pkg.build.extraResources.some(
        (r) => r && (r.from === 'THIRD_PARTY_NOTICES.md' || r === 'THIRD_PARTY_NOTICES.md')
      ),
    'electron-builder extraResources includes THIRD_PARTY_NOTICES.md'
  );
  assert(uiSrc.includes('openThirdPartyNotices'), 'UI wires openThirdPartyNotices');
  console.log('PASS: settings modal size + Sobre licenses + THIRD_PARTY_NOTICES');

  console.log('PASS: selftest:changelog complete');
}

main();
