// state-check.mjs — Run from project root: node scripts/state-check.mjs
// Gate [10]: every token found in a full COMPONENT_SET variant walk must be
// covered by a CSS var, an EXPLICIT mapping, or an approved COVERED entry.
//
// Unlike bound-check.mjs (which only sees tokens used in instantiated DS frames),
// this gate walks ALL COMPONENT_SET states (hover, selected, disabled, etc.) so
// that state tokens defined in the DS but not yet used in any plugin frame are
// still verified.
//
// Requires at project root:
//   ds-config.json              — themeCSS + pluginCSS paths
//   parity-map.mjs              — COVERED_STATE (or COVERED), COVERED_PREFIX, EXPLICIT
//   component-state-tokens.json — output of Phase 2 COMPONENT_SET state walk
//
// Exit 0 = all state tokens covered.
// Exit 1 = uncovered state token(s).
// Exit 2 = component-state-tokens.json missing (gate did NOT run — never a pass).

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}
const THEME_PATH = cfg.paths?.themeCSS  ?? 'src/theme.css';
const PLUGIN_CSS = cfg.paths?.pluginCSS ?? [];

// ── Load parity-map.mjs ───────────────────────────────────────────────────────
let COVERED = new Set(), COVERED_PREFIX = [], EXPLICIT = {}, EXPLICIT_SIZING = {};
try {
  const map = await import(join(ROOT, 'parity-map.mjs'));
  // Prefer COVERED_STATE (state-walk superset) if provided, fall back to COVERED
  if (map.COVERED_STATE)  COVERED        = map.COVERED_STATE;
  else if (map.COVERED)   COVERED        = map.COVERED;
  if (map.COVERED_PREFIX) COVERED_PREFIX = map.COVERED_PREFIX;
  if (map.EXPLICIT)       EXPLICIT       = map.EXPLICIT;
  if (map.EXPLICIT_SIZING) EXPLICIT_SIZING = map.EXPLICIT_SIZING;
} catch { /* optional — runs with empty maps */ }

// ── Load component-state-tokens.json ─────────────────────────────────────────
if (!existsSync(join(ROOT, 'component-state-tokens.json'))) {
  console.log('\n⚠️  component-state-tokens.json not found at project root.');
  console.log('   Run Phase 2 COMPONENT_SET state walk in Figma and save output here.');
  console.log('   (exit 2 — treated as "not run", never as a pass)\n');
  process.exit(2);
}
const parsed = JSON.parse(readFileSync(join(ROOT, 'component-state-tokens.json'), 'utf8'));
const stateTokens = Object.keys(parsed);

// ── Collect declared CSS vars ─────────────────────────────────────────────────
const declared = new Set();
const sources = [THEME_PATH, ...PLUGIN_CSS].filter(f => existsSync(join(ROOT, f)));
for (const f of sources) {
  const txt = readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of txt.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) declared.add('--' + m[1]);
}

// ── Coverage check ────────────────────────────────────────────────────────────
function normalize(token) { return token.replace(/\/color$/, ''); }

function isCovered(token) {
  const t = normalize(token);
  if (t.startsWith('primitives/')) return true;
  if (COVERED.has(t)) return true;
  if (COVERED_PREFIX.some(p => t.startsWith(p))) return true;
  if (EXPLICIT[t] && declared.has(EXPLICIT[t])) return true;
  if (EXPLICIT_SIZING[t] && declared.has(EXPLICIT_SIZING[t])) return true;
  const v = '--' + t.replace(/\/iconText\//g, '/text/').replace(/\/default$/, '').replace(/\//g, '-');
  if (declared.has(v)) return true;
  if (declared.has('--' + t.replace(/\//g, '-'))) return true;
  return false;
}

const UNCOVERED = [], OK = [];
for (const token of stateTokens) {
  if (isCovered(token)) OK.push(token);
  else UNCOVERED.push(token);
}

console.log(`\n✅ COVERED   ${OK.length}`);
console.log(`❌ UNCOVERED ${UNCOVERED.length}`);

if (UNCOVERED.length) {
  console.log('\n─── In COMPONENT_SET variants, no CSS var (implement or add to COVERED_STATE in parity-map.mjs) ──');
  for (const t of UNCOVERED) console.log(`  ❌ ${t}`);
  console.log('');
  process.exit(1);
} else {
  console.log('\nAll COMPONENT_SET state tokens are implemented or explicitly deferred. ✓\n');
  process.exit(0);
}
