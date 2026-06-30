// icon-slot-check.mjs — Gate [13]: Icon slot parity
// Run from project root: node ../rms-figma-code-parity/icon-slot-check.mjs
//
// For every entry in ICON_USAGES (structure-contract.mjs), locates the element
// by selector in the plugin's static HTML source and verifies the <use href>
// resolves to the expected DS icon symbol.
//
// Exit 0 = all icon slots match. Exit 1 = any mismatch.

import { readFileSync, existsSync } from 'fs';
import { join }                     from 'path';

const ROOT = process.cwd();

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

let ICON_USAGES = [];
try {
  const m = await import(join(ROOT, 'structure-contract.mjs'));
  if (m.ICON_USAGES && Array.isArray(m.ICON_USAGES)) ICON_USAGES = m.ICON_USAGES;
} catch { /* optional — skip if not present */ }

if (!ICON_USAGES.length) {
  console.log('⚠️  ICON_USAGES not found in structure-contract.mjs — skipping Gate [13]');
  process.exit(0);
}

// Map plugin name → source HTML path
const pluginToSrc = {};
const pluginCSS = cfg.paths?.pluginCSS ?? [];
const plugins   = cfg.paths?.plugins   ?? [];
for (let i = 0; i < plugins.length; i++) {
  if (pluginCSS[i]) pluginToSrc[plugins[i]] = pluginCSS[i];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Extract the element opening tag that matches the selector (id or class)
// then find the <use href> within the next 600 chars.
function findIconInSlot(html, selector) {
  let elemRe;
  if (selector.startsWith('#')) {
    const id = selector.slice(1);
    elemRe = new RegExp(`<[a-z]+[^>]*\\bid="${escapeRe(id)}"[^>]*>`, 'i');
  } else if (selector.startsWith('.')) {
    const cls = selector.slice(1);
    elemRe = new RegExp(`<[a-z]+[^>]*\\bclass="[^"]*\\b${escapeRe(cls)}\\b[^"]*"[^>]*>`, 'i');
  } else {
    return null;
  }

  const m = elemRe.exec(html);
  if (!m) return null;

  // Look in the next 600 chars for <use href="#icon-X">
  const window = html.slice(m.index, m.index + 600);
  const useM = /<use\s+href="#([^"]+)"/.exec(window);
  return useM ? useM[1] : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Run checks ────────────────────────────────────────────────────────────────
let pass = true;

for (const entry of ICON_USAGES) {
  const { plugin, selector, icon } = entry;
  const srcPath = pluginToSrc[plugin];
  if (!srcPath) {
    console.log(`⚠️  [13] ${plugin}: no source HTML in ds-config.json — skipping`);
    continue;
  }

  const absPath = join(ROOT, srcPath);
  if (!existsSync(absPath)) {
    console.log(`⚠️  [13] ${plugin} ${selector}: ${srcPath} not found — skipping`);
    continue;
  }

  const html  = readFileSync(absPath, 'utf8');
  const found = findIconInSlot(html, selector);

  if (found === null) {
    console.log(`❌ [13] ${plugin} ${selector}: element not found in HTML`);
    pass = false;
  } else if (found !== icon) {
    console.log(`❌ [13] ${plugin} ${selector}: icon is "${found}", expected "${icon}"`);
    pass = false;
  } else {
    console.log(`✅ [13] ${plugin} ${selector}: "${icon}" ✓`);
  }
}

// ── Exhaustiveness: every <button id="X"> with a direct icon child must be declared ──
// This catches slots that were added to the HTML but never registered in ICON_USAGES.
// Without exhaustiveness a developer can introduce a wrong icon in a new undeclared slot
// and Gate [13] will silently pass — it only verifies what's already in the contract.
const declaredByPlugin = {};
for (const e of ICON_USAGES) {
  (declaredByPlugin[e.plugin] ??= new Set()).add(e.selector);
}

for (const [plugin, srcPath] of Object.entries(pluginToSrc)) {
  const absPath = join(ROOT, srcPath);
  if (!existsSync(absPath)) continue;
  const html     = readFileSync(absPath, 'utf8');
  const declared = declaredByPlugin[plugin] ?? new Set();

  const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let bm;
  while ((bm = btnRe.exec(html)) !== null) {
    const btnAttrs = bm[1];
    const inner    = bm[2];
    const idM      = /\bid="([^"]+)"/.exec(btnAttrs);
    if (!idM) continue;
    const btnId = idM[1];
    if (/["'+${}]/.test(btnId)) continue; // skip JS-template IDs
    const useM = /<use\s+href="#(icon-[^"]+)"/.exec(inner);
    if (!useM) continue; // no direct icon child

    const sel = `#${btnId}`;
    if (!declared.has(sel)) {
      console.log(`❌ [13] ${plugin} ${sel}: undeclared icon slot — uses "${useM[1]}" but missing from ICON_USAGES`);
      pass = false;
    }
  }
}

process.exit(pass ? 0 : 1);
