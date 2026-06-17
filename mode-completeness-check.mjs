// dark-mode-check.mjs — Gate [12]: verify every color token with a different
// Figma light vs. dark value actually resolves to a different hex in CSS dark mode.
//
// Gate [2] catches wrong values. This gate catches the structural gap: a missing
// dark override causes the var to silently fall through to the light value, even
// when Figma specifies a different dark hex.
//
// A token "adapts" when:
//   • resolve(cssVar, 'dark') !== resolve(cssVar, 'light')  → different hex ✅
//   • token is in SKIP_TOKENS (no CSS var — documented) ✅
//   • EXPLICIT maps it to null (rgba — no comparison) ✅
//
// Requires at project root:
//   ds-config.json   — snapshot path, themeCSS
//   parity-map.mjs   — EXPLICIT, SKIP_TOKENS, NEUTRAL_LIGHT/DARK, NEUTRAL_VAR_RE
//
// Exit 0 = all mode-variant tokens adapt correctly.  Exit 1 = missing dark adaptation.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found.'); process.exit(1);
}
const SNAP_VARS  = cfg.paths?.snapshotVars ?? 'figma-vars.snapshot.json';
const THEME_PATHS = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
const THEME_PATH  = THEME_PATHS[0];

// ── Load parity-map.mjs ───────────────────────────────────────────────────────
let EXPLICIT = {}, SKIP_TOKENS = new Set();
let NL = {}, ND = {}, NEUTRAL_VAR_RE = /^--neutral-(\d+)$/;
try {
  const map = await import(join(ROOT, 'parity-map.mjs'));
  if (map.EXPLICIT)        EXPLICIT        = map.EXPLICIT;
  if (map.SKIP_TOKENS)     SKIP_TOKENS     = map.SKIP_TOKENS;
  if (map.NEUTRAL_LIGHT)   NL              = map.NEUTRAL_LIGHT;
  if (map.NEUTRAL_DARK)    ND              = map.NEUTRAL_DARK;
  if (map.NEUTRAL_VAR_RE)  NEUTRAL_VAR_RE  = map.NEUTRAL_VAR_RE;
} catch { /* optional */ }

// ── Parse token CSS (all configured files merged) ─────────────────────────────
const rawCss = THEME_PATHS.filter(p => existsSync(join(ROOT, p)))
  .map(p => readFileSync(join(ROOT, p), 'utf8')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
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

function tokenToVar(token) {
  if (SKIP_TOKENS.has(token)) return null;
  if (Object.prototype.hasOwnProperty.call(EXPLICIT, token)) return EXPLICIT[token];
  return '--' + token.replace(/\/iconText\//g, '/text/').replace(/\/default$/, '').replace(/\//g, '-');
}

// ── Load snapshot ─────────────────────────────────────────────────────────────
const snap = JSON.parse(readFileSync(join(ROOT, SNAP_VARS), 'utf8'));
const lightTokens = snap.color?.light ?? {};
const darkTokens  = snap.color?.dark  ?? {};

// ── Check ─────────────────────────────────────────────────────────────────────
const MISSING = [], OK = [], SKIPPED = [];
const seen = new Set();

for (const [tokenKey, lightHex] of Object.entries(lightTokens)) {
  const token = tokenKey.replace(/\/color$/, '');
  if (seen.has(token)) continue;
  seen.add(token);

  const darkHex = darkTokens[tokenKey] ?? darkTokens[token] ?? null;
  if (!darkHex || lightHex === null || lightHex?.toLowerCase() === darkHex?.toLowerCase()) continue;

  const cssVar = tokenToVar(token);
  if (cssVar === null) { SKIPPED.push(`${token} (no CSS var — documented)`); continue; }

  const cssLight = resolve(cssVar, 'light');
  const cssDark  = resolve(cssVar, 'dark');

  if (cssLight !== null && cssDark !== null && cssLight === cssDark) {
    MISSING.push({ token, cssVar, figmaLight: lightHex, figmaDark: darkHex, cssResolved: cssLight });
  } else {
    OK.push(token);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const total = OK.length + MISSING.length;
console.log(`\n✅ ADAPTS    ${OK.length}/${total}  (CSS resolves to different hex per mode)`);
console.log(`❌ STATIC    ${MISSING.length}/${total}  (CSS same hex both modes — dark override missing)`);
console.log(`⏭  SKIPPED   ${SKIPPED.length}  (no CSS var, documented)`);

if (MISSING.length) {
  console.log('\n─── Missing dark mode adaptation ─────────────────────────────────');
  for (const m of MISSING) {
    console.log(`  ❌ ${m.token} → ${m.cssVar}`);
    console.log(`       Figma: light=${m.figmaLight}  dark=${m.figmaDark}`);
    console.log(`       CSS:   resolves to ${m.cssResolved} in both modes`);
  }
  console.log('');
  process.exit(1);
} else {
  console.log('\nAll mode-variant tokens adapt correctly in CSS dark mode. ✓\n');
  process.exit(0);
}
