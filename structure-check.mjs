// structure-check.mjs — Run from project root: node scripts/structure-check.mjs
// Diffs the live Figma structural snapshot against your component contracts.
// Also verifies CSS height rules and base-rule var bindings.
//
// Requires at project root:
//   ds-config.json          — themeCSS + snapshotStructure paths
//   structure-contract.mjs  — CONTRACT, CSS_HEIGHT_RULES, CSS_BASE_RULE_VARS
//
// Exit 0 = snapshot matches contract AND CSS rules correct.
// Exit 1 = drift, missing snapshot, or CSS mismatch.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const THEME_PATH    = cfg.paths?.themeCSS          ?? 'src/theme.css';
const SNAPSHOT_PATH = cfg.paths?.snapshotStructure ?? 'src/figma-structure.snapshot.json';

// ── Load structure-contract.mjs ───────────────────────────────────────────────
let CONTRACT = {}, CSS_HEIGHT_RULES = {}, CSS_BASE_RULE_VARS = [], STATE_SELECTORS = [];
try {
  const m = await import(join(ROOT, 'structure-contract.mjs'));
  if (m.CONTRACT)           CONTRACT           = m.CONTRACT;
  if (m.CSS_HEIGHT_RULES)   CSS_HEIGHT_RULES   = m.CSS_HEIGHT_RULES;
  if (m.CSS_BASE_RULE_VARS) CSS_BASE_RULE_VARS = m.CSS_BASE_RULE_VARS;
  if (m.STATE_SELECTORS)    STATE_SELECTORS    = m.STATE_SELECTORS;
} catch { /* optional — runs with empty contract */ }

// ── Load snapshot ─────────────────────────────────────────────────────────────
let snap;
try {
  snap = JSON.parse(readFileSync(join(ROOT, SNAPSHOT_PATH), 'utf8'));
} catch {
  console.log('\n❌ figma-structure.snapshot.json not found or unreadable.');
  console.log('   Run /rms-parity Phase 1 to capture it.\n');
  process.exit(1);
}

if (!Object.keys(CONTRACT).length) {
  console.log('\n⏭  structure-contract.mjs not found or CONTRACT is empty.');
  console.log('   Copy structure-contract.example.mjs → structure-contract.mjs and fill in your components.\n');
  process.exit(0);
}

const components = snap.components ?? {};
const FAIL = [], PASS = [], MISSING = [];
const SCALAR_FIELDS = ['h', 'gapVar', 'fontSizeVar', 'fontWeightVar', 'fillStructure', 'innerRadiusVar', 'strokeOnDefault'];

for (const [name, expect] of Object.entries(CONTRACT)) {
  const got = components[name];
  if (!got) { MISSING.push(name); continue; }
  for (const f of SCALAR_FIELDS) {
    if (expect[f] !== got[f]) FAIL.push({ component: name, field: f, expected: expect[f], got: got[f] });
  }
  for (const side of ['tb', 'lr']) {
    const e = expect.paddingVar?.[side] ?? null, g = got.paddingVar?.[side] ?? null;
    if (e !== g) FAIL.push({ component: name, field: `paddingVar.${side}`, expected: e, got: g });
  }
  if (!FAIL.some(x => x.component === name)) PASS.push(name);
}

const extra = Object.keys(components).filter(c => !CONTRACT[c]);

// ── CSS height cross-check ─────────────────────────────────────────────────────
const CSS_FAIL = [], CSS_PASS = [], VAR_FAIL = [], VAR_PASS = [];
let themeCSS = null;
try { themeCSS = readFileSync(join(ROOT, THEME_PATH), 'utf8'); } catch {}

if (themeCSS) {
  const cssVars = {};
  let inRoot = false, depth = 0, rootContent = '';
  for (const line of themeCSS.split('\n')) {
    if (!inRoot && /:root\s*\{/.test(line)) { inRoot = true; depth = 1; continue; }
    if (inRoot) {
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth <= 0) { inRoot = false; continue; }
      rootContent += line + '\n';
    }
  }
  for (const m of rootContent.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) cssVars[`--${m[1]}`] = m[2].trim();

  function resolveVar(val, depth = 0) {
    if (depth > 8) return val;
    const m = String(val).match(/^var\((--[\w-]+)\)/);
    if (m && cssVars[m[1]]) return resolveVar(cssVars[m[1]], depth + 1);
    return val;
  }
  function toPx(val) {
    const r = resolveVar(val.trim()), m = String(r).match(/^(\d+(?:\.\d+)?)px/);
    return m ? Math.round(parseFloat(m[1])) : null;
  }
  function findBlock(css, selector) {
    const lines = css.split('\n');
    const pat = new RegExp('^\\s*' + selector.split(/\s+/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s+') + '(?![.\\w-])\\s*\\{');
    const start = lines.findIndex(l => pat.test(l));
    if (start < 0) return null;
    if (/\}/.test(lines[start])) { const m = lines[start].match(/\{([^}]*)\}/); return m ? m[1] : ''; }
    const block = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\}/.test(lines[i])) break;
      block.push(lines[i]);
    }
    return block.join('\n');
  }
  function extractPropVar(block, prop) {
    const re = new RegExp('(?<![a-zA-Z-])' + prop + '\\s*:\\s*(var\\(--[\\w-]+\\)|[^;\\n]+)');
    const m = block.match(re);
    if (!m) return null;
    const vm = m[1].trim().match(/^var\((--[\w-]+)/);
    return vm ? vm[1] : null;
  }

  for (const [comp, rule] of Object.entries(CSS_HEIGHT_RULES)) {
    const contractH = CONTRACT[comp]?.h;
    if (contractH === undefined || contractH === 'auto') { CSS_PASS.push(comp); continue; }
    const block = findBlock(themeCSS, rule.selector);
    if (!block) { CSS_FAIL.push(`${comp}: selector "${rule.selector}" not found in theme CSS`); continue; }
    const propPattern = rule.prop === 'height' ? '(?<!-)height' : 'min-height';
    const hMatch = block.match(new RegExp(propPattern + '\\s*:\\s*([^;\\n]+)'));
    if (!hMatch) { CSS_FAIL.push(`${comp}: "${rule.prop}" not set — contract expects ${contractH}px`); continue; }
    const cssPx = toPx(hMatch[1]);
    if (cssPx === null) CSS_FAIL.push(`${comp}: could not resolve "${hMatch[1].trim()}" to px`);
    else if (cssPx !== contractH) CSS_FAIL.push(`${comp}: CSS ${rule.prop} is ${cssPx}px — contract expects ${contractH}px`);
    else CSS_PASS.push(comp);
  }

  for (const rule of CSS_BASE_RULE_VARS) {
    const block = findBlock(themeCSS, rule.selector);
    if (!block) { VAR_FAIL.push(`${rule.key}: selector "${rule.selector}" not found`); continue; }
    const usedVar = extractPropVar(block, rule.prop);
    if (!usedVar) VAR_FAIL.push(`${rule.key}: "${rule.prop}" not set in "${rule.selector}"`);
    else if (usedVar !== rule.expectedVar) VAR_FAIL.push(`${rule.key}: "${rule.selector}" ${rule.prop} uses ${usedVar} — expected ${rule.expectedVar}`);
    else VAR_PASS.push(rule.key);
  }
}

// ── State/variant selector check ─────────────────────────────────────────────
// Verify every Figma state/variant maps to an existing CSS selector.
// Reads all CSS source files: theme CSS + plugin CSS from ds-config.json.
const SELECTOR_FAIL = [], SELECTOR_PASS = [];
if (STATE_SELECTORS.length) {
  const cssFiles = [THEME_PATH, ...(cfg.paths?.pluginCSS ?? [])];
  const allCss = cssFiles
    .filter(f => existsSync(join(ROOT, f)))
    .map(f => readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
    .join('\n');

  for (const entry of STATE_SELECTORS) {
    // Match selector as a CSS rule opener: preceded by start/comma/newline,
    // followed by optional whitespace then { or ,
    const esc = entry.selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re  = new RegExp(`(?:^|[,\\n])\\s*${esc}\\s*(?:,|\\{)`, 'm');
    if (re.test(allCss)) {
      SELECTOR_PASS.push(`${entry.component}/${entry.figmaState}`);
    } else {
      SELECTOR_FAIL.push(entry);
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n✅ PASS  ${PASS.length}/${Object.keys(CONTRACT).length} components`);
console.log(`❌ FAIL  ${FAIL.length} field(s)`);
if (MISSING.length) console.log(`❓ MISSING from snapshot: ${MISSING.join(', ')}`);
if (extra.length)   console.log(`🆕 In snapshot, not in contract: ${extra.join(', ')}`);

if (FAIL.length) {
  console.log('\n─── Structural drift ──────────────────────────────────────────');
  for (const f of FAIL) console.log(`  ❌ ${f.component}.${f.field}: contract=${JSON.stringify(f.expected)}  Figma=${JSON.stringify(f.got)}`);
}

if (themeCSS) {
  console.log(`\n✅ PASS  ${CSS_PASS.length}/${Object.keys(CSS_HEIGHT_RULES).length} CSS height rules`);
  console.log(`❌ FAIL  ${CSS_FAIL.length}`);
  if (CSS_FAIL.length) for (const f of CSS_FAIL) console.log(`  ❌ ${f}`);
  console.log(`\n✅ PASS  ${VAR_PASS.length}/${CSS_BASE_RULE_VARS.length} CSS base-rule var bindings`);
  console.log(`❌ FAIL  ${VAR_FAIL.length}`);
  if (VAR_FAIL.length) for (const f of VAR_FAIL) console.log(`  ❌ ${f}`);
} else {
  console.log('\n⚠️  theme CSS not found — CSS height and var-binding checks skipped');
}

if (STATE_SELECTORS.length) {
  console.log(`\n✅ PASS  ${SELECTOR_PASS.length}/${STATE_SELECTORS.length} state/variant selectors`);
  console.log(`❌ FAIL  ${SELECTOR_FAIL.length}`);
  if (SELECTOR_FAIL.length) {
    console.log('\n─── Missing state selectors ───────────────────────────────────');
    for (const f of SELECTOR_FAIL)
      console.log(`  ❌ ${f.component} [${f.figmaState}]: selector "${f.selector}" not found in CSS`);
  }
} else if (Object.keys(CONTRACT).length) {
  console.log('\n⏭  STATE_SELECTORS empty in structure-contract.mjs — state selector check skipped');
}

const anyFail = FAIL.length > 0 || MISSING.length > 0 || CSS_FAIL.length > 0 || VAR_FAIL.length > 0 || SELECTOR_FAIL.length > 0;
if (!anyFail) { console.log('\nAll component structures match the contract. ✓\n'); process.exit(0); }
else { console.log(''); process.exit(1); }
