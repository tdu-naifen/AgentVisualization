// build-corpus.mjs — generate web/public/corpus.json from the shared markdown corpus.
//
// Reads every *.md file in the shared corpus (frontmatter + body) and emits a JSON
// array of Doc { id, title, summary, type, tags, body } sorted by id for determinism.
//
// No npm deps: frontmatter is parsed by hand with Node built-ins only.
//
// Source dir is resolved RELATIVE TO THIS SCRIPT (via import.meta.url), not cwd, so
// it works no matter where npm runs it. Two layouts are supported:
//   ../../reference/shared/corpus/raw_markdown/*.md   (current layout)
//   ../../00_shared/corpus/docs/*.md                  (older fallback layout)
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));

// ─── Locate the source directory (relative to this script) ────────────────────
const candidates = [
  resolve(scriptDir, '..', '..', 'reference', 'shared', 'corpus', 'raw_markdown'),
  resolve(scriptDir, '..', '..', '00_shared', 'corpus', 'docs'),
];
const srcDir = candidates.find((d) => existsSync(d));
if (!srcDir) {
  console.error('[build-corpus] ERROR: no corpus source directory found. Looked in:');
  for (const c of candidates) console.error('  - ' + c);
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip a single pair of matching surrounding quotes, if present. */
function stripQuotes(s) {
  const t = s.trim();
  if (
    t.length >= 2 &&
    ((t[0] === '"' && t[t.length - 1] === '"') ||
      (t[0] === "'" && t[t.length - 1] === "'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse an inline YAML list "[a, b, c]" (or "[]") into string[]. */
function parseTags(raw) {
  const t = raw.trim();
  // Bracketed inline list is the expected form; fall back to bare CSV otherwise.
  const inner =
    t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
  if (!inner.trim()) return [];
  return inner
    .split(',')
    .map((s) => stripQuotes(s))
    .filter((s) => s.length > 0);
}

/** Parse one markdown file's frontmatter + body into a Doc. */
function parseDoc(text, file) {
  // Normalize line endings and strip a leading BOM if present.
  const norm = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = norm.split('\n');

  if (lines[0].trim() !== '---') {
    throw new Error(`${file}: missing opening frontmatter delimiter '---'`);
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) {
    throw new Error(`${file}: missing closing frontmatter delimiter '---'`);
  }

  const fm = {};
  for (const line of lines.slice(1, close)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':'); // split on FIRST colon (titles contain colons)
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    fm[key] = val;
  }

  const id = stripQuotes(fm.id ?? '');
  const title = stripQuotes(fm.title ?? '');
  const summary = stripQuotes(fm.summary ?? '');
  const type = stripQuotes(fm.type ?? '');
  const tags = fm.tags != null ? parseTags(fm.tags) : [];
  const body = lines.slice(close + 1).join('\n').trim();

  const missing = [];
  if (!id) missing.push('id');
  if (!title) missing.push('title');
  if (!summary) missing.push('summary');
  if (!type) missing.push('type');
  if (!body) missing.push('body');
  if (missing.length) {
    throw new Error(`${file}: missing required field(s): ${missing.join(', ')}`);
  }

  // Fixed field order matches the Doc contract in @/types.
  return { id, title, summary, type, tags, body };
}

// ─── Read → parse → sort → write ──────────────────────────────────────────────
const files = readdirSync(srcDir)
  .filter((f) => f.endsWith('.md'))
  .sort();

const docs = files.map((f) => parseDoc(readFileSync(join(srcDir, f), 'utf8'), f));

// Deterministic ordering by id (code-unit comparison; locale-independent).
docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const outDir = resolve(scriptDir, '..', 'public');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'corpus.json');
writeFileSync(outFile, JSON.stringify(docs, null, 2) + '\n', 'utf8');

console.log(
  `[build-corpus] wrote ${docs.length} docs → ${outFile}\n[build-corpus] source: ${srcDir}`,
);
