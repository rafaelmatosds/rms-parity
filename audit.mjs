// audit.mjs — Single-command parity audit runner.
// Run from project root: node scripts/audit.mjs [--trend]
//
// --trend: print the last 20 audit runs and exit (no new run)
// --init:  run first-time setup (scaffold config files) and exit without auditing
//
// First run: if ds-config.json is missing, asks 3 questions (Figma URL, CSS path,
// token) then auto-detects collection structure via Figma API, scaffolds
// parity-map.mjs + structure-contract.mjs, and writes ds-config.json.
// Commit all three — they contain no secrets and are required for CI.
// Subsequent runs: config exists, audit starts immediately.
//
// Gates:
//   [1]  Freshness             — snapshot files updated today; compiled outputs match source
//   [2]  Parity check          — token values: color + sizing + typography
//   [3]  Structure check       — heights + CSS base-rule var bindings
//   [4]  Bound-token coverage  — every bound Figma token has a CSS var
//   [5]  CSS hygiene           — no orphaned CSS vars; no raw literals in rules
//   [6]  Sub-component isolation — no broad element selector overrides sub-component styles
//   [7]  Visual regression     — Figma frame screenshots match stored references
//   [8]  State coverage        — state completeness + selector binding + var placement
//   [9]  Exemption validity    — EXPLICIT/SKIP_TOKENS/COVERED entries not stale in snapshot
//   [10] Mode completeness     — all mode-variant tokens adapt across every configured mode
//   [11] CSS naming round-trip — every theme.css var traces back to a Figma token
//   [12] Contract coverage     — ::before/::after + <symbol> elements declared in contract
//
// Performance: gates 2–4, 6–12 (subprocess-based) run in parallel via Promise.all.
//              Gates 1 and 5 are computed inline (file stats + CSS scan).

import readline                                                  from 'readline';
import { spawn, spawnSync }                                      from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync,
         writeFileSync, copyFileSync }                           from 'fs';
import { join, dirname, resolve, relative }                     from 'path';
import { fileURLToPath }                                        from 'url';
import { buildReport }                                          from './report-html.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT       = process.cwd();

// Load .env from project root if present (no dotenv dependency)
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const today      = new Date().toISOString().slice(0, 10);
const WIDTH      = 60;
const SHOW_TREND = process.argv.includes('--trend');
const INIT_ONLY  = process.argv.includes('--init');

// Set to true when variables/local returns 403 (Figma Enterprise plan required).
// Gates that depend on live variable refresh use planLimited state instead of
// pass/fail — they don't block the audit but clearly explain what couldn't run.
let _figmaApiLimited = false;

// ── ANSI helpers (available before config loads) ──────────────────────────────
const isTTY = process.stdout.isTTY;
const C = {
  bold:   s => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
  green:  s => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:    s => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  dim:    s => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
};

// ── --trend: no config needed — just show history and exit ────────────────────
if (SHOW_TREND) {
  const histPath = join(ROOT, 'parity-history.json');
  try {
    const hist = JSON.parse(readFileSync(histPath, 'utf8'));
    console.log('\n' + C.bold('─── Parity Trend ───────────────────────────────────────────'));
    const recent = hist.slice(-20);
    for (const entry of recent) {
      const icon   = entry.fail === 0 ? C.green('✅') : C.red('❌');
      const filled = entry.pass ?? 0;
      const total  = entry.total ?? 8;
      const bar    = C.green('█'.repeat(filled)) + C.dim('░'.repeat(total - filled));
      console.log(`  ${icon}  ${entry.date}  ${String(filled).padStart(2)}/${total} [${bar}]`);
    }
    if (!hist.length) console.log('  No history yet — run: node scripts/audit.mjs');
    console.log(C.bold('─'.repeat(WIDTH)) + '\n');
  } catch {
    console.log('\n⏭  No history yet — run: node scripts/audit.mjs\n');
  }
  process.exit(0);
}

// ── Figma collection analyser ─────────────────────────────────────────────────
// Queries /variables/local, inspects every collection's variable types and naming
// patterns, and returns the best mapping for ds-config.json without user input.
async function analyseCollections(fileKey, token) {
  try {
    const res  = await fetch(`https://api.figma.com/v1/files/${fileKey}/variables/local`, {
      headers: { 'X-Figma-Token': token },
    });
    if (!res.ok) {
      console.log(C.yellow(`  ⚠️  Figma API ${res.status} — collection auto-detect skipped`));
      return null;
    }
    const { meta } = await res.json();
    const vars  = Object.values(meta?.variables         ?? {});
    const cols  = Object.values(meta?.variableCollections ?? {});
    if (!cols.length) return null;

    // Per-collection stats
    const stats = cols.map(col => {
      const colVars = vars.filter(v => v.variableCollectionId === col.id);
      const byType  = {};
      for (const v of colVars) byType[v.resolvedType] = (byType[v.resolvedType] ?? 0) + 1;

      // Detect common top-level path prefix (e.g. "primitives/", "Base/", "Color/")
      const names   = colVars.map(v => v.name);
      const prefix  = (() => {
        const segments = names.map(n => n.split('/')[0] + '/');
        const counts   = {};
        for (const s of segments) counts[s] = (counts[s] ?? 0) + 1;
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        return top && top[1] / names.length > 0.7 ? top[0] : null;
      })();

      return { name: col.name, total: colVars.length, byType, prefix, modeCount: col.modes.length };
    });

    console.log(C.dim(`\n  Figma collections detected (${stats.length}):`));
    for (const s of stats) {
      const types = Object.entries(s.byType).map(([t, n]) => `${n} ${t}`).join(', ');
      console.log(C.dim(`    • ${s.name}  [${types}]  ${s.modeCount} mode(s)${s.prefix ? `  prefix: ${s.prefix}` : ''}`));
    }

    // Classify: the collection with the most COLOR vars is the color collection.
    // If a collection looks like a raw primitive scale (single prefix, no multi-mode
    // semantic naming), it's a primitive scale — record its prefix.
    const sorted      = [...stats].sort((a, b) => (b.byType.COLOR ?? 0) - (a.byType.COLOR ?? 0));
    const colorCol    = sorted[0];

    // Sizing collection: most FLOAT vars, distinct from color collection
    const sizingCol   = stats
      .filter(s => s.name !== colorCol.name && (s.byType.FLOAT ?? 0) > 0)
      .sort((a, b) => (b.byType.FLOAT ?? 0) - (a.byType.FLOAT ?? 0))[0] ?? null;

    // Primitive prefix: look for a collection that has a dominant path prefix AND
    // whose variables are referenced as aliases by the color collection's variables.
    // Heuristic: single-mode collection with a dominant prefix → primitives.
    const primitiveCol = stats.find(s =>
      s.name !== colorCol.name &&
      s.modeCount === 1 &&
      s.prefix &&
      (s.byType.COLOR ?? 0) > 0
    ) ?? null;

    const primitivePrefix = primitiveCol
      ? primitiveCol.prefix
      : (colorCol.prefix ?? 'primitives/');

    console.log(C.dim(`\n  → Color collection:   "${colorCol.name}"`));
    if (sizingCol)    console.log(C.dim(`  → Sizing collection:  "${sizingCol.name}"`));
    if (primitiveCol) console.log(C.dim(`  → Primitive prefix:   "${primitivePrefix}" (from "${primitiveCol.name}")`));
    console.log('');

    return {
      colorCollection:  colorCol.name,
      sizingCollection: sizingCol?.name ?? null,
      primitivePrefix,
    };
  } catch (e) {
    console.log(C.yellow(`  ⚠️  Collection auto-detect failed (${e.message}) — using defaults`));
    return null;
  }
}

// ── Refresh component-property definitions from Figma REST API ───────────────
// Writes figma-component-props.snapshot.json. Called on every audit run when
// FIGMA_TOKEN is set. Queries /component_sets (names + nodeIds) then
// /nodes?ids=... (componentPropertyDefinitions). Safe to skip: gate [3g]
// falls back to reading an existing snapshot and warns if it's missing.
async function refreshComponentProps(fileKey, token, outPath) {
  try {
    const h = { 'X-Figma-Token': token };

    // ① Component SETS (variant groups) — the primary source
    const csRes = await fetch(`https://api.figma.com/v1/files/${fileKey}/component_sets`, { headers: h });
    if (!csRes.ok) {
      console.log(C.yellow(`  ⚠️  Figma ${csRes.status} — component props refresh skipped`));
      return false;
    }
    const { meta: csMeta } = await csRes.json();
    const sets  = Object.entries(csMeta?.component_sets ?? {});
    const ids   = sets.map(([id]) => id);
    const names = Object.fromEntries(sets.map(([id, s]) => [id, s.name]));

    // ② Standalone COMPONENTS (single components not in a variant set)
    const compRes = await fetch(`https://api.figma.com/v1/files/${fileKey}/components`, { headers: h });
    const { meta: compMeta } = compRes.ok ? await compRes.json() : { meta: {} };
    const standaloneEntries = Object.entries(compMeta?.components ?? {})
      .filter(([, c]) => !c.containing_frame?.containingStateGroup);
    for (const [nodeId, c] of standaloneEntries) {
      if (!names[nodeId]) { ids.push(nodeId); names[nodeId] = c.name; }
    }

    // ③ Fallback: for unpublished files (API returns nothing), refresh known nodeIds
    //    from the existing snapshot so annotations always stay current.
    let existingSnap = {};
    try { existingSnap = JSON.parse(readFileSync(outPath, 'utf8')); } catch {}
    for (const [name, entry] of Object.entries(existingSnap)) {
      if (name === '_updated' || !entry?.nodeId) continue;
      if (!names[entry.nodeId]) { ids.push(entry.nodeId); names[entry.nodeId] = name; }
    }

    if (!ids.length) return false;
    const result = {};

    const BATCH = 50;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const nRes  = await fetch(
        `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${batch.join(',')}`,
        { headers: h }
      );
      if (!nRes.ok) continue;
      const { nodes } = await nRes.json();
      for (const [nodeId, data] of Object.entries(nodes ?? {})) {
        const doc   = data?.document;
        const props = doc?.componentPropertyDefinitions ?? {};
        const anns  = doc?.annotations ?? [];
        if (Object.keys(props).length || anns.length) {
          result[names[nodeId] ?? doc?.name ?? nodeId] = { nodeId, properties: props, annotations: anns };
        }
      }
    }

    result._updated = new Date().toISOString();
    writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
    console.log(C.dim(`  ✅ Component props: ${Object.keys(result).length - 1} component(s)`));
    return true;
  } catch (e) {
    console.log(C.yellow(`  ⚠️  Component props refresh failed: ${e.message}`));
    return false;
  }
}

// ── Auto-refresh bound-tokens.json + component-state-tokens.json via REST API ─
// Replaces the manual Phase 2 Plugin API walk. Called on every audit run when
// FIGMA_TOKEN + frames are configured. Writes the same format consumed by
// bound-check.mjs and state-check.mjs: { "Token/Path": true, ... }.

function collectBound(node, idToName, tokenSet) {
  for (const ref of Object.values(node?.boundVariables ?? {})) {
    const refs = Array.isArray(ref) ? ref : [ref];
    for (const r of refs) if (r?.id && idToName[r.id]) tokenSet.add(idToName[r.id]);
  }
  for (const child of node?.children ?? []) collectBound(child, idToName, tokenSet);
}

async function buildVarIdMap(fileKey, token) {
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/variables/local`, {
    headers: { 'X-Figma-Token': token },
  });
  if (!res.ok) {
    if (res.status === 403) _figmaApiLimited = true;
    throw new Error(`variables/local returned ${res.status}`);
  }
  const { meta } = await res.json();
  const idToName = {};
  for (const [id, v] of Object.entries(meta?.variables ?? {})) idToName[id] = v.name;
  return idToName;
}

async function refreshBoundTokens(fileKey, frames, token, outPath) {
  if (!frames?.length) return false;
  try {
    const idToName = await buildVarIdMap(fileKey, token);
    const tokenSet = new Set();
    for (const frame of frames) {
      const nRes = await fetch(
        `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${frame.nodeId}`,
        { headers: { 'X-Figma-Token': token } },
      );
      if (!nRes.ok) { console.log(C.yellow(`  ⚠️  /nodes ${frame.nodeId} → ${nRes.status}`)); continue; }
      const { nodes } = await nRes.json();
      for (const data of Object.values(nodes ?? {})) collectBound(data?.document, idToName, tokenSet);
    }
    const result = Object.fromEntries([...tokenSet].map(t => [t, true]));
    writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
    console.log(C.dim(`  ✅ Bound tokens: ${tokenSet.size} token(s) across ${frames.length} frame(s)`));
    return true;
  } catch (e) {
    console.log(C.yellow(`  ⚠️  Bound tokens refresh failed: ${e.message}`));
    return false;
  }
}

async function refreshStateTokens(fileKey, token, outPath) {
  try {
    const idToName = await buildVarIdMap(fileKey, token);
    const csRes = await fetch(`https://api.figma.com/v1/files/${fileKey}/component_sets`, {
      headers: { 'X-Figma-Token': token },
    });
    if (!csRes.ok) { console.log(C.yellow(`  ⚠️  /component_sets → ${csRes.status}`)); return false; }
    const { meta: csMeta } = await csRes.json();
    const setIds = Object.keys(csMeta?.component_sets ?? {});
    if (!setIds.length) return false;
    const tokenSet = new Set();
    const BATCH = 50;
    for (let i = 0; i < setIds.length; i += BATCH) {
      const batch = setIds.slice(i, i + BATCH);
      const nRes = await fetch(
        `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${batch.join(',')}`,
        { headers: { 'X-Figma-Token': token } },
      );
      if (!nRes.ok) continue;
      const { nodes } = await nRes.json();
      for (const data of Object.values(nodes ?? {})) collectBound(data?.document, idToName, tokenSet);
    }
    const result = Object.fromEntries([...tokenSet].map(t => [t, true]));
    writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
    console.log(C.dim(`  ✅ State tokens: ${tokenSet.size} token(s) across ${setIds.length} set(s)`));
    return true;
  } catch (e) {
    console.log(C.yellow(`  ⚠️  State tokens refresh failed: ${e.message}`));
    return false;
  }
}

// ── Bootstrap: generate ds-config.json from 3 questions ──────────────────────
// Called when ds-config.json is missing (or --init flag). Auto-detects CSS paths,
// plugin files, snapshot locations, and Figma collection structure via API.
async function bootstrapConfig() {
  console.log('\n' + C.bold('rms-parity — first-time setup'));
  console.log(C.dim('─'.repeat(WIDTH)));

  // Auto-detect token CSS
  const candidates = [];
  const CSS_EXTS = ['.css', '.scss', '.sass', '.less'];
  function looksLikeTokenFile(absPath) {
    try { const t = readFileSync(absPath, 'utf8'); return t.includes(':root') && t.includes('--'); }
    catch { return false; }
  }
  const scanRoots = ['packages', 'src', 'app', 'styles', 'assets', 'tokens'];
  for (const base of scanRoots) {
    const baseDir = join(ROOT, base);
    if (!existsSync(baseDir)) continue;
    try {
      for (const f of readdirSync(baseDir)) {
        const dot = f.lastIndexOf('.');
        if (dot !== -1 && CSS_EXTS.includes(f.slice(dot))) {
          const rel = join(base, f);
          if (looksLikeTokenFile(join(ROOT, rel))) candidates.push(rel);
        }
      }
      for (const sub of readdirSync(baseDir)) {
        const subDir = join(baseDir, sub);
        if (!statSync(subDir).isDirectory()) continue;
        for (const entry of ['styles', 'src', '']) {
          const dir = entry ? join(subDir, entry) : subDir;
          if (!existsSync(dir)) continue;
          try {
            for (const f of readdirSync(dir)) {
              const dot = f.lastIndexOf('.');
              if (dot !== -1 && CSS_EXTS.includes(f.slice(dot))) {
                const rel = join(base, sub, entry, f).replace(/[\\/]+/g, '/').replace(/\/$/, '');
                if (looksLikeTokenFile(join(ROOT, rel))) candidates.push(rel);
              }
            }
          } catch {}
        }
      }
    } catch {}
  }
  for (const f of readdirSync(ROOT)) {
    const dot = f.lastIndexOf('.');
    if (dot !== -1 && CSS_EXTS.includes(f.slice(dot)) && looksLikeTokenFile(join(ROOT, f)))
      candidates.push(f);
  }
  const unique = [...new Set(candidates)];
  const detectedCSS = unique.length === 1 ? unique[0] : null;
  if (unique.length) console.log(C.dim(`  Found token CSS file(s): ${unique.join(', ')}`));

  // Auto-detect plugin CSS
  const pluginCSS = [], plugins = [];
  const appsDir = join(ROOT, 'apps');
  if (existsSync(appsDir)) {
    try {
      for (const p of readdirSync(appsDir).sort()) {
        const uiSrc = join('apps', p, 'ui.src.html');
        if (existsSync(join(ROOT, uiSrc))) { pluginCSS.push(uiSrc); plugins.push(p); }
      }
    } catch {}
  }
  if (!pluginCSS.length && existsSync(join(ROOT, 'src', 'ui.src.html')))
    pluginCSS.push('src/ui.src.html');
  if (pluginCSS.length) {
    const names = plugins.length ? plugins.slice(0, 3).join(', ') + (plugins.length > 3 ? '…' : '') : pluginCSS.join(', ');
    console.log(C.dim(`  Found ${pluginCSS.length} plugin CSS file(s): ${names}`));
  }
  console.log('');

  // ── 3 questions ───────────────────────────────────────────────────────────────
  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, res));

  // Q1 — Figma file URL
  const figmaRaw     = (await ask('Figma file URL: ')).trim();
  const figmaFileKey = (() => {
    const m = figmaRaw.match(/figma\.com\/(?:design|file)\/([a-zA-Z0-9]+)/);
    return m ? m[1] : figmaRaw;
  })();

  // Q2 — Token CSS path(s)
  let themeCSS;
  const defaultHint = detectedCSS ?? (unique.length > 1 ? unique.join(', ') : null);
  if (defaultHint) {
    const ans  = (await ask(`Token CSS file(s) [${defaultHint}]: `)).trim();
    const parts = (ans || defaultHint).split(',').map(s => s.trim()).filter(Boolean);
    themeCSS = parts.length === 1 ? parts[0] : parts;
  } else {
    const ans  = (await ask('Token CSS file(s) (e.g. src/styles/theme.css): ')).trim();
    const parts = ans.split(',').map(s => s.trim()).filter(Boolean);
    themeCSS = parts.length === 1 ? (parts[0] || 'src/theme.css') : parts;
  }

  // Q3 — FIGMA_TOKEN (needed for collection auto-detect + Gate 9)
  const existingToken = process.env.FIGMA_TOKEN ?? '';
  let figmaToken = existingToken;
  if (!existingToken) {
    const tok = (await ask('Figma personal access token (leave blank to skip): ')).trim();
    figmaToken = tok;
  } else {
    console.log(C.dim('  FIGMA_TOKEN already set in .env — using it for collection detection'));
  }

  // Q3b — Consumer file?
  let figmaSourceKey = '';
  const isConsumer = (await ask('Is this a Figma consumer file that uses an external DS library? (y/N): ')).trim().toLowerCase();
  if (isConsumer === 'y' || isConsumer === 'yes') {
    const srcUrl = (await ask('DS source Figma URL: ')).trim();
    if (srcUrl) {
      const m = srcUrl.match(/figma\.com\/(?:design|file)\/([a-zA-Z0-9]+)/);
      figmaSourceKey = m ? m[1] : srcUrl;
    }
  }

  rl.close();
  console.log('');

  // ── Auto-detect Figma collections ─────────────────────────────────────────────
  let figmaCfg = { colorCollection: 'Color', sizingCollection: null, primitivePrefix: 'primitives/' };
  if (figmaFileKey && figmaToken) {
    console.log(C.dim('  Querying Figma for collection structure…'));
    const detected = await analyseCollections(figmaFileKey, figmaToken);
    if (detected) figmaCfg = { ...figmaCfg, ...detected };
  } else if (figmaFileKey && !figmaToken) {
    console.log(C.yellow('  ⚠️  No FIGMA_TOKEN — collection names defaulted to "Color" / null. Edit ds-config.json if needed.'));
  }

  // ── Write config ──────────────────────────────────────────────────────────────
  const firstTheme        = [themeCSS].flat()[0];
  const cssDir            = dirname(firstTheme);
  const snapshotVars      = join(cssDir, 'figma-vars.snapshot.json').replace(/\\/g, '/');
  const snapshotStructure = join(cssDir, 'figma-structure.snapshot.json').replace(/\\/g, '/');

  const generated = {
    figmaFileKey:  figmaFileKey || '',
    ...(figmaSourceKey ? { figmaSourceKey } : {}),
    frames: [],
    figma: {
      ...figmaCfg,
      modes: [
        { name: 'Light', snapshotKey: 'light', cssSelector: 'root' },
        { name: 'Dark',  snapshotKey: 'dark',  cssSelector: 'dark-media' },
      ],
    },
    paths: { themeCSS, snapshotVars, snapshotStructure, pluginCSS, plugins },
    visualRefs: '.parity-refs',
    webhook: { port: 3456, secret: 'YOUR_WEBHOOK_SECRET' },
    knownUnusedVars: [],
    knownHardcodedExceptions: [],
  };

  writeFileSync(join(ROOT, 'ds-config.json'), JSON.stringify(generated, null, 2) + '\n');
  console.log(C.green('✅ ds-config.json written'));

  // ── Save FIGMA_TOKEN to .env ──────────────────────────────────────────────────
  if (figmaToken && !existingToken) {
    const envContent = existsSync(join(ROOT, '.env')) ? readFileSync(join(ROOT, '.env'), 'utf8') : '';
    if (!envContent.includes('FIGMA_TOKEN')) {
      writeFileSync(join(ROOT, '.env'), envContent + (envContent.endsWith('\n') ? '' : '\n') + `FIGMA_TOKEN=${figmaToken}\n`);
      console.log(C.green('✅ FIGMA_TOKEN saved to .env'));
    }
  }

  // ── Scaffold parity-map.mjs and structure-contract.mjs ───────────────────────
  for (const [example, target] of [
    ['parity-map.example.mjs',          'parity-map.mjs'],
    ['structure-contract.example.mjs',  'structure-contract.mjs'],
  ]) {
    const src  = join(SCRIPT_DIR, example);
    const dest = join(ROOT, target);
    if (!existsSync(dest) && existsSync(src)) {
      copyFileSync(src, dest);
      console.log(C.green(`✅ ${target} scaffolded from example — fill in your DS values`));
    }
  }

  // ── Update .gitignore ─────────────────────────────────────────────────────────
  const giPath    = join(ROOT, '.gitignore');
  const giContent = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  // Only gitignore secrets and auto-generated transients.
  // ds-config.json, parity-map.mjs, structure-contract.mjs contain no secrets —
  // commit them so CI can run parity without interactive setup.
  const toAdd     = ['.env', 'bound-tokens.json', 'component-state-tokens.json', 'parity-check-result.json']
    .filter(e => !giContent.split('\n').some(l => l.trim() === e));
  if (toAdd.length) {
    const block = '\n# rms-parity: secrets + auto-generated transients — do not commit\n' + toAdd.join('\n') + '\n';
    writeFileSync(giPath, giContent + (giContent.endsWith('\n') ? '' : '\n') + block);
    console.log(C.green('✅ .gitignore updated'));
  }

  // ── Next-steps checklist ──────────────────────────────────────────────────────
  console.log('\n' + C.bold('─── Next steps ─────────────────────────────────────────────'));
  console.log(`  1. ${C.bold('ds-config.json')} — add frame node IDs (from the Figma frame URL)`);
  console.log(`       "frames": [{ "name": "My Screen", "nodeId": "123-456" }]`);
  if (!figmaToken) {
    console.log(`  2. ${C.bold('.env')} — add your Figma token for Gate [9] visual regression:`);
    console.log(`       FIGMA_TOKEN=your_token_here`);
  }
  console.log(`  3. ${C.bold('parity-map.mjs')} — fill in primitive scale (NEUTRAL_LIGHT/DARK)`);
  console.log(`       and any token→var exceptions (EXPLICIT, SKIP_TOKENS)`);
  console.log(`  4. ${C.bold('structure-contract.mjs')} — add component height/padding contracts`);
  console.log(`       (only needed for Gates [3] and [8])`);
  console.log(`  5. Run ${C.bold('/rms-parity')} Phase 1 to capture the live Figma snapshot`);
  console.log('─'.repeat(WIDTH) + '\n');

  return generated;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  // ── Load or generate config ─────────────────────────────────────────────────
  let cfg = {};
  if (INIT_ONLY) {
    await bootstrapConfig();
    process.exit(0);
  }
  try {
    cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8'));
  } catch {
    if (process.env.CI) {
      console.error('❌ ds-config.json not found. In CI, commit ds-config.json to the repository (it contains no secrets — only paths and the public Figma file key).');
      process.exit(1);
    }
    cfg = await bootstrapConfig();
  }

  // THEMES: always an array — supports single string or array of paths
  const THEMES      = [cfg.paths?.themeCSS ?? 'src/theme.css'].flat();
  const THEME       = THEMES[0]; // primary path (for snapshot derivation, Gate 7)
  const THEME_LABEL = THEMES.length === 1 ? THEMES[0] : `[${THEMES.map(p => p.split('/').pop()).join(', ')}]`;
  function readThemeCSS() {
    return THEMES.filter(p => existsSync(join(ROOT, p)))
      .map(p => readFileSync(join(ROOT, p), 'utf8')).join('\n');
  }
  const SNAP_VARS        = cfg.paths?.snapshotVars       ?? 'src/figma-vars.snapshot.json';
  const SNAP_STRUCT      = cfg.paths?.snapshotStructure  ?? 'src/figma-structure.snapshot.json';
  const SNAP_COMP_PROPS  = cfg.paths?.compPropsSnapshot  ??
    SNAP_VARS.replace(/[^/\\]+$/, 'figma-component-props.snapshot.json');
  const PLUGIN_CSS  = cfg.paths?.pluginCSS          ?? [];
  const PLUGINS     = cfg.paths?.plugins            ?? [];
  const KNOWN_UNUSED     = new Set(cfg.knownUnusedVars         ?? []);
  const KNOWN_FS_EXCEPTS = cfg.knownHardcodedExceptions        ?? cfg.knownFontSizeExceptions ?? [];

  // Directories and files to never scan for var() references or hardcoded values.
  const SCAN_EXCLUDE_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.nuxt', '.next', '.output',
    'coverage', '.cache', 'public', 'static',
    ...(cfg.scanExcludeDirs ?? []),
  ]);
  // Only scan files that can realistically contain CSS var() references.
  const SCAN_EXTENSIONS = new Set([
    '.css', '.scss', '.sass', '.less', '.styl',
    '.vue', '.svelte',
    '.html', '.htm',
    '.jsx', '.tsx', '.js', '.ts',
  ]);
  // Files whose content is auto-generated and should not be treated as source.
  const SCAN_EXCLUDE_FILENAMES = new Set([
    'figma-vars.snapshot.json', 'figma-structure.snapshot.json',
    'figma-component-props.snapshot.json',
    'bound-tokens.json', 'component-state-tokens.json', 'parity-history.json', 'master-token-table.md',
    ...(cfg.scanExcludeFilenames ?? []),
  ]);

  function collectSourceFiles(dir = ROOT, results = []) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return results; }
    for (const e of entries) {
      if (SCAN_EXCLUDE_DIRS.has(e.name)) continue;
      if (e.isDirectory()) {
        collectSourceFiles(join(dir, e.name), results);
      } else if (e.isFile()) {
        if (SCAN_EXCLUDE_FILENAMES.has(e.name)) continue;
        const dot = e.name.lastIndexOf('.');
        if (dot !== -1 && SCAN_EXTENSIONS.has(e.name.slice(dot))) {
          results.push(join(dir, e.name));
        }
      }
    }
    return results;
  }

  // Lazily collected once and reused across gates.
  let _allSourceFiles = null;
  function allSourceFiles() {
    if (!_allSourceFiles) _allSourceFiles = collectSourceFiles();
    return _allSourceFiles;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function sh(cmd, args = [], opts = {}) {
    return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  }

  function runScriptAsync(scriptPath, args = []) {
    return new Promise(res => {
      const abs = resolve(SCRIPT_DIR, scriptPath);
      if (!existsSync(abs)) return res({ status: null, stdout: '', stderr: '' });
      const child = spawn('node', [abs, ...args], { cwd: ROOT, env: process.env });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', status => res({ status, stdout, stderr }));
    });
  }

  function snapshotAge(file) {
    try {
      const snap = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
      if (!snap._updated) return null;
      return Math.floor((Date.now() - new Date(snap._updated).getTime()) / 3_600_000);
    } catch { return null; }
  }

  // ── Gate parsers (subprocess-based gates) ────────────────────────────────────
  function parseGate2(r) {
    if (r.status === null) return { pass: false, lines: [C.red('parity-check.mjs not found')] };
    const out  = r.stdout + r.stderr;
    const pass = r.status === 0;
    const summary    = out.split('\n').filter(l => /✅|❌|⚠️/.test(l) && l.trim()).map(l => l.trim());
    const failDetails = pass ? [] : out.split('\n')
      .filter(l => l.trim().startsWith('❌') || l.trim().startsWith('Fix:'))
      .map(l => '  ' + l.trim()).slice(0, 30);
    return { pass, lines: [...summary, ...failDetails] };
  }

  function parseGate3(r) {
    if (r.status === null) return { pass: true, lines: ['⏭ structure-check.mjs not found — skipped'] };
    const out  = r.stdout + r.stderr;
    const pass = r.status === 0;
    const summary    = out.split('\n').filter(l => /✅|❌/.test(l) && l.trim()).map(l => l.trim());
    const failDetails = pass ? [] : out.split('\n')
      .filter(l => l.trim().startsWith('❌') && !l.includes('FAIL  0'))
      .map(l => '  ' + l.trim()).slice(0, 20);
    return { pass, lines: [...summary, ...failDetails] };
  }

  function parseGate4(r) {
    if (r.status === null) return { pass: true, lines: ['⏭ bound-check.mjs not found — skipped'] };
    const out = r.stdout + r.stderr;
    if (r.status === 2) {
      // bound-tokens.json is missing entirely — always a hard fail regardless of plan
      return {
        pass: false,
        lines: [
          C.red('❌ HARD FAIL — bound-tokens.json missing.'),
          _figmaApiLimited
            ? C.red('   Variables REST API requires Enterprise plan — generate via Plugin API and commit.')
            : C.red('   Set FIGMA_TOKEN and ensure ds-config.json has frames[] to auto-generate it.'),
        ],
      };
    }
    if (_figmaApiLimited) {
      // bound-tokens.json exists (committed) but wasn't refreshed — coverage check ran against committed snapshot
      const pass       = r.status === 0;
      const summary    = out.split('\n').filter(l => /COVERED|UNCOVERED/.test(l) && l.trim()).map(l => l.trim());
      const failDetails = pass ? [] : out.split('\n').filter(l => l.trim().startsWith('❌')).map(l => '  ' + l.trim()).slice(0, 20);
      if (!pass) {
        // Real coverage failures even against committed snapshot are still failures
        return { pass: false, lines: [...summary, ...failDetails] };
      }
      return {
        pass: true,
        planLimited: true,
        lines: [
          C.yellow('⚠️  Variables REST API requires Enterprise plan — bound-tokens.json not refreshed'),
          C.yellow('   Coverage checked against committed snapshot (may be stale if frames changed)'),
          ...summary,
        ],
      };
    }
    const pass       = r.status === 0;
    const summary    = out.split('\n').filter(l => /COVERED|UNCOVERED/.test(l) && l.trim()).map(l => l.trim());
    const failDetails = pass ? [] : out.split('\n').filter(l => l.trim().startsWith('❌')).map(l => '  ' + l.trim()).slice(0, 20);
    return { pass, lines: [...summary, ...failDetails] };
  }

  function parseGate8(r) {
    if (r.status === null) return { pass: true, lines: ['⏭ subcomponent-isolation-check.mjs not found — skipped'] };
    const out  = r.stdout + r.stderr;
    const pass = r.status === 0;
    const summary    = out.split('\n')
      .filter(l => /✅ DOCUMENTED|✅ No new|❌ UNDOCUMENTED/.test(l) && l.trim())
      .map(l => l.trim());
    const failDetails = pass ? [] : out.split('\n')
      .filter(l => l.trim().startsWith('❌') && !l.includes('UNDOCUMENTED'))
      .map(l => '  ' + l.trim()).slice(0, 20);
    return { pass, lines: [...summary, ...failDetails] };
  }

  function parseGate9(r) {
    if (r.status === null) return { pass: true, lines: ['⏭ visual-regression-check.mjs not found — skipped'] };
    const out = r.stdout + r.stderr;
    if (r.status === 0 && out.includes('No frames')) {
      const msg = out.split('\n').find(l => l.trim()) ?? 'Skipped';
      return { pass: true, lines: [`⏭ ${msg.trim()}`] };
    }
    const pass     = r.status === 0;
    const summary  = out.split('\n').filter(l => /✅|❌|📸/.test(l) && l.trim()).map(l => l.trim()).slice(0, 6);
    const fixLines = pass ? [] : out.split('\n')
      .filter(l => l.trim().startsWith('mv ') || l.includes('.new.png'))
      .map(l => '  ' + l.trim()).slice(0, 6);
    return { pass, lines: [...summary, ...fixLines] };
  }

  function combineGates(...results) {
    const allPass = results.every(r => r.pass || r.planLimited);
    const anyPlanLimited = results.some(r => r.planLimited);
    return {
      pass: results.every(r => r.pass),
      planLimited: allPass && anyPlanLimited,
      lines: results.flatMap(r => r.lines),
    };
  }

  // Generic parser for subprocess gates: pass/fail from exit code, summary from keyword lines
  function parseGeneric(r, summaryRe) {
    if (r.status === null) return { pass: true, lines: ['⏭ script not found — skipped'] };
    const out  = r.stdout + r.stderr;
    const pass = r.status === 0;
    const summary = out.split('\n')
      .filter(l => summaryRe.test(l) && l.trim()).map(l => l.trim());
    const failDetails = pass ? [] : out.split('\n')
      .filter(l => /🚨|❌/.test(l) && l.trim()).map(l => '  ' + l.trim()).slice(0, 20);
    return { pass, lines: [...summary, ...failDetails] };
  }

  // ── Inline gate computations (no subprocess) ─────────────────────────────────
  function computeGate1() {
    const vars   = snapshotAge(SNAP_VARS);
    const struct = snapshotAge(SNAP_STRUCT);
    const lines  = [];
    let warn     = false;

    if (vars === null) {
      lines.push(C.red(`${SNAP_VARS} missing — run /rms-parity Phase 1`)); warn = true;
    } else if (vars > 24) {
      lines.push(C.yellow(`⚠️  ${SNAP_VARS} is ${vars}h old${_figmaApiLimited ? ' (Variables REST API not available on this plan)' : ''}`));
      warn = true;
    } else {
      lines.push(`${SNAP_VARS} ✓ (updated today)`);
    }

    let structPlanLimited = false;
    if (struct === null) {
      lines.push(C.red(`${SNAP_STRUCT} missing — run /rms-parity Phase 1`)); warn = true;
    } else if (struct > 24) {
      if (_figmaApiLimited) {
        lines.push(C.yellow(`⚠️  ${SNAP_STRUCT} is ${struct}h old — not refreshed (Variables REST API requires Enterprise plan)`));
        structPlanLimited = true;
      } else {
        lines.push(C.yellow(`⚠️  ${SNAP_STRUCT} is ${struct}h old`));
        warn = true;
      }
    } else {
      lines.push(`${SNAP_STRUCT} ✓ (updated today)`);
    }

    return { pass: !warn && !structPlanLimited, planLimited: !warn && structPlanLimited, lines };
  }

  function computeGate5() {
    const existing = THEMES.filter(p => existsSync(join(ROOT, p)));
    if (!existing.length) {
      return { pass: false, lines: [C.red(`token CSS not found at ${THEME_LABEL}`)] };
    }
    const themeText = readThemeCSS();
    const declared  = [...new Set(
      [...themeText.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)\s*:/g)].map(m => '--' + m[1])
    )];
    const allSrc = allSourceFiles().map(f => {
      try { return readFileSync(f, 'utf8'); } catch { return ''; }
    }).join('\n');
    const unused = declared.filter(v => !KNOWN_UNUSED.has(v) && !allSrc.includes(`var(${v})`));
    const pass   = unused.length === 0;
    const scanned = allSourceFiles().length;
    return {
      pass,
      lines: pass
        ? [`✅ 0 unused vars  (scanned ${scanned} files; ${KNOWN_UNUSED.size} known-unused exempted)`]
        : [`❌ ${unused.length} unused (scanned ${scanned} files): ${unused.join(', ')}`],
    };
  }

  function computeGate6() {
    // Scan all source files for hardcoded literal values in CSS rules — property-agnostic.
    // Any numeric (px/rem/em/vh/vw/%) or hex value outside a :root/var declaration is a violation.
    // Use var() for every DS-token-backed value. Document intentional layout math
    // (100%, 50%, positioning zeros) in ds-config.json → knownHardcodedExceptions
    // as { file, pattern } objects or plain substring strings.
    // gate6ExcludeDirs allows scoping Gate [6] to DS package files only, excluding app consumers.
    const g6ExcludeDirs = new Set(cfg.gate6ExcludeDirs ?? []);
    const scanTargets = g6ExcludeDirs.size > 0
      ? allSourceFiles().filter(f => {
          const rel = relative(ROOT, f).replace(/\\/g, '/');
          return !rel.split('/').some(seg => g6ExcludeDirs.has(seg));
        })
      : allSourceFiles();
    const scanArgs    = ['-n', '-E'];

    // Shared legitimacy filter
    function isLegitimate(line) {
      const codePart = line.replace(/^[^:]+:\d+:\s*/, '');
      // CSS variable declarations (--name: value) — catches inline `:root { --var: #hex; }` too
      if (/--[a-zA-Z][\w-]*\s*:/.test(codePart)) return true;
      // Single-line JS/CSS comments
      if (/^\s*\/\//.test(codePart)) return true;
      // JSDoc / block-comment continuation lines (` * blah`)
      if (/^\s*\*/.test(codePart)) return true;
      const stripped = codePart.replace(/\/\*[^*]*\*\//g, '');
      // Value wrapped in quotes/backticks → JS/Vue string, not a real CSS rule
      if (/[`"'][^`"']*:\s*[^`"']*[`"']/.test(codePart)) return true;
      // Standalone quoted hex string (fallback `|| '#hex'` or canvas `fillStyle = "#hex"`)
      if (/[`"']#[0-9a-fA-F]{3,8}[`"']/.test(codePart)) return true;
      // HTML inline style attribute — value is in HTML, not a CSS rule
      if (/\bstyle\s*=\s*["'`{]/.test(codePart)) return true;
      // JS innerHTML / insertAdjacentHTML / template literal building HTML
      if (/innerHTML\s*[+=]|insertAdjacentHTML/.test(codePart)) return true;
      // Known exceptions from ds-config.json
      if (KNOWN_FS_EXCEPTS.some(e => {
        if (typeof e === 'string') return line.includes(e);
        return (!e.file || line.includes(e.file)) &&
               (!e.pattern || new RegExp(e.pattern).test(stripped));
      })) return true;
      return false;
    }

    // Pass 1 — hex colors (any property, any file)
    const hexR    = sh('grep', [...scanArgs, '#[0-9a-fA-F]{3,8}\\b', ...scanTargets]);
    const hexHits = (hexR.stdout || '').split('\n').filter(l => {
      if (!l.trim() || isLegitimate(l)) return false;
      const code = l.replace(/^[^:]+:\d+:\s*/, '').replace(/\/\*[^*]*\*\//g, '');
      return /#[0-9a-fA-F]{3,8}\b/.test(code);
    });

    // Pass 2 — numeric literals with units (all properties: padding, radius, height, gap, etc.)
    const numR    = sh('grep', [...scanArgs,
      ':\\s*-?[0-9]+(\\.[0-9]+)?(px|rem|em|%|vh|vw|vmin|vmax|ch|ex)\\b',
      ...scanTargets,
    ]);
    const numHits = (numR.stdout || '').split('\n').filter(l => {
      if (!l.trim() || isLegitimate(l)) return false;
      const code = l.replace(/^[^:]+:\d+:\s*/, '').replace(/\/\*[^*]*\*\//g, '');
      return /:\s*-?[0-9]+(\.[0-9]+)?(px|rem|em|%|vh|vw|vmin|vmax|ch|ex)\b/.test(code);
    });

    // Pass 3 — layout anti-patterns across ALL files (gate6ExcludeDirs does NOT apply here).
    // These viewport-unit rules cause scrollbar clipping and must never appear in any file.
    const allFiles = allSourceFiles();
    const vwR = sh('grep', ['-n', '-E', ':\\s*100vw\\b|calc\\([^)]*100vw', ...allFiles]);
    const vwHits = (vwR.stdout || '').split('\n').filter(l => {
      if (!l.trim()) return false;
      const code = l.replace(/^[^:]+:\d+:\s*/, '');
      // Allow inside comments or var declarations
      if (/--[a-zA-Z][\w-]*\s*:/.test(code)) return false;
      if (/^\s*(\/\/|\*)/.test(code)) return false;
      if (/[`"'][^`"']*:\s*[^`"']*[`"']/.test(code)) return false;
      if (/innerHTML\s*[+=]|insertAdjacentHTML/.test(code)) return false;
      if (KNOWN_FS_EXCEPTS.some(e => {
        if (typeof e === 'string') return l.includes(e);
        const stripped = code.replace(/\/\*[^*]*\*\//g, '');
        return (!e.file || l.includes(e.file)) && (!e.pattern || new RegExp(e.pattern).test(stripped));
      })) return false;
      return true;
    });

    const hits = [...new Set([...hexHits, ...numHits, ...vwHits])];
    const pass  = hits.length === 0;
    return {
      pass,
      lines: pass
        ? ['✅ Clean']
        : [`❌ ${hits.length} hit(s):`, ...hits.slice(0, 20).map(l => '  ' + l)],
    };
  }

  function computeGate7() {
    if (!PLUGINS.length) {
      return { pass: true, lines: ['⏭ No plugins configured in ds-config.json — skipped'] };
    }
    if (process.env.CI) {
      return { pass: true, lines: ['⏭ Build freshness skipped on CI (mtime unreliable after fresh clone)'] };
    }
    const stale      = [];
    // Use the most recently modified token file as the freshness reference
    const themeMtime = THEMES.filter(p => existsSync(join(ROOT, p)))
      .map(p => statSync(join(ROOT, p)).mtime)
      .sort((a, b) => b - a)[0] ?? null;
    for (const p of PLUGINS) {
      const src = join(ROOT, `apps/${p}/ui.src.html`);
      const out = join(ROOT, `apps/${p}/ui.html`);
      if (!existsSync(src) || !existsSync(out)) continue;
      if (statSync(src).mtime > statSync(out).mtime) stale.push(p);
      else if (themeMtime && themeMtime > statSync(out).mtime && !stale.includes(p))
        stale.push(`${p} (theme newer)`);
    }
    const pass = stale.length === 0;
    return {
      pass,
      lines: pass
        ? ['✅ All outputs current']
        : [`❌ Stale — rebuild: ${stale.join(', ')}`],
    };
  }

  // ── Refresh Figma snapshots (requires FIGMA_TOKEN) ───────────────────────────
  const figmaToken   = process.env.FIGMA_TOKEN;
  const figmaFileKey = cfg.figmaFileKey;
  if (figmaToken && figmaFileKey) {
    await refreshComponentProps(figmaFileKey, figmaToken, join(ROOT, SNAP_COMP_PROPS));
    await refreshBoundTokens(figmaFileKey, cfg.frames ?? [], figmaToken, join(ROOT, 'bound-tokens.json'));
    await refreshStateTokens(figmaFileKey, figmaToken, join(ROOT, 'component-state-tokens.json'));
  }

  // ── Run gates ─────────────────────────────────────────────────────────────────
  const gates  = [];
  let anyFail  = false;

  function addGate(label, result) {
    // planLimited gates are neutral — they don't block the audit
    if (!result.pass && !result.planLimited) anyFail = true;
    gates.push({ label, ...result });
  }

  // Inline gates — compute upfront so they can be combined
  const _g1 = computeGate1();
  const _g5 = computeGate5();
  const _g6 = computeGate6();
  const _g7 = computeGate7();

  // Subprocess gates — all launch concurrently
  const [rParity, rStructure, rBound, rIsolation, rVisual, rState, rExemption, rMode, rNaming, rPseudo, rIcon, rStateBinding, rStateVar] = await Promise.all([
    runScriptAsync('parity-check.mjs', ['--json']),
    runScriptAsync('structure-check.mjs'),
    runScriptAsync('bound-check.mjs'),
    runScriptAsync('subcomponent-isolation-check.mjs'),
    runScriptAsync('visual-regression-check.mjs'),
    runScriptAsync('state-check.mjs'),
    runScriptAsync('exemption-check.mjs'),
    runScriptAsync('mode-completeness-check.mjs'),
    runScriptAsync('naming-check.mjs'),
    runScriptAsync('pseudo-element-check.mjs'),
    runScriptAsync('icon-check.mjs'),
    runScriptAsync('state-binding-check.mjs'),
    runScriptAsync('component-selector-check.mjs'),
  ]);

  addGate('Freshness  (snapshots · build output)',
    combineGates(_g1, _g7));
  addGate('Token parity  (color · sizing · typography)',
    parseGate2(rParity));
  addGate('Structure  (snapshot · CSS height · base-rule vars)',
    parseGate3(rStructure));
  addGate('Bound-token coverage  (DS frames → CSS vars)',
    parseGate4(rBound));
  addGate('CSS hygiene  (unused vars · hardcoded values)',
    combineGates(_g5, _g6));
  addGate('Sub-component isolation  (no parent rule overrides sub-component styles)',
    parseGate8(rIsolation));
  addGate('Visual regression  (frames match stored references)',
    parseGate9(rVisual));
  addGate('State coverage  (completeness · selector binding · var placement)',
    combineGates(parseGeneric(rState, /COVERED|UNCOVERED/), parseGeneric(rStateBinding, /COVERED|MISSING/), parseGeneric(rStateVar, /CORRECT|MISMATCH/)));
  addGate('Exemption validity  (EXPLICIT · SKIP_TOKENS · COVERED not stale)',
    parseGeneric(rExemption, /VALID|STALE|BROKEN/));
  addGate('Mode completeness  (all mode-variant tokens adapt across every configured mode)',
    parseGeneric(rMode, /ADAPTS|STATIC|SKIPPED/));
  addGate('CSS naming round-trip  (every var traceable to a Figma token)',
    parseGeneric(rNaming, /TRACEABLE|UNINVENTED/));
  addGate('Contract coverage  (pseudo-elements · SVG symbols)',
    combineGates(parseGeneric(rPseudo, /DOCUMENTED|UNDOCUMENTED/), parseGeneric(rIcon, /DOCUMENTED|UNDOCUMENTED/)));

  // ── Final report ──────────────────────────────────────────────────────────────
  console.log('\n' + C.bold('─'.repeat(WIDTH)));
  console.log(C.bold(`  PARITY AUDIT  ·  ${today}`));
  console.log(C.bold('─'.repeat(WIDTH)) + '\n');

  const planLimitedGates = [];
  gates.forEach((g, i) => {
    let icon;
    if (g.planLimited) { icon = C.yellow('⏭ '); planLimitedGates.push(i + 1); }
    else icon = g.pass ? C.green('✅') : C.red('❌');
    console.log(`${icon}  [${i + 1}] ${C.bold(g.label)}`);
    for (const line of g.lines || []) console.log(`       ${line}`);
    console.log();
  });

  console.log('─'.repeat(WIDTH));
  if (anyFail) {
    console.log(C.bold(C.red('\n  AUDIT FAILED — fix all ❌ above before declaring parity\n')));
  } else {
    console.log(C.bold(C.green('\n  ALL GATES PASS ✅\n')));
  }
  if (planLimitedGates.length) {
    console.log(C.yellow(`  ⏭  Gate(s) [${planLimitedGates.join(', ')}] were not verified — Figma Variables REST API`));
    console.log(C.yellow('     requires Enterprise plan. Token refresh was skipped; committed snapshots'));
    console.log(C.yellow('     were used where available. Upgrade plan or use the Plugin API fallback'));
    console.log(C.yellow('     to generate a fresh snapshot, then commit and re-run.\n'));
  }
  console.log('─'.repeat(WIDTH) + '\n');

  // ── Write parity history ──────────────────────────────────────────────────────
  const histPath = join(ROOT, 'parity-history.json');
  let hist = [];
  try { hist = JSON.parse(readFileSync(histPath, 'utf8')); } catch {}
  hist.push({
    date:        today,
    timestamp:   new Date().toISOString(),
    pass:        gates.filter(g => g.pass && !g.planLimited).length,
    planLimited: gates.filter(g => g.planLimited).length,
    fail:        gates.filter(g => !g.pass && !g.planLimited).length,
    total:       gates.length,
    gates:       gates.map(g => ({ label: g.label, pass: g.pass, planLimited: g.planLimited ?? false })),
  });
  if (hist.length > 100) hist = hist.slice(-100);
  try { writeFileSync(histPath, JSON.stringify(hist, null, 2) + '\n'); } catch {}

  // ── HTML report ───────────────────────────────────────────────────────────────
  const htmlArgIdx = process.argv.indexOf('--report-html');
  if (htmlArgIdx !== -1 && process.argv[htmlArgIdx + 1]) {
    const REPORT_HTML = process.argv[htmlArgIdx + 1];
    let pcResult = { fail: [], aliasFail: [], newSkip: [], skip: [], passList: [], pendingFigmaSync: [] };
    try { pcResult = JSON.parse(readFileSync(join(ROOT, 'parity-check-result.json'), 'utf8')); } catch {}

    const allRows = [
      ...pcResult.fail.map(f         => ({ ...f, status: 'FAIL'       })),
      ...(pcResult.aliasFail || []).map(f => ({ ...f, status: 'ALIAS_FAIL' })),
      ...(pcResult.newSkip   || []).map(f => ({ ...f, status: 'NEW_SKIP'   })),
      ...(pcResult.skip      || []).map(f => ({ ...f, status: 'SKIP'       })),
    ];

    const dims     = ['color', 'sizing', 'typography'];
    const dimLabel = { color: 'Color', sizing: 'Sizing', typography: 'Typography' };
    const colStats = {};
    for (const dim of dims) {
      const rows = allRows.filter(r => r.dimension === dim);
      colStats[dim] = {
        ALL:        rows.length,
        FAIL:       rows.filter(r => r.status === 'FAIL').length,
        ALIAS_FAIL: rows.filter(r => r.status === 'ALIAS_FAIL').length,
        NEW_SKIP:   rows.filter(r => r.status === 'NEW_SKIP').length,
        SKIP:       rows.filter(r => r.status === 'SKIP').length,
      };
    }

    const swatchCell = val => {
      if (!val) return `<td class="empty">—</td>`;
      return val.startsWith('#')
        ? `<td class="val"><span class="sw" style="background:${val}"></span><code class="hex">${val}</code></td>`
        : `<td class="val"><code class="noncolor">${val}</code></td>`;
    };

    let sections = '';
    for (const dim of dims) {
      const rows = allRows.filter(r => r.dimension === dim);
      if (!rows.length) continue;
      const counts = colStats[dim];
      const theadHtml = `<thead><tr><th>Token</th><th>CSS Var</th><th>Mode</th><th>Figma</th><th>CSS / Issue</th><th>Status</th></tr></thead>`;
      let tbody = '';
      for (const r of rows) {
        const badgeCls = r.status === 'FAIL' ? 'missing' : r.status === 'ALIAS_FAIL' ? 'alias-fail' : r.status === 'NEW_SKIP' ? 'new-skip' : '';
        const badgeLabel = { FAIL: 'Fail', ALIAS_FAIL: 'Alias Fail', NEW_SKIP: 'New Skip', SKIP: 'Skip' }[r.status] ?? r.status;
        const issueCell = r.css
          ? swatchCell(r.css)
          : `<td class="empty" style="font-size:10px;color:#888;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(r.issue||r.reason||'').replace(/"/g,'&quot;')}">${r.issue || r.reason || '—'}</td>`;
        tbody += `<tr class="tr s-${r.status}" data-status="${r.status}">
        <td class="tname"><code>${r.token ?? ''}</code></td>
        <td class="tname" style="font-size:10px;color:#5b21b6"><code>${r.cssVar ?? '—'}</code></td>
        <td style="font-size:10px;color:#6b7280">${r.mode ?? '—'}</td>
        ${swatchCell(r.figma)}${issueCell}
        <td class="tst"><span class="badge ${badgeCls}">${badgeLabel}</span></td>
      </tr>`;
      }
      sections += `\n<div class="col-section" data-col="${dim}" data-counts="${encodeURIComponent(JSON.stringify(counts))}">
  <div class="tw"><table>${theadHtml}<tbody>${tbody}</tbody></table></div>
</div>`;
    }

    const firstDim = dims.find(d => (colStats[d]?.ALL ?? 0) > 0) ?? '';
    const tabsHtml = dims.filter(d => (colStats[d]?.ALL ?? 0) > 0).map((d, i) =>
      `<button class="tab${i===0?' active':''}" data-col="${d}" onclick="switchTab('${d}',this)">
  <div class="tab-top"><span class="tab-name">${dimLabel[d]}</span><span class="tab-count">${colStats[d].ALL}</span></div>
</button>`).join('');

    const gateCardsHtml = `<div style="padding:12px 28px;display:flex;flex-wrap:wrap;gap:8px;border-bottom:1px solid #e4e7ec;background:#fafafa">
${gates.map((g, i) => `  <div style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:8px;font-size:11px;font-weight:600;background:${g.pass?'#dcfce7':'#fee2e2'};color:${g.pass?'#166534':'#991b1b'}" title="${(g.lines||[]).join('&#10;').replace(/"/g,'&quot;')}">${g.pass?'✅':'❌'} [${i+1}] ${g.label}</div>`).join('\n')}
</div>`;

    const nFail = pcResult.fail.length;
    const nAlias = (pcResult.aliasFail || []).length;
    const nNewSkip = (pcResult.newSkip || []).length;
    const nPass = (pcResult.passList || []).length;
    const html = buildReport({
      title: `Code Parity — ${today}`,
      metaHtml: `${nPass + nFail} tokens checked · ${today} · ${gates.filter(g => g.pass).length}/${gates.length} gates pass`,
      statCards: [
        { n: nPass,    label: 'Match',     desc: 'CSS matches Figma',     cls: 's'   },
        { n: nFail,    label: 'Fail',      desc: 'Value divergence',      cls: 'st'  },
        { n: nAlias,   label: 'Alias Fail', desc: 'Wrong primitive chain', cls: 'lo'  },
        { n: nNewSkip, label: 'New Skip',  desc: 'Needs sign-off',        cls: 'p'   },
      ],
      filterDefs: [
        { filter: 'ALL',        label: 'All',        dot: null, color: '#111'    },
        { filter: 'FAIL',       label: 'Fail',       dot: 'st', color: '#dc2626' },
        { filter: 'ALIAS_FAIL', label: 'Alias Fail', dot: 'lo', color: '#9333ea' },
        { filter: 'NEW_SKIP',   label: 'New Skip',   dot: 'p',  color: '#ca8a04' },
        { filter: 'SKIP',       label: 'Skip',       dot: null, color: '#6b7280' },
      ],
      tabsHtml,
      sections,
      firstCol: firstDim,
      extraHeadHtml: gateCardsHtml,
    });
    const htmlPath = REPORT_HTML.startsWith('/') ? REPORT_HTML : join(ROOT, REPORT_HTML);
    writeFileSync(htmlPath, html);
    console.log(`\n🌐 HTML parity report → ${REPORT_HTML}`);
  }

  process.exit(anyFail ? 1 : 0);
})();
