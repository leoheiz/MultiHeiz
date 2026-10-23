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
  if (fs.existsSync(notesPath)) {
    const notes = fs.readFileSync(notesPath, 'utf8');
    const badNotes = notes.match(/\b(htzfm|youtube|google|claude|certisign|talkjs|whatsapp)\b/i);
    assert(!badNotes, 'release-notes-1.3.1.md has site name', badNotes && badNotes[0]);
    console.log('PASS: release-notes-1.3.1.md no site names');
  }

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
  console.log('PASS: renderer wires groups + releases link (no openExternal loosen)');

  const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
  assert(css.includes('novidades-entry-text'), 'CSS entry wrap');
  assert(css.includes('overflow-wrap'), 'CSS overflow-wrap');
  console.log('PASS: CSS wrap for long lines');

  const validated = changelog.validateChangelog(data);
  assert(validated.ok, 'validateChangelog', validated);
  console.log('PASS: validateChangelog');

  console.log('PASS: selftest:changelog complete');
}

main();
