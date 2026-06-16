// exemption-check.mjs — Gate [11]: verify every entry in EXPLICIT/SKIP_TOKENS/COVERED
// still exists in the Figma snapshot and maps to a real CSS var with the correct value.
//
// Manually-maintained allowlists become stale when Figma renames a token. Stale entries
// are phantom exemptions — the audit silently "passes" tokens that no longer exist.
// This gate makes stale entries a hard fail so no hallucination can hide in an allowlist.
//
// Checks:
//   A. EXPLICIT (color): token in snapshot + CSS var declared + value matches Figma
//   B. SKIP_TOKENS: token still in snapshot (must exist to be worth skipping)
//   C. COVERED: token in snapshot OR runtime walk data (bound/state)
//   D. EXPLICIT_SIZING: token in sizing snapshot + CSS var declared + value matches
//
// Requires at project root:
//   ds-config.json   — snapshot path, themeCSS
//   parity-map.mjs   — EXPLICIT, SKIP_TOKENS, KNOWN_NULL, EXPLICIT_SIZING, COVERED, COVERED_STATE
//
// Exit 0 = all exemptions valid.  Exit 1 = stale/broken entry found.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}
const SNAP_VARS  = cfg.paths?.snapshotVars ?? 'figma-vars.snapshot.json';
const THEME_PATH = cfg.paths?.themeCSS     ?? 'src/theme.css';
const PLUGIN_CSS = cfg.paths?.pluginCSS    ?? [];
const PRIM_PFX   = cfg.figma?.primitivePrefix ?? 'primitives/';

// ── Load parity-map.mjs ───────────────────────────────────────────────────────
let EXPLICIT = {}, SKIP_TOKENS = new Set(), KNOWN_NULL = new Set();
let EXPLICIT_SIZING = {}, SIZING_SKIP = new Map();
let COVERED = new Set(), COVERED_STATE = new Set(), COVERED_PREFIX = [];
try {
  const map = await import(join(ROOT, 'parity-map.mjs'));
  if (map.EXPLICIT)        EXPLICIT        = map.EXPLICIT;
  if (map.SKIP_TOKENS)     SKIP_TOKENS     = map.SKIP_TOKENS;
  if (map.KNOWN_NULL)      KNOWN_NULL      = map.KNOWN_NULL;
  if (map.EXPLICIT_SIZING) EXPLICIT_SIZING = map.EXPLICIT_SIZING;
  if (map.SIZING_SKIP)     SIZING_SKIP     = map.SIZING_SKIP;
  if (map.COVERED)         COVERED         = map.COVERED;
  if (map.COVERED_STATE)   COVERED_STATE   = map.COVERED_STATE;
  if (map.COVERED_PREFIX)  COVERED_PREFIX  = map.COVERED_PREFIX;
} catch {
  console.log('⚠️  parity-map.mjs not found — nothing to check.\n');
  process.exit(0);
}

// ── Load snapshot ─────────────────────────────────────────────────────────────
const snap = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8'));
const snapTokens = new Set([
  ...Object.keys(snap.color?.light ?? {}).map(t => t.replace(/\/color$/, '')),
  ...Object.keys(snap.color?.dark  ?? {}).map(t => t.replace(/\/color$/, '')),
  ...Object.keys(snap.sizing ?? {}),
]);

// Runtime walk tokens (transient — may be absent; only checked when present)
const boundTokens = existsSync(join(ROOT, 'bound-tokens.json'))
  ? new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'bound-tokens.json'), 'utf8'))))
  : null;
const stateTokens = existsSync(join(ROOT, 'component-state-tokens.json'))
  ? new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'component-state-tokens.json'), 'utf8'))))
  : null;
const runtimeTokens = new Set([...(boundTokens ?? []), ...(stateTokens ?? [])]);

// ── Collect declared CSS vars ─────────────────────────────────────────────────
const declared = new Set();
const sources = [THEME_PATH, ...PLUGIN_CSS].filter(f => existsSync(join(ROOT, f)));
for (const f of sources) {
  const txt = readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of txt.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)) declared.add('--' + m[1]);
}

// ── CSS color resolver ────────────────────────────────────────────────────────
// Primitive scale from parity-map.mjs
let map_; try { map_ = await import(join(ROOT, 'parity-map.mjs')); } catch {}
const NL = map_?.NEUTRAL_LIGHT ?? {};
const ND = map_?.NEUTRAL_DARK  ?? {};
const NEUTRAL_VAR_RE = map_?.NEUTRAL_VAR_RE ?? /^--neutral-(\d+)$/;

const rawCss = existsSync(join(ROOT, THEME_PATH))
  ? readFileSync(join(ROOT, THEME_PATH), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  : '';
function parseVarBlock(block) {
  const vars = {};
  for (const m of block.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*):\s*([^;]+);/g))
    vars['--' + m[1].trim()] = m[2].trim();
  return vars;
}
const rootVars = parseVarBlock(rawCss.match(/:root\s*{([\s\S]*?)}/)?.[1] ?? '');
const darkVars = parseVarBlock(
  rawCss.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?:root\s*\{([\s\S]*?)\}\s*\}/)?.[1] ?? ''
);

function resolve(varName, mode, depth = 0) {
  if (depth > 8) return null;
  const nm = varName.match(NEUTRAL_VAR_RE);
  if (nm) return (mode === 'light' ? NL : ND)[nm[1]] ?? null;
  const raw = (mode === 'dark' && darkVars[varName]) ? darkVars[varName] : rootVars[varName];
  if (!raw) return null;
  const t = raw.trim();
  const v = t.match(/^var\((--.+?)\)$/);
  if (v) return resolve(v[1], mode, depth + 1);
  if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return t.toLowerCase();
  return null;
}
function resolveScalar(varName, depth = 0) {
  if (depth > 8) return null;
  const raw = rootVars[varName]; if (!raw) return null;
  const t = raw.trim();
  const v = t.match(/^var\((--.+?)\)$/);
  if (v) return resolveScalar(v[1], depth + 1);
  return t;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function inSnapshot(token) {
  const t = token.replace(/\/color$/, '');
  return snapTokens.has(t) || snapTokens.has(t + '/color');
}
function inRuntime(token) {
  const t = token.replace(/\/color$/, '');
  return runtimeTokens.has(t) || runtimeTokens.has(t + '/color');
}
// Tokens that are legitimately absent from the snapshot (Figma-native, plugin-only, etc.)
// Projects can extend this via ds-config.json → exemptionCheck.alwaysNative
const NATIVE_PATTERNS = [
  ...(cfg.exemptionCheck?.alwaysNative ?? []),
];
function isKnownNative(token) {
  if (token.startsWith(PRIM_PFX)) return true;
  if (COVERED_PREFIX.some(p => token.startsWith(p))) return true;
  return NATIVE_PATTERNS.some(p => token === p || token.startsWith(p + '/'));
}

// ── Evaluate ──────────────────────────────────────────────────────────────────
const STALE = [], BROKEN = [], OK = [];

// A — EXPLICIT (color)
for (const [token, cssVar] of Object.entries(EXPLICIT)) {
  if (isKnownNative(token)) { OK.push(`EXPLICIT [native] ${token}`); continue; }
  if (!inSnapshot(token) && !inRuntime(token)) {
    STALE.push({ section: 'EXPLICIT', token, reason: 'not in snapshot or runtime walk — token may have been renamed in Figma' });
    continue;
  }
  if (cssVar === null) { OK.push(`EXPLICIT [null-skip] ${token}`); continue; }
  if (!declared.has(cssVar)) {
    BROKEN.push({ section: 'EXPLICIT', token, cssVar, reason: 'mapped CSS var not declared in theme.css' });
    continue;
  }
  for (const mode of ['light', 'dark']) {
    const figmaHex = snap.color?.[mode]?.[token] ?? snap.color?.[mode]?.[token + '/color'] ?? null;
    if (!figmaHex) continue;
    const cssHex = resolve(cssVar, mode);
    if (cssHex && figmaHex.toLowerCase() !== cssHex.toLowerCase()) {
      BROKEN.push({ section: 'EXPLICIT', token, cssVar, mode, reason: `value mismatch — Figma: ${figmaHex}, CSS: ${cssHex}` });
    }
  }
  OK.push(`EXPLICIT ${token}`);
}

// B — SKIP_TOKENS
for (const token of SKIP_TOKENS) {
  if (isKnownNative(token)) { OK.push(`SKIP [native] ${token}`); continue; }
  if (!inSnapshot(token)) {
    STALE.push({ section: 'SKIP_TOKENS', token, reason: 'not in snapshot — token may have been renamed or removed in Figma' });
  } else {
    OK.push(`SKIP ${token}`);
  }
}

// C — COVERED (union of COVERED + COVERED_STATE)
const allCovered = new Set([...COVERED, ...COVERED_STATE]);
for (const token of allCovered) {
  if (isKnownNative(token)) { OK.push(`COVERED [native] ${token}`); continue; }
  if (!inSnapshot(token) && !inRuntime(token)) {
    STALE.push({ section: 'COVERED', token, reason: 'not in snapshot or runtime walk — may be a phantom exemption' });
  } else {
    OK.push(`COVERED ${token}`);
  }
}

// D — EXPLICIT_SIZING
for (const [token, cssVar] of Object.entries(EXPLICIT_SIZING)) {
  if (!snap.sizing?.[token]) {
    if (!SIZING_SKIP.has(token)) {
      STALE.push({ section: 'EXPLICIT_SIZING', token, reason: 'not in sizing snapshot — token may have been renamed in Figma' });
    } else {
      OK.push(`EXPLICIT_SIZING [skip] ${token}`);
    }
    continue;
  }
  if (!declared.has(cssVar)) {
    BROKEN.push({ section: 'EXPLICIT_SIZING', token, cssVar, reason: 'mapped CSS var not declared' });
    continue;
  }
  const figmaVal = snap.sizing[token];
  const cssVal   = resolveScalar(cssVar);
  if (cssVal && String(figmaVal).trim() !== cssVal.trim()) {
    BROKEN.push({ section: 'EXPLICIT_SIZING', token, cssVar, reason: `value mismatch — Figma: ${figmaVal}, CSS: ${cssVal}` });
  } else {
    OK.push(`EXPLICIT_SIZING ${token}`);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n✅ VALID     ${OK.length}`);
console.log(`🚨 STALE     ${STALE.length}  (phantom exemptions — token no longer in DS)`);
console.log(`❌ BROKEN    ${BROKEN.length}  (CSS var missing or value mismatch)`);

if (STALE.length) {
  console.log('\n─── Phantom exemptions (update parity-map.mjs) ──────────────────');
  for (const e of STALE) console.log(`  🚨 [${e.section}] ${e.token}\n      ${e.reason}`);
}
if (BROKEN.length) {
  console.log('\n─── Broken mappings (CSS var wrong or missing) ──────────────────');
  for (const e of BROKEN) {
    console.log(`  ❌ [${e.section}] ${e.token}${e.cssVar ? ' → ' + e.cssVar : ''}`);
    console.log(`      ${e.reason}`);
  }
}

if (STALE.length === 0 && BROKEN.length === 0) {
  console.log('\nAll exemption entries are valid and grounded in the current DS snapshot. ✓\n');
  process.exit(0);
} else {
  console.log('');
  process.exit(1);
}
