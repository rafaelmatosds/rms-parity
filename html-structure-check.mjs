// html-structure-check.mjs — Gate [15]: HTML structure snapshot
// Run from project root: node ../rms-figma-code-parity/html-structure-check.mjs
//                    or: node ../rms-figma-code-parity/html-structure-check.mjs --accept
//
// Parses each plugin's ui.src.html (static part only — strips <script> blocks),
// extracts a structural fingerprint (all element IDs, DS component classes on
// interactive elements, all <use href="#icon-X"> with nearest-ancestor context),
// and diffs against a stored snapshot.
//
// First run with a missing snapshot writes the baseline (✅ pass).
// --accept: accept the current structure as the new baseline (overwrites snapshot).
//
// Stored at: packages/ui/src/html-structure.snapshot.json (next to theme CSS)

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join }                                     from 'path';

const ROOT   = process.cwd();
const ACCEPT = process.argv.includes('--accept');

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

// Derive snapshot path next to theme CSS
const themeCSS   = [cfg.paths?.themeCSS ?? 'packages/ui/src/theme.css'].flat()[0];
const snapPath   = themeCSS.replace(/[^/\\]+$/, 'html-structure.snapshot.json');
const absSnap    = join(ROOT, snapPath);

const pluginCSS = cfg.paths?.pluginCSS ?? [];
const plugins   = cfg.paths?.plugins   ?? [];

// ── DS component class set ────────────────────────────────────────────────────
// Only interactive elements with a recognised DS class are fingerprinted.
const DS_CLASSES = new Set([
  'buttonPrimary', 'buttonSecondary', 'buttonTertiary', 'buttonQuaternary',
  'buttonList', 'overflowList', 'segmented-control', 'inputWrap', 'swatch',
  'badge', 'dividerSection', 'panel',
]);

// ── HTML parser ───────────────────────────────────────────────────────────────

function stripScripts(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '');
}

// Find the nearest ancestor id or class context for a <use> element.
// We walk backwards from the match position looking for an id= or a DS class.
function nearestContext(html, useIdx) {
  // Walk back up to 600 chars to find the enclosing element with id= or DS class
  const before = html.slice(Math.max(0, useIdx - 600), useIdx);
  // Find the last opening tag before the <use>
  const tags = [...before.matchAll(/<([a-z]+)([^>]*)>/gi)];
  for (let i = tags.length - 1; i >= 0; i--) {
    const attrs = tags[i][2];
    const idM   = /\bid="([^"]+)"/.exec(attrs);
    if (idM) return `#${idM[1]}`;
    const clsM  = /\bclass="([^"]*)"/.exec(attrs);
    if (clsM) {
      const cls = clsM[1].split(/\s+/).find(c => DS_CLASSES.has(c));
      if (cls) return `.${cls}`;
    }
  }
  return '(root)';
}

function fingerprint(html) {
  const static_html = stripScripts(html);

  // All element IDs (exclude generated/empty)
  const ids = [...static_html.matchAll(/\bid="([^"]+)"/g)]
    .map(m => m[1])
    .filter(id => id.trim());

  // DS component classes on interactive elements
  const components = [];
  const tagRe = /<(button|div|span)[^>]*\bclass="([^"]*)"[^>]*>/gi;
  let tm;
  while ((tm = tagRe.exec(static_html)) !== null) {
    const allClasses = tm[2].split(/\s+/);
    const dsClasses  = allClasses.filter(c => DS_CLASSES.has(c));
    if (!dsClasses.length) continue;

    const attrs = tm[0];
    const idM   = /\bid="([^"]+)"/.exec(attrs);
    const id    = idM ? idM[1] : null;
    components.push({ id, classes: dsClasses.sort() });
  }

  // <use href="#icon-X"> with context
  const icons = [];
  const useRe = /<use\s+href="#([^"]+)"/g;
  let um;
  while ((um = useRe.exec(static_html)) !== null) {
    if (!um[1].startsWith('icon-')) continue;
    const ctx = nearestContext(static_html, um.index);
    icons.push({ context: ctx, icon: um[1] });
  }

  // Button inner structure — catches spurious text labels, extra spans, or missing icons.
  // For each <button id="X"> with a static (non-template) ID, record:
  //   svg   : whether the button directly contains <svg>
  //   spans : class names on any <span> children (sorted)
  //   text  : visible text content after stripping tags (trimmed)
  // A change here (e.g. adding <span class="tab-label">Tree</span>) fails the gate.
  const buttonContent = [];
  const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let bm;
  while ((bm = btnRe.exec(static_html)) !== null) {
    const btnAttrs = bm[1];
    const inner    = bm[2];
    const idM      = /\bid="([^"]+)"/.exec(btnAttrs);
    if (!idM) continue;
    const btnId = idM[1];
    if (/["'+${}]/.test(btnId)) continue; // skip JS-template IDs
    const hasSvg = /<svg\b/i.test(inner);
    const spans  = [...inner.matchAll(/<span\b[^>]*\bclass="([^"]*)"[^>]*>/gi)]
      .map(m => m[1].trim()).sort();
    const text   = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    buttonContent.push({ id: btnId, svg: hasSvg, spans, text });
  }

  return { ids, components, icons, buttonContent };
}

// ── Load existing snapshot ────────────────────────────────────────────────────
let stored = {};
if (existsSync(absSnap)) {
  try { stored = JSON.parse(readFileSync(absSnap, 'utf8')); } catch {}
}

// ── Compute current fingerprints ──────────────────────────────────────────────
const current = {};
for (let i = 0; i < plugins.length; i++) {
  const plugin  = plugins[i];
  const srcPath = pluginCSS[i];
  if (!srcPath || !existsSync(join(ROOT, srcPath))) continue;
  const html = readFileSync(join(ROOT, srcPath), 'utf8');
  current[plugin] = fingerprint(html);
}

// ── Accept mode: overwrite snapshot ──────────────────────────────────────────
if (ACCEPT) {
  const snap = { _updated: new Date().toISOString().slice(0, 10), ...current };
  writeFileSync(absSnap, JSON.stringify(snap, null, 2) + '\n');
  console.log(`✅ [15] html-structure.snapshot.json accepted — baseline updated`);
  process.exit(0);
}

// ── First run (no snapshot): write and pass ───────────────────────────────────
if (!existsSync(absSnap) || !Object.keys(stored).length) {
  const snap = { _updated: new Date().toISOString().slice(0, 10), ...current };
  writeFileSync(absSnap, JSON.stringify(snap, null, 2) + '\n');
  console.log(`✅ [15] No snapshot found — baseline written (${plugins.length} plugin(s))`);
  process.exit(0);
}

// ── Diff ──────────────────────────────────────────────────────────────────────
let pass = true;

function diffArrays(label, prev, curr) {
  const prevSet = new Set(prev.map(v => JSON.stringify(v)));
  const currSet = new Set(curr.map(v => JSON.stringify(v)));
  const added   = curr.filter(v => !prevSet.has(JSON.stringify(v)));
  const removed = prev.filter(v => !currSet.has(JSON.stringify(v)));
  return { added, removed };
}

for (const plugin of plugins) {
  const prev = stored[plugin];
  const curr = current[plugin];
  if (!curr) continue;
  if (!prev) {
    console.log(`✅ [15] ${plugin}: new plugin — no snapshot yet`);
    continue;
  }

  const idDiff   = diffArrays('ids',           prev.ids,           curr.ids);
  const compDiff = diffArrays('components',    prev.components,    curr.components);
  const iconDiff = diffArrays('icons',         prev.icons,         curr.icons);
  const btnDiff  = diffArrays('buttonContent', prev.buttonContent ?? [], curr.buttonContent ?? []);

  const hasDiff = idDiff.added.length || idDiff.removed.length ||
                  compDiff.added.length || compDiff.removed.length ||
                  iconDiff.added.length || iconDiff.removed.length ||
                  btnDiff.added.length  || btnDiff.removed.length;

  if (!hasDiff) {
    console.log(`✅ [15] ${plugin}: structure unchanged`);
    continue;
  }

  pass = false;
  console.log(`❌ [15] ${plugin}: structure changed`);

  if (idDiff.added.length)   console.log(`       + ids:           ${idDiff.added.join(', ')}`);
  if (idDiff.removed.length) console.log(`       - ids:           ${idDiff.removed.join(', ')}`);
  if (compDiff.added.length)   console.log(`       + components:   ${compDiff.added.map(c => JSON.stringify(c)).join(', ')}`);
  if (compDiff.removed.length) console.log(`       - components:   ${compDiff.removed.map(c => JSON.stringify(c)).join(', ')}`);
  if (iconDiff.added.length)   console.log(`       + icons:        ${iconDiff.added.map(c => JSON.stringify(c)).join(', ')}`);
  if (iconDiff.removed.length) console.log(`       - icons:        ${iconDiff.removed.map(c => JSON.stringify(c)).join(', ')}`);
  if (btnDiff.added.length)    console.log(`       + btnContent:   ${btnDiff.added.map(c => JSON.stringify(c)).join(', ')}`);
  if (btnDiff.removed.length)  console.log(`       - btnContent:   ${btnDiff.removed.map(c => JSON.stringify(c)).join(', ')}`);
}

if (!pass) {
  console.log(`\n  To accept: node ../rms-figma-code-parity/html-structure-check.mjs --accept`);
}

process.exit(pass ? 0 : 1);
