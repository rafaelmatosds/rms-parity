// icon-check.mjs — Run from project root: node ../rms-figma-code-parity/icon-check.mjs
//
// Hard Rule #15 — SVG symbol audit:
//   Every <symbol> defined in any plugin HTML file must be declared in ICON_SYMBOLS
//   in structure-contract.mjs with either:
//     DS ICON         — sourced from the Figma DS; must record the Figma node ID
//     PLUGIN-SPECIFIC — custom icon with no DS backing; must describe visual purpose
//
//   ICON_SYMBOLS values can be a string OR an object:
//     String:  'DS ICON — ...' | 'PLUGIN-SPECIFIC — ...'
//     Object:  { desc: 'DS ICON — ...', transform?: 'rotate(-45)' }
//              transform — if set, symbol must contain <g transform="..."> matching value
//
//   The viewBox attribute on <symbol> is the icon's container — it is verified against
//   the Figma snapshot automatically. Render size (<svg width height>) is a design
//   decision and is not policed; the viewBox + path data checks ensure the correct
//   icon is used at whatever size the design calls for.
//
//   Why: hand-drawn paths, missing transforms, and wrong render sizes all produce
//   visually wrong icons that no color/token check would catch.
//
// Requires at project root:
//   ds-config.json         — paths.pluginCSS (HTML files to scan for <symbol> elements)
//   structure-contract.mjs — ICON_SYMBOLS export
//
// Exit 0 = all symbols documented, transforms and sizes verified. Exit 1 = failures found.

import { readFileSync, existsSync } from 'fs';
import { join, dirname }            from 'path';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const HTML_SOURCES = [
  ...(cfg.paths?.pluginCSS        ?? []).filter(f => existsSync(join(ROOT, f)) && f.endsWith('.html')),
  ...(cfg.paths?.sharedIconSources ?? []).filter(f => existsSync(join(ROOT, f))),
];

// ── Load ICON_SYMBOLS from structure-contract.mjs ─────────────────────────────
let ALLOWED = {};
try {
  const m = await import(join(ROOT, 'structure-contract.mjs'));
  if (m.ICON_SYMBOLS && typeof m.ICON_SYMBOLS === 'object') ALLOWED = m.ICON_SYMBOLS;
} catch { /* optional export */ }

function entryDesc(val)        { return typeof val === 'string' ? val : val.desc; }
function entryTransform(val)   { return typeof val === 'string' ? null  : (val.transform   ?? null); }
function entryStrokeNone(val)  { return typeof val === 'string' ? false : (val.strokeNone  ?? false); }
function entryStrokeBased(val) { return typeof val === 'string' ? false : (val.strokeBased ?? false); }

// ── Extract <symbol id="...">...</symbol> blocks from HTML files ──────────────
// Captures the full symbol body so we can check for transform attributes.
const SYMBOL_BLOCK_RE = /<symbol\s([^>]*)>([\s\S]*?)<\/symbol>/g;
const ID_RE           = /\bid="([^"]+)"/;

// ── Load figma-icons.snapshot.json (path comparison ground truth) ─────────────
let iconSnap = {};
const snapIconsPath = cfg.paths?.snapshotIcons;
if (snapIconsPath && existsSync(join(ROOT, snapIconsPath))) {
  try { iconSnap = JSON.parse(readFileSync(join(ROOT, snapIconsPath), 'utf8')); } catch {}
}

function extractPathDs(body) {
  const re = /\bd="([^"]+)"/g;
  const ds = [];
  let m;
  while ((m = re.exec(body)) !== null) ds.push(m[1]);
  return ds;
}

const documented       = [];
const undocumented     = [];
const transformFails   = [];
const strokeFails      = [];
const strokeBasedFails = [];
const pathFails        = [];
const viewBoxFails     = [];

for (const srcPath of HTML_SOURCES) {
  const text = readFileSync(join(ROOT, srcPath), 'utf8');
  let m;
  SYMBOL_BLOCK_RE.lastIndex = 0;
  while ((m = SYMBOL_BLOCK_RE.exec(text)) !== null) {
    const attrs = m[1], body = m[2];
    const idMatch = ID_RE.exec(attrs);
    if (!idMatch) continue;
    const id  = idMatch[1];
    const val = ALLOWED[id];

    if (!val) {
      undocumented.push({ id, file: srcPath });
      continue;
    }

    const desc            = entryDesc(val);
    const reqTransform    = entryTransform(val);
    const reqStrokeNone   = entryStrokeNone(val);
    const reqStrokeBased  = entryStrokeBased(val);

    if (reqStrokeBased) {
      // Verify the <symbol> tag itself has fill="none" — ensures stroke-based rendering.
      // Catches a fill-based SVG replacing a stroke DS icon without any size/color gate failing.
      const hasFillNone = /\bfill="none"/.test(attrs) || /\bfill='none'/.test(attrs);
      if (!hasFillNone) {
        strokeBasedFails.push({ id, file: srcPath, desc });
        continue;
      }
    }

    if (reqTransform) {
      const hasTransform = body.includes(`transform="${reqTransform}"`) ||
                           body.includes(`transform='${reqTransform}'`);
      if (!hasTransform) {
        transformFails.push({ id, reqTransform, file: srcPath, desc });
        continue;
      }
    }

    if (reqStrokeNone) {
      // Verify the symbol body contains stroke="none" on a path/shape element.
      // This prevents CSS-inherited stroke (e.g. .buttonTertiary svg { stroke: ... })
      // from making fill-only icons appear thicker in button contexts than elsewhere.
      const hasStrokeNone = /stroke="none"/.test(body) || /stroke='none'/.test(body);
      if (!hasStrokeNone) {
        strokeFails.push({ id, file: srcPath, desc });
        continue;
      }
    }

    // ── Path comparison against Figma snapshot ──────────────────────────────
    const snapEntry = iconSnap[id];
    if (snapEntry) {
      // Verify viewBox matches Figma export — skip for transformed icons (rotation adjusts bounding box)
      if (!reqTransform) {
        const viewBoxMatch = /\bviewBox="([^"]+)"/.exec(attrs);
        const codeViewBox  = viewBoxMatch ? viewBoxMatch[1] : null;
        if (codeViewBox && codeViewBox !== snapEntry.viewBox) {
          viewBoxFails.push({ id, file: srcPath, expected: snapEntry.viewBox, actual: codeViewBox });
        }
      }
      // Verify path d values match Figma export exactly
      const codePaths = extractPathDs(body);
      const snapPaths = snapEntry.paths ?? [];
      if (JSON.stringify([...codePaths].sort()) !== JSON.stringify([...snapPaths].sort())) {
        pathFails.push({ id, file: srcPath,
          expectedCount: snapPaths.length, actualCount: codePaths.length,
          expected: snapPaths[0] ? snapPaths[0].slice(0, 60) + '…' : '(none)',
          actual:   codePaths[0] ? codePaths[0].slice(0, 60) + '…' : '(none — non-path elements used)',
        });
      }
    }

    documented.push({ id, desc, file: srcPath });
  }
}


// ── Report ────────────────────────────────────────────────────────────────────
console.log('\n─── SVG symbol audit (Hard Rule #15) ───────────────────────────────\n');

if (documented.length) {
  console.log(`✅ DOCUMENTED  ${documented.length}  (SVG symbols declared and verified in contract)`);
  for (const r of documented) {
    const tag = r.desc.startsWith('DS ICON') ? '✅ DS    ' : '✅ PLUGIN';
    console.log(`   ${tag}  #${r.id}`);
    console.log(`            ${r.desc}`);
  }
  console.log();
}

const allFails = [
  ...undocumented.map(r => ({ ...r, kind: 'undocumented' })),
  ...strokeBasedFails.map(r => ({ ...r, kind: 'strokeBased' })),
  ...transformFails.map(r => ({ ...r, kind: 'transform' })),
  ...strokeFails.map(r => ({ ...r, kind: 'stroke' })),
  ...viewBoxFails.map(r => ({ ...r, kind: 'viewBox' })),
  ...pathFails.map(r => ({ ...r, kind: 'path' })),
];

if (allFails.length === 0) {
  console.log('✅ No undocumented or misconfigured SVG symbols.\n');
  process.exit(0);
}

if (undocumented.length) {
  console.log(`❌ UNDOCUMENTED  ${undocumented.length}  (SVG symbols with no contract entry)\n`);
  for (const r of undocumented) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      → DS icon? Fetch from Figma (get_design_context), add as DS ICON with nodeId.`);
    console.log(`        Also check: does the Figma component apply a rotation wrapper? If so, add transform field.`);
    console.log(`        Custom icon? Add as PLUGIN-SPECIFIC with a description.\n`);
  }
}

if (transformFails.length) {
  console.log(`❌ MISSING TRANSFORM  ${transformFails.length}  (DS icons require a <g transform> that is absent)\n`);
  for (const r of transformFails) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      Contract requires: <g transform="${r.reqTransform}">`);
    console.log(`      → Figma component applies this rotation to orient the path correctly.`);
    console.log(`        Wrap the <path> in: <g transform="${r.reqTransform}">...</g>\n`);
  }
}


if (strokeBasedFails.length) {
  console.log(`❌ NOT STROKE-BASED  ${strokeBasedFails.length}  (DS stroke icons must have fill="none" on <symbol> tag)\n`);
  for (const r of strokeBasedFails) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      Contract requires strokeBased: true — <symbol> tag must have fill="none" attribute.`);
    console.log(`      → The DS icon uses stroke rendering (not fill). A fill-based replacement would have`);
    console.log(`        wrong visual weight. Add fill="none" to the <symbol ...> opening tag.\n`);
  }
}

if (strokeFails.length) {
  console.log(`❌ MISSING STROKE=NONE  ${strokeFails.length}  (fill-only DS icons missing stroke="none" guard)\n`);
  for (const r of strokeFails) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      Contract requires strokeNone: true — no stroke="none" found on any element inside the symbol.`);
    console.log(`      → Broad CSS rules (e.g. .buttonTertiary svg { stroke: ... }) will inherit stroke into fill-only`);
    console.log(`        paths, making the icon appear thicker in button contexts than in other contexts.`);
    console.log(`        Add stroke="none" to the <path> inside the symbol to prevent inherited stroke.\n`);
  }
}

if (viewBoxFails.length) {
  console.log(`❌ WRONG VIEWBOX  ${viewBoxFails.length}  (DS icons with wrong viewBox — coordinate space mismatch)\n`);
  for (const r of viewBoxFails) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      Figma export: viewBox="${r.expected}"  —  code has: viewBox="${r.actual}"`);
    console.log(`      → The symbol viewBox must match the Figma node dimensions exactly.`);
    console.log(`        Update the <symbol viewBox="..."> attribute.\n`);
  }
}

if (pathFails.length) {
  console.log(`❌ WRONG PATH DATA  ${pathFails.length}  (DS icon paths diverge from Figma export)\n`);
  for (const r of pathFails) {
    console.log(`   ❌ "#${r.id}"  in ${r.file}`);
    console.log(`      Figma has ${r.expectedCount} path(s). Code has ${r.actualCount} path(s).`);
    console.log(`      Expected (first 60 chars): ${r.expected}`);
    console.log(`      Actual   (first 60 chars): ${r.actual}`);
    console.log(`      → DS icons must use the exact SVG exported from Figma via exportAsync({ format: 'SVG' }).`);
    console.log(`        Never hand-draw stroke paths (<circle>, <line>, <polyline>) for DS fill icons.`);
    console.log(`        Run the icon export step in Phase 1 and copy the exact <path d="..."> value.\n`);
  }
}

process.exit(1);
