// structure-check.mjs — Run from project root: node scripts/structure-check.mjs
// Gate [3] — structural parity: snapshot vs contract, CSS height rules,
//             base-rule var bindings, and state/variant selector + var bindings.
//
// Full verification chain for every Figma state:
//   1. Selector exists in CSS
//   2. Selector's rule uses the correct token var for each property
//   3. (Gate [2]) That var resolves to the correct hex value
//
// Requires at project root:
//   ds-config.json          — themeCSS + snapshotStructure + pluginCSS paths
//   structure-contract.mjs  — CONTRACT, CSS_HEIGHT_RULES, CSS_BASE_RULE_VARS,
//                             STATE_SELECTORS
//
// Exit 0 = all checks pass. Exit 1 = any failure.

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
const PLUGIN_CSS    = cfg.paths?.pluginCSS          ?? [];

// ── Load structure-contract.mjs ───────────────────────────────────────────────
let CONTRACT = {}, CSS_HEIGHT_RULES = {}, CSS_BASE_RULE_VARS = [], STATE_SELECTORS = [];
let FIGMA_LAYOUT_TO_CSS = {}, FONT_SCALE_TO_CSS = {}, COMPONENT_CSS_SELECTORS = {};
let CSS_PROPERTY_ASSERTIONS = [];
try {
  const m = await import(join(ROOT, 'structure-contract.mjs'));
  if (m.CONTRACT)                  CONTRACT                  = m.CONTRACT;
  if (m.CSS_HEIGHT_RULES)          CSS_HEIGHT_RULES          = m.CSS_HEIGHT_RULES;
  if (m.CSS_BASE_RULE_VARS)        CSS_BASE_RULE_VARS        = m.CSS_BASE_RULE_VARS;
  if (m.STATE_SELECTORS)           STATE_SELECTORS           = m.STATE_SELECTORS;
  if (m.FIGMA_LAYOUT_TO_CSS)       FIGMA_LAYOUT_TO_CSS       = m.FIGMA_LAYOUT_TO_CSS;
  if (m.FONT_SCALE_TO_CSS)         FONT_SCALE_TO_CSS         = m.FONT_SCALE_TO_CSS;
  if (m.COMPONENT_CSS_SELECTORS)   COMPONENT_CSS_SELECTORS   = m.COMPONENT_CSS_SELECTORS;
  if (m.CSS_PROPERTY_ASSERTIONS)   CSS_PROPERTY_ASSERTIONS   = m.CSS_PROPERTY_ASSERTIONS;
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

if (!Object.keys(CONTRACT).length && !STATE_SELECTORS.length) {
  console.log('\n⏭  structure-contract.mjs not found or all exports empty.');
  console.log('   Copy structure-contract.example.mjs → structure-contract.mjs and fill in your components.\n');
  process.exit(0);
}

// ── Load CSS sources ──────────────────────────────────────────────────────────
// themeCSS  — used for height rules and base-rule var checks (central declarations)
// allCss    — theme + all plugin files, used for state selector checks
//             (state rules often live in plugin/component files)
let themeCSS = null;
try { themeCSS = readFileSync(join(ROOT, THEME_PATH), 'utf8'); } catch {}

const cssFiles  = [THEME_PATH, ...PLUGIN_CSS].filter(f => existsSync(join(ROOT, f)));
const allCss    = cssFiles.map(f => readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n');

// Build block indexes once — findBlock() uses these for O(1) lookups
const themeIndex = themeCSS ? buildBlockIndex(themeCSS) : null;
const allIndex   = buildBlockIndex(allCss);

// ── CSS utility helpers ───────────────────────────────────────────────────────
// Both helpers take an explicit css string so they work on themeCSS or allCss.

// buildBlockIndex — parse CSS once into Map<normalizedSelector → blockContent>.
// Handles flat rules only (no nested braces). Called once per CSS source on load;
// subsequent findBlock calls hit the Map in O(1) instead of scanning all lines.
function buildBlockIndex(css) {
  const index = new Map();
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (sel) index.set(sel, m[2]);
  }
  return index;
}

// findBlock — O(1) index lookup with linear-scan fallback for complex selectors.
function findBlock(css, selector, index) {
  if (index) {
    // Exact match
    if (index.has(selector)) return index.get(selector);
    // Normalised-whitespace match (handles extra spaces in source)
    const norm = selector.replace(/\s+/g, ' ').trim();
    if (index.has(norm)) return index.get(norm);
  }
  // Fallback: original line-scan for selectors not found in the index
  // (e.g. multi-selector rules `.a, .b { }`, or selectors with combinators)
  const lines   = css.split('\n');
  const escaped = selector.split(/\s+/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const pat     = new RegExp('^\\s*' + escaped + '(?![.\\w-])\\s*\\{');
  const start   = lines.findIndex(l => pat.test(l));
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
  const m  = block?.match(re);
  if (!m) return null;
  const vm = m[1].trim().match(/^var\((--[\w-]+)/);
  return vm ? vm[1] : null;
}

function selectorExists(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[,\\n])\\s*${esc}\\s*(?:,|\\{)`, 'm').test(css);
}

// ── 1. Snapshot vs CONTRACT ───────────────────────────────────────────────────
const components = snap.components ?? {};
const FAIL = [], PASS = [], MISSING = [];
const SCALAR_FIELDS = ['h', 'gapVar', 'fontSizeVar', 'fontWeightVar', 'fillStructure', 'innerRadiusVar', 'strokeOnDefault'];

// A CONTRACT entry is "structural" if it declares at least one structural field.
// Entries that only carry propertyMap (no h/gapVar/etc.) skip snapshot comparison.
function hasStructuralFields(entry) {
  return SCALAR_FIELDS.some(f => entry[f] !== undefined) || entry.paddingVar !== undefined;
}

for (const [name, expect] of Object.entries(CONTRACT)) {
  if (!hasStructuralFields(expect)) continue; // propertyMap-only entry — skip snapshot check
  const got = components[name];
  if (!got) { MISSING.push(name); continue; }
  for (const f of SCALAR_FIELDS) {
    if (expect[f] !== got[f])
      FAIL.push({ component: name, field: f, expected: expect[f], got: got[f] });
  }
  for (const side of ['tb', 'lr']) {
    const e = expect.paddingVar?.[side] ?? null, g = got.paddingVar?.[side] ?? null;
    if (e !== g) FAIL.push({ component: name, field: `paddingVar.${side}`, expected: e, got: g });
  }
  if (!FAIL.some(x => x.component === name)) PASS.push(name);
}

const extra = Object.keys(components).filter(c => !CONTRACT[c]);

// ── CSS var resolver (shared by height checks and pill geometry checks) ───────
const cssVars = {};
if (themeCSS) {
  let inRoot = false, rootDepth = 0, rootContent = '';
  for (const line of themeCSS.split('\n')) {
    if (!inRoot && /:root\s*\{/.test(line)) { inRoot = true; rootDepth = 1; continue; }
    if (inRoot) {
      rootDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (rootDepth <= 0) { inRoot = false; continue; }
      rootContent += line + '\n';
    }
  }
  for (const m of rootContent.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) cssVars[`--${m[1]}`] = m[2].trim();
}
function resolveVar(val, d = 0) {
  if (d > 8) return val;
  const m = String(val).match(/^var\((--[\w-]+)\)/);
  if (m && cssVars[m[1]]) return resolveVar(cssVars[m[1]], d + 1);
  return val;
}
function toPx(val) {
  const r = resolveVar(val.trim()), m = String(r).match(/^(\d+(?:\.\d+)?)px/);
  return m ? Math.round(parseFloat(m[1])) : null;
}

// ── 2. CSS height cross-check ─────────────────────────────────────────────────
const CSS_FAIL = [], CSS_PASS = [];

if (themeCSS) {
  for (const [comp, rule] of Object.entries(CSS_HEIGHT_RULES)) {
    const contractH = CONTRACT[comp]?.h;
    if (contractH === undefined || contractH === 'auto') { CSS_PASS.push(comp); continue; }
    const block = findBlock(themeCSS, rule.selector, themeIndex);
    if (!block) { CSS_FAIL.push(`${comp}: selector "${rule.selector}" not found in theme CSS`); continue; }
    const propPattern = rule.prop === 'height' ? '(?<!-)height' : 'min-height';
    const hMatch = block.match(new RegExp(propPattern + '\\s*:\\s*([^;\\n]+)'));
    if (!hMatch) { CSS_FAIL.push(`${comp}: "${rule.prop}" not set — contract expects ${contractH}px`); continue; }
    const cssPx = toPx(hMatch[1]);
    if (cssPx === null) CSS_FAIL.push(`${comp}: could not resolve "${hMatch[1].trim()}" to px`);
    else if (cssPx !== contractH) CSS_FAIL.push(`${comp}: CSS ${rule.prop} is ${cssPx}px — contract expects ${contractH}px`);
    else CSS_PASS.push(comp);
  }
}

// ── 3. CSS base-rule var bindings ─────────────────────────────────────────────
const VAR_FAIL = [], VAR_PASS = [];

if (themeCSS) {
  for (const rule of CSS_BASE_RULE_VARS) {
    const block = findBlock(themeCSS, rule.selector, themeIndex);
    if (!block) { VAR_FAIL.push(`${rule.key}: selector "${rule.selector}" not found`); continue; }
    const usedVar = extractPropVar(block, rule.prop);
    if (!usedVar) VAR_FAIL.push(`${rule.key}: "${rule.prop}" not set in "${rule.selector}"`);
    else if (usedVar !== rule.expectedVar) VAR_FAIL.push(`${rule.key}: "${rule.selector}" ${rule.prop} uses ${usedVar} — expected ${rule.expectedVar}`);
    else VAR_PASS.push(rule.key);
  }
}

// ── 4. State/variant selectors + var bindings ─────────────────────────────────
// Full chain per state:
//   (a) selector exists in CSS (theme or plugin files)
//   (b) for each declared var: selector's rule uses the expected token var
//
// Token values are verified by Gate [2] — this gate verifies the wiring.
const SELECTOR_FAIL = [], SELECTOR_PASS = [];

for (const entry of STATE_SELECTORS) {
  const label = `${entry.component} [${entry.figmaState}] "${entry.selector}"`;

  // (a) Selector existence
  if (!selectorExists(allCss, entry.selector)) {
    SELECTOR_FAIL.push({ label, issue: 'selector not found in any CSS file' });
    continue;
  }

  // (b) Var bindings (if declared)
  if (!entry.vars?.length) {
    SELECTOR_PASS.push(label);
    continue;
  }

  const block = findBlock(allCss, entry.selector, allIndex);
  if (!block) {
    SELECTOR_FAIL.push({ label, issue: 'selector found but rule block could not be parsed' });
    continue;
  }

  let allVarsPass = true;
  for (const v of entry.vars) {
    const usedVar = extractPropVar(block, v.prop);
    if (!usedVar) {
      SELECTOR_FAIL.push({ label, issue: `"${v.prop}" not set in rule`, expected: v.expectedVar });
      allVarsPass = false;
    } else if (usedVar !== v.expectedVar) {
      SELECTOR_FAIL.push({ label, issue: `"${v.prop}" uses ${usedVar} — expected ${v.expectedVar}` });
      allVarsPass = false;
    }
  }
  if (allVarsPass) SELECTOR_PASS.push(label);
}

// ── 5. CSS property binding checks ───────────────────────────────────────────
// Verifies each component's CSS rule uses the Figma-bound CSS var for key layout
// properties. Catches right-value-wrong-var bugs (e.g. gap: var(--padding-m) when
// gap/m and padding/m have the same px but differ by DS spec).
// Only runs when COMPONENT_CSS_SELECTORS is exported from structure-contract.mjs.
const PROP_FAIL = [], PROP_PASS = [];

if (themeCSS && Object.keys(COMPONENT_CSS_SELECTORS).length) {
  function propHasVar(block, prop, expectedVar) {
    if (!block || !expectedVar) return false;
    const re = new RegExp('(?<![a-zA-Z-])' + prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^;]+)');
    const m  = block.match(re);
    return m ? m[1].includes(`var(${expectedVar})`) : false;
  }

  function propActual(block, prop) {
    if (!block) return '(not set)';
    const re = new RegExp('(?<![a-zA-Z-])' + prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^;]+)');
    const m  = block?.match(re);
    return m ? m[1].trim().slice(0, 60) : '(not set)';
  }

  for (const [comp, contract] of Object.entries(CONTRACT)) {
    const selCfg = COMPONENT_CSS_SELECTORS[comp];
    if (!selCfg) continue;

    const mainBlock   = findBlock(themeCSS, selCfg.main, themeIndex);
    const gapBlock    = selCfg.gapSel    ? findBlock(themeCSS, selCfg.gapSel,    themeIndex) : mainBlock;
    const fontBlock   = selCfg.fontSel   ? findBlock(themeCSS, selCfg.fontSel,   themeIndex) : mainBlock;
    const radiusBlock = selCfg.radiusSel ? findBlock(themeCSS, selCfg.radiusSel, themeIndex) : mainBlock;

    if (!mainBlock) {
      PROP_FAIL.push(`${comp}: selector "${selCfg.main}" not found in theme CSS`);
      continue;
    }

    const check = (label, block, prop, expectedVar, sel) => {
      if (!expectedVar) return;
      if (!block) { PROP_FAIL.push(`${comp}/${label}: selector "${sel}" not found`); return; }
      if (propHasVar(block, prop, expectedVar)) {
        PROP_PASS.push(`${comp}/${label}`);
      } else {
        PROP_FAIL.push(`${comp}/${label}: expected var(${expectedVar}) in "${prop}" — got: ${propActual(block, prop)}`);
      }
    };

    if (contract.gapVar)
      check('gap', gapBlock, 'gap', FIGMA_LAYOUT_TO_CSS[contract.gapVar], selCfg.gapSel ?? selCfg.main);
    if (contract.paddingVar?.tb && !selCfg.skipTBPadding)
      check('padding-tb', mainBlock, 'padding', FIGMA_LAYOUT_TO_CSS[contract.paddingVar.tb], selCfg.main);
    if (contract.paddingVar?.lr)
      check('padding-lr', mainBlock, 'padding', FIGMA_LAYOUT_TO_CSS[contract.paddingVar.lr], selCfg.main);
    if (contract.fontSizeVar)
      check('font-size', fontBlock, 'font-size', FONT_SCALE_TO_CSS[contract.fontSizeVar]?.size, selCfg.fontSel ?? selCfg.main);
    if (contract.fontWeightVar)
      check('font-weight', fontBlock, 'font-weight', FONT_SCALE_TO_CSS[contract.fontWeightVar]?.weight, selCfg.fontSel ?? selCfg.main);
    if (contract.innerRadiusVar)
      check('radius', radiusBlock, 'border-radius', FIGMA_LAYOUT_TO_CSS[contract.innerRadiusVar], selCfg.radiusSel ?? selCfg.main);
  }
}

// ── Gate [3b]: Border-sides check ────────────────────────────────────────────
// When contract.strokeSides is set, verifies the CSS uses exactly those border sides.
//   'bottom' → must have border-bottom; must NOT have bare "border:" shorthand
//   'all'    → must have bare "border:" shorthand
// This catches the specific class of bug where all-sides border is used when only
// a bottom divider is correct (or vice versa).
// To enable: add strokeSides: 'bottom' | 'all' to the component in CONTRACT.
const BSIDES_FAIL = [], BSIDES_PASS = [];

if (themeCSS && Object.keys(COMPONENT_CSS_SELECTORS).length) {
  for (const [comp, contract] of Object.entries(CONTRACT)) {
    if (!contract.strokeSides) continue;
    const selCfg = COMPONENT_CSS_SELECTORS[comp];
    if (!selCfg) continue;
    const mainBlock = findBlock(themeCSS, selCfg.main, themeIndex);
    if (!mainBlock) { BSIDES_FAIL.push(`${comp}/stroke-sides: selector "${selCfg.main}" not found`); continue; }

    // \bborder\s*: matches bare "border:" shorthand but NOT "border-bottom:", "border-radius:", etc.
    const hasShorthand = /\bborder\s*:/.test(mainBlock);
    const hasBottom    = /\bborder-bottom\s*:/.test(mainBlock);

    if (contract.strokeSides === 'bottom') {
      if (hasShorthand) {
        BSIDES_FAIL.push(`${comp}/stroke-sides: CSS uses "border:" (all sides) — contract says border-bottom only`);
      } else if (!hasBottom) {
        BSIDES_FAIL.push(`${comp}/stroke-sides: CSS missing "border-bottom" — contract says bottom stroke only`);
      } else {
        BSIDES_PASS.push(`${comp}/stroke-sides`);
      }
    } else if (contract.strokeSides === 'all') {
      if (!hasShorthand) {
        BSIDES_FAIL.push(`${comp}/stroke-sides: CSS missing "border:" shorthand — contract says all-sides stroke`);
      } else {
        BSIDES_PASS.push(`${comp}/stroke-sides`);
      }
    }
  }
}

// ── Gate [3c]: Phantom CSS borders ───────────────────────────────────────────
// Scans EVERY CSS rule whose selector contains a component's base class and flags
// any `border` or `outline` property when Figma has no stroke on any variant.
//
// Uses snapshot.strokeOnAnyState (walk all COMPONENT_SET children) when present;
// falls back to strokeOnDefault (default-variant only) when the field is absent.
//
// Exceptions: add selector strings to ds-config.json → knownPhantomBorderExceptions.
// Example: [".badge:focus-visible"] to allow focus rings.
const PHANTOM_FAIL = [], PHANTOM_PASS = [];
const PHANTOM_SKIP = new Set(cfg.knownPhantomBorderExceptions ?? []);

// Matches border/outline properties but NOT border-radius or border-spacing.
const BORDER_PROP_RE = /\b(border(?:-(?:top|right|bottom|left|color|width|style))?|outline(?:-(?:color|width|style))?)\s*:/;
// Values that represent no visible stroke — don't flag these.
// Catches: "none", "0", "0px", "transparent", "1px solid transparent", "var(--x) solid transparent"
const TRANSPARENT_VAL_RE = /\btransparent\b|^\s*(?:none|0(?:px)?)\s*(?:!important)?\s*$/i;

if (Object.keys(COMPONENT_CSS_SELECTORS).length && Object.keys(components).length) {
  // Build flat list of (selector, block) from allIndex once, reuse per component.
  const allRules = [...allIndex.entries()]; // [selector, blockContent]

  for (const [comp, selCfg] of Object.entries(COMPONENT_CSS_SELECTORS)) {
    const snapComp = components[comp];
    if (!snapComp) continue;

    // strokeOnAnyState = explicit field when available; fallback to strokeOnDefault.
    const hasAnyStroke = snapComp.strokeOnAnyState ?? snapComp.strokeOnDefault ?? false;
    if (hasAnyStroke) {
      PHANTOM_PASS.push(`${comp} (Figma has stroke — CSS borders permitted)`);
      continue;
    }

    // Extract the root CSS class from the main selector (e.g. ".badge" from ".badge").
    const baseClass = selCfg.main.match(/(\.[a-zA-Z][\w-]*)/)?.[1];
    if (!baseClass) continue;

    for (const [sel, block] of allRules) {
      // Only rules whose selector contains the component's base class.
      if (!sel.includes(baseClass)) continue;
      // Skip known exceptions.
      if (PHANTOM_SKIP.has(sel)) { PHANTOM_PASS.push(`${comp}: "${sel}" (exempted)`); continue; }

      const propMatch = block.match(BORDER_PROP_RE);
      if (!propMatch) continue;

      // Extract the value and skip transparent/none/0 declarations.
      const prop = propMatch[1];
      const valMatch = block.match(new RegExp('\\b' + prop.replace(/-/g, '\\-') + '\\s*:\\s*([^;]+)'));
      const val = valMatch?.[1] ?? '';
      if (TRANSPARENT_VAL_RE.test(val)) continue;

      PHANTOM_FAIL.push(`${comp}: "${sel}" has \`${prop}: ${val.trim().slice(0, 60)}\` — Figma has no stroke on any variant (strokeOnAnyState=false)`);
    }

    if (!PHANTOM_FAIL.some(f => f.startsWith(`${comp}:`))) PHANTOM_PASS.push(`${comp} (no phantom borders)`);
  }
}

// ── 6. Hover/Selected pill geometry checks ────────────────────────────────────
// Components that implement hover/selected backgrounds via a positioned ::before
// element (a "pill") need two geometry checks the default-state snapshot misses:
//   (a) inset — must equal (outer_h - inner_h) / 2 so the pill fills the inner frame
//   (b) border-radius — must use the DS var from hoverPill.radiusVar in the contract
//
// To enable: add hoverPill: { innerH, radiusVar } to the component in CONTRACT
// and beforeSel: '.<comp>::before' to COMPONENT_CSS_SELECTORS.
// capture innerH from the hover/selected variant's Content child frame in Figma.
const PILL_FAIL = [], PILL_PASS = [];

if (themeCSS && Object.keys(COMPONENT_CSS_SELECTORS).length) {
  for (const [comp, contract] of Object.entries(CONTRACT)) {
    const pill = contract.hoverPill;
    if (!pill) continue;
    const selCfg = COMPONENT_CSS_SELECTORS[comp];
    if (!selCfg?.beforeSel) continue;

    const beforeBlock = findBlock(themeCSS, selCfg.beforeSel, themeIndex);
    if (!beforeBlock) {
      PILL_FAIL.push(`${comp}: "${selCfg.beforeSel}" not found in theme CSS`);
      continue;
    }

    // (a) inset vertical component — must equal (outer_h − inner_h) / 2
    // Supports "4px" (all-sides) or "4px 0" (vertical horizontal) — checks first value only
    const expectedInset = (contract.h - pill.innerH) / 2;
    const insetMatch = beforeBlock.match(/\binset\s*:\s*([^;]+)/);
    if (!insetMatch) {
      PILL_FAIL.push(`${comp}/pill-inset: "inset" not set in "${selCfg.beforeSel}" — expected ${expectedInset}px`);
    } else {
      const verticalPart = insetMatch[1].trim().split(/\s+/)[0];
      const actualPx = toPx(verticalPart);
      if (actualPx === null) {
        PILL_FAIL.push(`${comp}/pill-inset: could not resolve vertical inset "${verticalPart}" to px`);
      } else if (actualPx !== expectedInset) {
        PILL_FAIL.push(`${comp}/pill-inset: vertical inset is ${actualPx}px — expected ${expectedInset}px  (outer ${contract.h}px − inner ${pill.innerH}px) / 2`);
      } else {
        PILL_PASS.push(`${comp}/pill-inset`);
      }
    }

    // (b) border-radius must use the mapped DS var
    if (pill.radiusVar) {
      const expectedRadiusVar = FIGMA_LAYOUT_TO_CSS[pill.radiusVar];
      if (expectedRadiusVar) {
        const usedVar = extractPropVar(beforeBlock, 'border-radius');
        if (!usedVar) {
          PILL_FAIL.push(`${comp}/pill-radius: "border-radius" not set in "${selCfg.beforeSel}"`);
        } else if (usedVar !== expectedRadiusVar) {
          PILL_FAIL.push(`${comp}/pill-radius: border-radius uses ${usedVar} — expected var(${expectedRadiusVar}) [${pill.radiusVar}]`);
        } else {
          PILL_PASS.push(`${comp}/pill-radius`);
        }
      }
    }

    // (c) inset horizontal component — when hoverPill.insetH is defined
    // Catches "inset: 4px" (wrong — pill narrowed LR) vs "inset: 4px 0" (full width)
    if (pill.insetH !== undefined && insetMatch) {
      const insetParts = insetMatch[1].trim().split(/\s+/);
      if (insetParts.length < 2) {
        const expectedH = pill.insetH === 0 ? '0' : `${pill.insetH}px`;
        PILL_FAIL.push(`${comp}/pill-inset-h: inset has no horizontal value — expected "…px ${expectedH}" (horizontal must be ${expectedH})`);
      } else {
        const horizPart  = insetParts[1];
        const expectedH  = pill.insetH;
        const actualH    = (horizPart === '0') ? 0 : toPx(horizPart);
        if (actualH === expectedH) {
          PILL_PASS.push(`${comp}/pill-inset-h`);
        } else {
          const expectedStr = expectedH === 0 ? '0' : `${expectedH}px`;
          PILL_FAIL.push(`${comp}/pill-inset-h: horizontal inset is "${horizPart}" — expected ${expectedStr}`);
        }
      }
    }
  }
}

// ── Gate [3f]: Sub-frame layout (children) ───────────────────────────────────
// Verifies gap and padding on named child frames that have explicit CSS selectors.
// Contract: CONTRACT[comp].children = [{ name, cssSelector, gapVar?, paddingVar? }]
// Uses allCss (all files) since child selectors may live in plugin or shared files.
const CHILD_FAIL = [], CHILD_PASS = [];

for (const [comp, contract] of Object.entries(CONTRACT)) {
  if (!contract.children?.length) continue;
  for (const child of contract.children) {
    const block = findBlock(allCss, child.cssSelector, allIndex);
    if (!block) {
      CHILD_FAIL.push(`${comp}/${child.name}: selector "${child.cssSelector}" not found in CSS`);
      continue;
    }
    if (child.gapVar) {
      const expectedVar = FIGMA_LAYOUT_TO_CSS[child.gapVar];
      if (expectedVar) {
        const usedVar = extractPropVar(block, 'gap');
        if (usedVar === expectedVar) CHILD_PASS.push(`${comp}/${child.name}/gap`);
        else CHILD_FAIL.push(`${comp}/${child.name}/gap: "${usedVar ?? '(not set)'}" ≠ var(${expectedVar}) [${child.gapVar}]`);
      }
    }
    for (const [side, tokenName] of [['tb', child.paddingVar?.tb], ['lr', child.paddingVar?.lr]]) {
      if (!tokenName) continue;
      const expectedVar = FIGMA_LAYOUT_TO_CSS[tokenName];
      if (!expectedVar) continue;
      const padMatch = block.match(/(?<![a-zA-Z-])padding\s*:\s*([^;]+)/);
      const padVal   = padMatch?.[1] ?? '';
      if (padVal.includes(`var(${expectedVar})`)) CHILD_PASS.push(`${comp}/${child.name}/padding-${side}`);
      else CHILD_FAIL.push(`${comp}/${child.name}/padding-${side}: padding missing var(${expectedVar}) [${tokenName}] — got: ${padVal.trim().slice(0, 60) || '(not set)'}`);
    }
  }
}

// ── Gate [3e]: CSS property assertions ───────────────────────────────────────
// Verifies arbitrary CSS properties on any selector — for plugin-specific
// selectors that mirror DS components (e.g. buttonListRow) but aren't in CONTRACT.
//
// Export CSS_PROPERTY_ASSERTIONS from structure-contract.mjs as an array of:
//   { sel, prop, expected }    — CSS value must equal exactly this string
//   { sel, prop, present }     — true = property must exist; false = must NOT exist
//   { sel, prop, expectedVar } — property must use var(expectedVar)
//
// Uses allIndex (comment-stripped, all CSS files) so pseudo-elements work too.
const ASSERT_FAIL = [], ASSERT_PASS = [];

if (CSS_PROPERTY_ASSERTIONS.length) {
  const propRe = (prop) => new RegExp(
    '(?<![a-zA-Z-])' + prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^;\\n]+)'
  );
  const presentRe = (prop) => new RegExp(
    '\\b' + prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:'
  );

  for (const a of CSS_PROPERTY_ASSERTIONS) {
    const block = findBlock(allCss, a.sel, allIndex);

    if ('expected' in a) {
      const m = block?.match(propRe(a.prop));
      const actual = m ? m[1].trim() : null;
      if (actual === a.expected) {
        ASSERT_PASS.push(`${a.sel}/${a.prop}`);
      } else {
        ASSERT_FAIL.push(`${a.sel}/${a.prop}: "${actual ?? '(not set)'}" ≠ "${a.expected}"`);
      }
    } else if ('present' in a) {
      const found = block ? presentRe(a.prop).test(block) : false;
      if (a.present === found) {
        ASSERT_PASS.push(`${a.sel}/${a.prop}`);
      } else if (a.present) {
        ASSERT_FAIL.push(`${a.sel}/${a.prop}: property missing — must be present`);
      } else {
        ASSERT_FAIL.push(`${a.sel}/${a.prop}: has "${a.prop}:" — must NOT be present`);
      }
    } else if ('expectedVar' in a) {
      // Match var(--x) OR var(--x, fallback) — the closing paren moves when a fallback is present.
      const m = block?.match(propRe(a.prop));
      const fullVal = m ? m[1].trim() : null;
      const varPat = new RegExp(`var\\(${a.expectedVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,)]`);
      if (fullVal && varPat.test(fullVal)) {
        ASSERT_PASS.push(`${a.sel}/${a.prop}`);
      } else {
        const usedVar = block ? extractPropVar(block, a.prop) : null;
        ASSERT_FAIL.push(`${a.sel}/${a.prop}: uses "${usedVar ?? '(not set)'}" ≠ var(${a.expectedVar})`);
      }
    }
  }
}

// ── Gate [3g]: Component Property Parity ─────────────────────────────────────
// Verifies that every Figma component property (BOOLEAN/VARIANT) has a CSS
// implementation. Reads figma-component-props.snapshot.json (written by audit.mjs
// on every run when FIGMA_TOKEN is set).
//
// CONTRACT entry fields:
//   figmaName   — Figma component set name (defaults to the CONTRACT key)
//   propertyMap — map of Figma property name → one of:
//     null / false         → explicitly skipped (no CSS needed)
//     'css-selector'       → selector must exist somewhere in allCss
//     { k: 'selector', … } → each value must exist in allCss (variant states or
//                            show/hide pair, e.g. { show: '.el', hide: '@container ...' })
const COMP_PROPS_SNAP_PATH = cfg.paths?.compPropsSnapshot ??
  SNAPSHOT_PATH.replace(/[^/\\]+$/, 'figma-component-props.snapshot.json');

let COMP_PROPS = {};
try { COMP_PROPS = JSON.parse(readFileSync(join(ROOT, COMP_PROPS_SNAP_PATH), 'utf8')); } catch {}

const CPROP_PASS = [], CPROP_FAIL = [], CPROP_WARN = [];

// Figma property keys include internal node IDs as suffixes: "Show Label#958:0"
// Strip them so propertyMap authors use clean names: "Show Label"
function normPropName(k) { return k.replace(/#[\d:]+$/, '').trim(); }

// Components deliberately not implemented in code — exempt from Gate [3g] FAIL.
// Add to ds-config.json → knownUnimplementedComponents with a reason comment.
const KNOWN_UNIMPLEMENTED = new Set(cfg.knownUnimplementedComponents ?? []);

// Build lookup: figmaName → CONTRACT key (for components in CONTRACT)
const figmaNameToContractKey = {};
for (const [key, c] of Object.entries(CONTRACT)) {
  figmaNameToContractKey[c.figmaName ?? key] = key;
}

// Discovery: FAIL for any Figma component with BOOLEAN/VARIANT properties that is
// not covered by a propertyMap in CONTRACT and not explicitly exempted.
// Warn (not fail) for CONTRACT components that are missing their propertyMap.
for (const [figmaName, entry] of Object.entries(COMP_PROPS)) {
  if (figmaName === '_updated' || !entry?.properties) continue;
  const hasBehavioural = Object.values(entry.properties).some(
    p => p.type === 'BOOLEAN' || p.type === 'VARIANT'
  );
  if (!hasBehavioural) continue;

  const contractKey = figmaNameToContractKey[figmaName];

  if (!contractKey) {
    // Not in CONTRACT at all
    if (!KNOWN_UNIMPLEMENTED.has(figmaName)) {
      CPROP_FAIL.push(
        `${figmaName}: Figma component has BOOLEAN/VARIANT properties but no CONTRACT entry` +
        ` — add propertyMap or list in ds-config.json → knownUnimplementedComponents`
      );
    }
    continue;
  }

  if (!CONTRACT[contractKey]?.propertyMap) {
    // In CONTRACT but propertyMap not yet filled in
    CPROP_WARN.push(`${contractKey}: in CONTRACT but missing propertyMap — ${
      Object.entries(entry.properties)
        .filter(([, d]) => d.type === 'BOOLEAN' || d.type === 'VARIANT')
        .map(([k]) => normPropName(k))
        .join(', ')
    }`);
  }
}

// Implementation check: for each CONTRACT entry with propertyMap
for (const [comp, contract] of Object.entries(CONTRACT)) {
  if (!contract.propertyMap) continue;
  const figmaName   = contract.figmaName ?? comp;
  const figmaEntry  = COMP_PROPS[figmaName];

  if (!figmaEntry?.properties) {
    CPROP_WARN.push(`${comp}: "${figmaName}" not in component props snapshot — run parity to refresh`);
    continue;
  }

  // Build normalized property lookup from snapshot
  const figmaProps = Object.fromEntries(
    Object.entries(figmaEntry.properties).map(([k, v]) => [normPropName(k), v])
  );

  // Coverage: warn about BOOLEAN/VARIANT props not in propertyMap (use normalized names)
  for (const [normName, propDef] of Object.entries(figmaProps)) {
    if (propDef.type === 'TEXT' || propDef.type === 'INSTANCE_SWAP' || propDef.type === 'SLOT') continue;
    if (!(normName in contract.propertyMap)) {
      CPROP_WARN.push(`${comp}/${normName}: Figma ${propDef.type} property not in propertyMap`);
    }
  }

  // Implementation: verify each propertyMap entry's CSS selector exists.
  // null = unimplemented → FAIL for BOOLEAN/VARIANT (they require a CSS mechanism).
  // TEXT/INSTANCE_SWAP/SLOT mapped to null = intentionally skipped (no CSS needed).
  for (const [propName, mapping] of Object.entries(contract.propertyMap)) {
    if (mapping === null || mapping === false) {
      const propType = figmaProps[propName]?.type;
      if (propType === 'BOOLEAN' || propType === 'VARIANT') {
        CPROP_FAIL.push(`${comp}/${propName}: ${propType} property has no CSS implementation (null) — add a selector or use a CSS class`);
      }
      continue;
    }

    const pairs = typeof mapping === 'string'
      ? [['', mapping]]
      : Object.entries(mapping);

    for (const [state, selector] of pairs) {
      if (!selector) continue;
      const label = state ? `${comp}/${propName}=${state}` : `${comp}/${propName}`;
      const found = findBlock(allCss, selector, allIndex) !== null || allCss.includes(selector);
      if (found) CPROP_PASS.push(label);
      else CPROP_FAIL.push(`${label}: "${selector}" not found in CSS`);
    }
  }
}

// ── Gate [3g] — Annotation parity ────────────────────────────────────────────
// Every Figma annotation on a component set must be acknowledged in CONTRACT.annotations.
// Acknowledged annotations with a CSS selector are verified to exist in the codebase.
const CANN_PASS = [], CANN_FAIL = [], CANN_WARN = [];

for (const [figmaName, entry] of Object.entries(COMP_PROPS)) {
  if (figmaName === '_updated' || !entry?.annotations?.length) continue;
  const contractKey = figmaNameToContractKey[figmaName];
  if (!contractKey) {
    if (!KNOWN_UNIMPLEMENTED.has(figmaName)) {
      CANN_FAIL.push(`${figmaName}: has Figma annotations but no CONTRACT entry — add to CONTRACT or knownUnimplementedComponents`);
    }
    continue;
  }
  const contractAnns = CONTRACT[contractKey]?.annotations ?? {};
  for (const ann of entry.annotations) {
    const annLabel = ann.label ?? ann.name ?? String(ann);
    if (!(annLabel in contractAnns)) {
      CANN_FAIL.push(`${contractKey}: annotation "${annLabel}" not acknowledged in CONTRACT.annotations`);
      continue;
    }
    const mapping = contractAnns[annLabel];
    if (!mapping) { CANN_PASS.push(`${contractKey}/${annLabel} (prose — acknowledged)`); continue; }
    const label = `${contractKey}/${annLabel}`;
    if (typeof mapping === 'string') {
      // Simple selector existence check
      const found = findBlock(allCss, mapping, allIndex) !== null || allCss.includes(mapping);
      if (found) CANN_PASS.push(label);
      else CANN_FAIL.push(`${label}: "${mapping}" not found in CSS`);
    } else if (typeof mapping === 'object' && mapping.sel && mapping.prop) {
      // Property-level assertion: { sel, prop, expectedVar } or { sel, prop, expected }
      const block = findBlock(allCss, mapping.sel, allIndex);
      if (!block) { CANN_FAIL.push(`${label}: selector "${mapping.sel}" not found in CSS`); continue; }
      const propRe = new RegExp('(?<![a-zA-Z-])' + mapping.prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^;\\n]+)');
      const pm = block.match(propRe);
      const fullVal = pm ? pm[1].trim() : null;
      if (mapping.expectedVar) {
        const varPat = new RegExp(`var\\(${mapping.expectedVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,)]`);
        if (fullVal && varPat.test(fullVal)) CANN_PASS.push(label);
        else CANN_FAIL.push(`${label}: "${mapping.sel}" ${mapping.prop} uses "${fullVal ?? '(not set)'}" — expected var(${mapping.expectedVar}[,)])`);
      } else if (mapping.expected !== undefined) {
        if (fullVal === mapping.expected) CANN_PASS.push(label);
        else CANN_FAIL.push(`${label}: "${mapping.sel}" ${mapping.prop} is "${fullVal ?? '(not set)'}" — expected "${mapping.expected}"`);
      }
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n✅ PASS  ${PASS.length}/${Object.keys(CONTRACT).length} components (structure)`);
console.log(`❌ FAIL  ${FAIL.length} field(s)`);
if (MISSING.length) console.log(`❓ MISSING from snapshot: ${MISSING.join(', ')}`);
if (extra.length)   console.log(`🆕 In snapshot, not in contract: ${extra.join(', ')}`);

if (FAIL.length) {
  console.log('\n─── Structural drift ──────────────────────────────────────────');
  for (const f of FAIL)
    console.log(`  ❌ ${f.component}.${f.field}: contract=${JSON.stringify(f.expected)}  Figma=${JSON.stringify(f.got)}`);
}

if (themeCSS) {
  console.log(`\n✅ PASS  ${CSS_PASS.length}/${Object.keys(CSS_HEIGHT_RULES).length} CSS height rules`);
  console.log(`❌ FAIL  ${CSS_FAIL.length}`);
  if (CSS_FAIL.length) for (const f of CSS_FAIL) console.log(`  ❌ ${f}`);

  console.log(`\n✅ PASS  ${VAR_PASS.length}/${CSS_BASE_RULE_VARS.length} CSS base-rule var bindings`);
  console.log(`❌ FAIL  ${VAR_FAIL.length}`);
  if (VAR_FAIL.length) for (const f of VAR_FAIL) console.log(`  ❌ ${f}`);

  if (Object.keys(COMPONENT_CSS_SELECTORS).length) {
    const propTotal = PROP_PASS.length + PROP_FAIL.length;
    console.log(`\n✅ PASS  ${PROP_PASS.length}/${propTotal} CSS property bindings`);
    console.log(`❌ FAIL  ${PROP_FAIL.length}`);
    if (PROP_FAIL.length) {
      console.log('\n─── Wrong var in property binding (Figma-bound token, wrong CSS var in rule) ──');
      for (const f of PROP_FAIL) console.log(`  ❌ ${f}`);
    }
  }
} else {
  console.log('\n⚠️  theme CSS not found — height and base-rule var checks skipped');
}

if (STATE_SELECTORS.length) {
  const totalVarChecks = STATE_SELECTORS.reduce((n, e) => n + (e.vars?.length ?? 0), 0);
  console.log(`\n✅ PASS  ${SELECTOR_PASS.length}/${STATE_SELECTORS.length} state/variant selectors`);
  if (totalVarChecks) console.log(`   (${totalVarChecks} var binding(s) verified across all states)`);
  console.log(`❌ FAIL  ${SELECTOR_FAIL.length}`);
  if (SELECTOR_FAIL.length) {
    console.log('\n─── State selector failures ───────────────────────────────────');
    for (const f of SELECTOR_FAIL) {
      console.log(`  ❌ ${f.label}`);
      console.log(`       ${f.issue}${f.expected ? `  →  expected: ${f.expected}` : ''}`);
    }
  }
} else {
  console.log('\n⏭  STATE_SELECTORS empty in structure-contract.mjs — state/variant check skipped');
}

if (Object.keys(COMPONENT_CSS_SELECTORS).length) {
  if (BSIDES_PASS.length + BSIDES_FAIL.length > 0) {
    const bTotal = BSIDES_PASS.length + BSIDES_FAIL.length;
    console.log(`\n✅ PASS  ${BSIDES_PASS.length}/${bTotal} CSS border-sides checks`);
    console.log(`❌ FAIL  ${BSIDES_FAIL.length}`);
    if (BSIDES_FAIL.length) {
      console.log('\n─── Gate [3b] — wrong CSS border sides vs contract.strokeSides ──────');
      for (const f of BSIDES_FAIL) console.log(`  ❌ ${f}`);
      console.log('   Fix: match border-side CSS to contract.strokeSides (\'bottom\' → border-bottom; \'all\' → border).');
    }
  }

  console.log(`\n✅ PASS  ${PHANTOM_PASS.length} component(s) — no phantom CSS borders`);
  console.log(`❌ FAIL  ${PHANTOM_FAIL.length} phantom border(s)`);
  if (PHANTOM_FAIL.length) {
    console.log('\n─── Gate [3c] — CSS has border/outline but Figma has no stroke ──────');
    for (const f of PHANTOM_FAIL) console.log(`  ❌ ${f}`);
    console.log('   Fix: remove the border/outline from CSS, or add the stroke to Figma.');
    console.log('   Exemptions: add the selector string to ds-config.json → knownPhantomBorderExceptions');
  }

  const pillTotal = PILL_PASS.length + PILL_FAIL.length;
  if (pillTotal > 0) {
    console.log(`\n✅ PASS  ${PILL_PASS.length}/${pillTotal} hover/selected pill geometry checks`);
    console.log(`❌ FAIL  ${PILL_FAIL.length}`);
    if (PILL_FAIL.length) {
      console.log('\n─── Gate [3d] — ::before pill inset or border-radius wrong ──────────');
      for (const f of PILL_FAIL) console.log(`  ❌ ${f}`);
      console.log('   Fix: set inset to (outer_h − inner_h)/2 px; border-radius to the DS radius var.');
      console.log('   Contract: add hoverPill: { innerH, radiusVar, insetH } to structure-contract.mjs.');
    }
  }
}

if (CSS_PROPERTY_ASSERTIONS.length) {
  const aTotal = ASSERT_PASS.length + ASSERT_FAIL.length;
  console.log(`\n✅ PASS  ${ASSERT_PASS.length}/${aTotal} CSS property assertions`);
  console.log(`❌ FAIL  ${ASSERT_FAIL.length}`);
  if (ASSERT_FAIL.length) {
    console.log('\n─── Gate [3e] — CSS property assertion failed ───────────────────────');
    for (const f of ASSERT_FAIL) console.log(`  ❌ ${f}`);
    console.log('   Fix: update the CSS rule to match the assertion in CSS_PROPERTY_ASSERTIONS.');
  }
}

if (CHILD_PASS.length + CHILD_FAIL.length > 0) {
  const cTotal = CHILD_PASS.length + CHILD_FAIL.length;
  console.log(`\n✅ PASS  ${CHILD_PASS.length}/${cTotal} sub-frame layout checks`);
  console.log(`❌ FAIL  ${CHILD_FAIL.length}`);
  if (CHILD_FAIL.length) {
    console.log('\n─── Gate [3f] — sub-frame gap/padding mismatch ──────────────────────');
    for (const f of CHILD_FAIL) console.log(`  ❌ ${f}`);
    console.log('   Fix: update the child CSS selector to use the correct DS token var.');
  }
}

const hasCpropChecks = CPROP_PASS.length + CPROP_FAIL.length + CPROP_WARN.length > 0;
if (hasCpropChecks) {
  const cTotal = CPROP_PASS.length + CPROP_FAIL.length;
  console.log(`\n✅ PASS  ${CPROP_PASS.length}/${cTotal} component property implementations`);
  console.log(`❌ FAIL  ${CPROP_FAIL.length}`);
  if (CPROP_WARN.length) console.log(`⚠️  WARN  ${CPROP_WARN.length} (unmapped Figma properties)`);
  if (CPROP_FAIL.length) {
    console.log('\n─── Gate [3g] — component property has no CSS implementation ────────');
    for (const f of CPROP_FAIL) console.log(`  ❌ ${f}`);
    console.log('   Fix: implement a CSS selector/class for this behavior.');
    console.log('   null is only valid for TEXT/INSTANCE_SWAP/SLOT — BOOLEAN/VARIANT must have a selector.');
  }
  if (CPROP_WARN.length) {
    console.log('\n─── Gate [3g] — unmapped Figma component properties ─────────────────');
    for (const w of CPROP_WARN) console.log(`  ⚠️  ${w}`);
    console.log('   Add to propertyMap in structure-contract.mjs.');
  }
} else if (Object.keys(COMP_PROPS).length === 0 && Object.values(CONTRACT).some(c => c.propertyMap)) {
  console.log('\n⏭  Component props snapshot missing — run parity with FIGMA_TOKEN to populate Gate [3g]');
}

const hasCannChecks = CANN_PASS.length + CANN_FAIL.length > 0;
if (hasCannChecks) {
  const cannTotal = CANN_PASS.length + CANN_FAIL.length;
  console.log(`\n✅ PASS  ${CANN_PASS.length}/${cannTotal} Figma annotation acknowledgments`);
  console.log(`❌ FAIL  ${CANN_FAIL.length}`);
  if (CANN_FAIL.length) {
    console.log('\n─── Gate [3g] — unacknowledged Figma annotation ─────────────────────');
    for (const f of CANN_FAIL) console.log(`  ❌ ${f}`);
    console.log('   Fix: add CONTRACT.annotations[label] = \'css-selector\' | null (prose-only).');
  }
}

const anyFail = FAIL.length > 0 || MISSING.length > 0 || CSS_FAIL.length > 0
             || VAR_FAIL.length > 0 || SELECTOR_FAIL.length > 0 || PROP_FAIL.length > 0
             || PHANTOM_FAIL.length > 0 || PILL_FAIL.length > 0
             || BSIDES_FAIL.length > 0 || ASSERT_FAIL.length > 0 || CHILD_FAIL.length > 0
             || CPROP_FAIL.length > 0 || CANN_FAIL.length > 0;

if (!anyFail) { console.log('\nAll structural checks pass. ✓\n'); process.exit(0); }
else { console.log(''); process.exit(1); }
