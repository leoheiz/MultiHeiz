'use strict';

/**
 * Fail if any .js/.json/.html/.css/.md under src, tools, docs is not valid UTF-8,
 * or has a BOM / NUL bytes. (PowerShell Out-File/Set-Content defaults often write
 * UTF-16 LE — never use those for source files.)
 *
 * Uso: npm run check:encoding
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ROOTS = ['src', 'tools', 'docs'];
const EXT_RE = /\.(js|json|html|css|md)$/i;

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (EXT_RE.test(ent.name)) out.push(p);
  }
}

/**
 * @param {Buffer} buf
 * @returns {string[]}
 */
function issuesFor(buf) {
  /** @type {string[]} */
  const issues = [];
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    issues.push('UTF-8 BOM');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    issues.push('UTF-16 LE BOM');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    issues.push('UTF-16 BE BOM');
  }
  if (buf.includes(0)) {
    issues.push('NUL byte (often UTF-16 without BOM)');
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    issues.push('invalid UTF-8');
  }
  return issues;
}

function main() {
  /** @type {string[]} */
  const files = [];
  for (const r of ROOTS) walk(path.join(ROOT, r), files);
  files.sort();

  let bad = 0;
  for (const file of files) {
    const buf = fs.readFileSync(file);
    const issues = issuesFor(buf);
    if (issues.length) {
      bad += 1;
      console.error('FAIL:', path.relative(ROOT, file), '—', issues.join(', '));
    }
  }

  if (bad) {
    console.error(
      `\ncheck:encoding failed: ${bad} file(s). Rewrite as UTF-8 without BOM (node fs.writeFileSync(..., 'utf8')).`
    );
    process.exit(1);
  }
  console.log(`PASS: check:encoding (${files.length} files, UTF-8 no BOM/NUL)`);
  process.exit(0);
}

main();
