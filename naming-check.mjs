// naming-check.mjs — Gate [13]: CSS var naming round-trip.
// Every CSS var declared in theme.css must trace back to a Figma token in the
// snapshot (via convention or EXPLICIT) or be on the SYSTEM_VARS / KNOWN_INTERNAL
// exemption list in parity-map.mjs.
//
// Direction: CSS → Figma (reverse of Gates [2] and [4]).
// A var with no Figma backing is either hallucinated or needs to be documented.
//
// Requires at project root:
//   ds-config.json   — snapshot path, themeCSS, pluginCSS
//   parity-map.mjs   — EXPLICIT, EXPLICIT_SIZING, SKIP_TOKENS, SIZING_SKIP,
//                      SYSTEM_VARS (known structural/semantic vars with no 1:1 token)
//
// Exit 0 = all CSS vars traceable.  Exit 1 = uninvented vars found.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}
const SNAP_VARS  = cfg.paths?.snapshotVars ?? 'figma-vars.snapshot.json';
const THEME_PATH = cfg.paths?.themeCSS     ?? 'src/theme.css';
const PLUGIN_CSS = cfg.paths?.pluginCSS    ?? [];

// ── Load parity-map.mjs ───────────────────────────────────────────────────────
let EXPLICIT = {}, EXPLICIT_SIZING = {}, SKIP_TOKENS = new Set();
let SIZING_SKIP = new Map(), SYSTEM_VARS = new Set();
try {
  const map = await import(join(ROOT, 'parity-map.mjs'));
  if (map.EXPLICIT)        EXPLICIT        = map.EXPLICIT;
  if (map.EXPLICIT_SIZING) EXPLICIT_SIZING = map.EXPLICIT_SIZING;
  if (map.SKIP_TOKENS)     SKIP_TOKENS     = map.SKIP_TOKENS;
  if (map.SIZING_SKIP)     SIZING_SKIP     = map.SIZING_SKIP;
  if (map.SYSTEM_VARS)     SYSTEM_VARS     = map.SYSTEM_VARS;
} catch { /* optional */ }

// ── Load snapshot ─────────────────────────────────────────────────────────────
const snap = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8'));
const figmaTokens = new Set([
  ...Object.keys(snap.color?.light ?? {}).map(t => t.replace(/\/color$/, '')),
  ...Object.keys(snap.color?.dark  ?? {}).map(t => t.replace(/\/color$/, '')),
  ...Object.keys(snap.sizing ?? {}),
]);

// ── Build forward map: all CSS vars that ARE expected to exist ────────────────
const knownCSSVars = new Set(SYSTEM_VARS);

// EXPLICIT targets
for (const cssVar of Object.values(EXPLICIT))        if (cssVar) knownCSSVars.add(cssVar);
for (const cssVar of Object.values(EXPLICIT_SIZING)) if (cssVar) knownCSSVars.add(cssVar);

// Convention-derived vars from every Figma token
function conventionVar(token) {
  return '--' + token.replace(/\/iconText\//g, '/text/').replace(/\/default$/, '').replace(/\//g, '-');
}
for (const token of figmaTokens) {
  if (SKIP_TOKENS.has(token)) continue;
  if (token in EXPLICIT || token in EXPLICIT_SIZING) continue;
  if (SIZING_SKIP.has(token)) continue;
  knownCSSVars.add(conventionVar(token));
  knownCSSVars.add(conventionVar(token.replace(/\/color$/, '')));
}

// ── Collect declared CSS vars from theme + plugins ────────────────────────────
const rawCss = readFileSync(join(ROOT, THEME_PATH), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const declared = new Set();
for (const m of rawCss.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) declared.add('--' + m[1]);

// ── Check ─────────────────────────────────────────────────────────────────────
const UNKNOWN = [], OK = [];

for (const cssVar of declared) {
  if (knownCSSVars.has(cssVar)) { OK.push(cssVar); continue; }

  // Reverse convention: --foo-bar-baz → try foo/bar/baz and sub-paths
  const asToken = cssVar.slice(2).replace(/-/g, '/');
  let found = false;
  for (let i = asToken.split('/').length; i >= 1; i--) {
    const candidate = asToken.split('/').slice(0, i).join('/');
    if (figmaTokens.has(candidate) || figmaTokens.has(candidate + '/color')) {
      found = true; break;
    }
  }
  if (found) { OK.push(cssVar); continue; }

  UNKNOWN.push(cssVar);
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n✅ TRACEABLE  ${OK.length}  (maps back to a Figma token or SYSTEM_VARS)`);
console.log(`❌ UNINVENTED ${UNKNOWN.length}  (CSS var with no Figma token backing)`);

if (UNKNOWN.length) {
  console.log('\n─── CSS vars with no Figma token (add to DS, delete var, or add to SYSTEM_VARS) ──');
  for (const v of UNKNOWN) console.log(`  ❌ ${v}`);
  console.log('');
  process.exit(1);
} else {
  console.log('\nAll CSS vars trace back to a Figma token or documented system var. ✓\n');
  process.exit(0);
}
