// consumer-audit.mjs — Consumer Figma file audit against the DS snapshot.
//
// Two-part comparison:
//   A. Library sync   — DS snapshot tokens vs the linked library copy inside the consumer.
//                       Tokens in DS snapshot but not in the linked copy = consumer's library
//                       is outdated (pending Figma library update).
//   B. Brand coverage — Consumer's linked library tokens vs consumer's local override collection.
//                       Tokens not locally overridden = consumer using DS default value.
//
// Usage (run from the DS project root):
//   node consumer-audit.mjs --file <consumerFileKey>
//   node consumer-audit.mjs --file GfHErcAjjw277iPunsZXCU
//
// Requires:
//   ds-config.json        — figmaFileKey, figma.colorCollection, figma.primitivePrefix,
//                           paths.snapshotVars, figma.modes
//   figma-vars.snapshot.json  — DS ground truth (run Phase 1 first if stale)
//   .env                  — FIGMA_TOKEN (consumer file access, viewer+)
//
// NOTE: The DS snapshot is used as the authoritative DS token list. This avoids
// needing a second API token with Variables scope for the DS file. Run Phase 1
// before this script to ensure the snapshot is current.
//
// IMPORTANT — Library detection:
//   The ONLY reliable way to detect DS library linkage is via the Figma Variables REST API.
//   Each collection has a `remote` flag:
//     remote: false → local to the consumer file (brand overrides)
//     remote: true  → from a linked library (the DS)
//
//   NEVER infer library linkage from component names or page structure in get_metadata.
//   Consumer files wrap DS instances in local components — wrapper names reveal nothing.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

// ── CLI args ──────────────────────────────────────────────────────────────────
const fileArgIdx = process.argv.indexOf('--file');
const CONSUMER_KEY = fileArgIdx !== -1 ? process.argv[fileArgIdx + 1] : null;
if (!CONSUMER_KEY) {
  console.error('❌ Usage: node consumer-audit.mjs --file <consumerFileKey> [--report-md <output.md>]');
  process.exit(1);
}
const mdArgIdx   = process.argv.indexOf('--report-md');
const REPORT_MD  = mdArgIdx  !== -1 ? process.argv[mdArgIdx  + 1] : null;
const htmlArgIdx = process.argv.indexOf('--report-html');
const REPORT_HTML = htmlArgIdx !== -1 ? process.argv[htmlArgIdx + 1] : null;
const FRESH = process.argv.includes('--fresh');

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}
const SNAP_PATH        = cfg.paths?.snapshotVars ?? 'figma-vars.snapshot.json';
const COLOR_COLLECTION = cfg.figma?.colorCollection ?? 'Theme';
const PRIM_PFX         = cfg.figma?.primitivePrefix ?? 'primitives/';
const MODES            = cfg.figma?.modes ?? [
  { name: 'Light', snapshotKey: 'light' },
  { name: 'Dark',  snapshotKey: 'dark'  },
];

// ── Load FIGMA_TOKEN ──────────────────────────────────────────────────────────
function loadEnv() {
  if (!existsSync(join(ROOT, '.env'))) return {};
  const out = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
const env = loadEnv();
const FIGMA_TOKEN = process.env.FIGMA_TOKEN ?? env.FIGMA_TOKEN ?? '';
if (!FIGMA_TOKEN) {
  console.error('❌ FIGMA_TOKEN not set in .env');
  process.exit(1);
}

// ── Load DS snapshot ──────────────────────────────────────────────────────────
let snap;
try { snap = JSON.parse(readFileSync(join(ROOT, SNAP_PATH), 'utf8')); } catch {
  console.error(`❌ DS snapshot not found: ${SNAP_PATH}`);
  console.error('   Run /rms-parity Phase 1 first.');
  process.exit(1);
}

const dsTokenNames = new Set();
for (const mode of MODES) {
  for (const name of Object.keys(snap.color?.[mode.snapshotKey] ?? {})) {
    if (!name.startsWith(PRIM_PFX)) dsTokenNames.add(name);
  }
}
const snapDate = snap._updated ?? 'unknown';
console.log(`\n📐 DS snapshot (${snapDate}): ${dsTokenNames.size} component tokens`);

// ── Fetch a Figma file's display name ─────────────────────────────────────────
async function fetchFigmaFileName(fileKey, token) {
  if (!fileKey || !token) return null;
  try {
    // /nodes?ids=0%3A0 returns {"name":"File Name","nodes":{...}} — file name
    // is the very first field, so we read only the first chunk and abort.
    const res = await fetch(
      `https://api.figma.com/v1/files/${fileKey}/nodes?ids=0%3A0`,
      { headers: { 'X-Figma-Token': token } }
    );
    if (!res.ok) return null;
    const reader = res.body.getReader();
    let text = '';
    while (text.length < 500) {
      const { done, value } = await reader.read();
      if (value) text += new TextDecoder().decode(value);
      if (done) break;
    }
    reader.cancel().catch(() => {});
    const m = text.match(/^\{"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? m[1].replace(/\\"/g, '"') : null;
  } catch { return null; }
}

// ── Fetch consumer file variables (with cache) ────────────────────────────────
const CACHE_PATH = join(ROOT, `consumer-vars-cache.${CONSUMER_KEY}.json`);
let data;

if (!FRESH && existsSync(CACHE_PATH)) {
  data = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  const age = Math.round((Date.now() - (data._cachedAt ?? 0)) / 60000);
  console.log(`\n📦 Using cached variables (${age}m old). Pass --fresh to re-fetch.\n`);
} else {
  console.log(`\n🔍 Fetching variables from consumer file: ${CONSUMER_KEY}\n`);
  const url = `https://api.figma.com/v1/files/${CONSUMER_KEY}/variables/local`;
  const res = await fetch(url, { headers: { 'X-Figma-Token': FIGMA_TOKEN } });
  if (res.status === 404) {
    console.error('❌ Consumer file not found (404). Check file key and token access.');
    process.exit(1);
  }
  if (res.status === 403) {
    console.error('❌ Access denied (403). Token needs "File content: Read" scope.');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`❌ Figma API error: ${res.status} ${res.statusText}`);
    if (existsSync(CACHE_PATH)) {
      console.log('⚠️  Falling back to cached data (may be stale).');
      data = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    } else {
      process.exit(1);
    }
  } else {
    data = await res.json();
    data._cachedAt = Date.now();
    writeFileSync(CACHE_PATH, JSON.stringify(data));
    console.log(`✅ Fetched and cached to consumer-vars-cache.${CONSUMER_KEY}.json\n`);
  }
}

// Fetch file names (cached in data._consumerFileName / data._dsFileName)
const FIGMA_TOKEN_DS = process.env.FIGMA_TOKEN_DS ?? env.FIGMA_TOKEN_DS ?? '';
const DS_FILE_KEY    = cfg.figmaFileKey ?? '';
// File name resolution: ds-config.json overrides > API fetch > file key fallback
const cfgConsumerName = cfg.consumerFileName ?? null;
const cfgDsName       = cfg.dsFileName ?? null;
if (!cfgConsumerName && !data._consumerFileName) {
  data._consumerFileName = await fetchFigmaFileName(CONSUMER_KEY, FIGMA_TOKEN);
  if (data._consumerFileName) writeFileSync(CACHE_PATH, JSON.stringify(data));
}
if (!cfgDsName && !data._dsFileName && (FIGMA_TOKEN_DS || FIGMA_TOKEN)) {
  data._dsFileName = await fetchFigmaFileName(DS_FILE_KEY, FIGMA_TOKEN_DS || FIGMA_TOKEN);
  if (data._dsFileName) writeFileSync(CACHE_PATH, JSON.stringify(data));
}
const consumerFileName = cfgConsumerName ?? data._consumerFileName ?? CONSUMER_KEY;
const dsFileName       = cfgDsName       ?? data._dsFileName       ?? DS_FILE_KEY;

const consumerCollections = Object.values(data.meta?.variableCollections ?? {});
const consumerVariables   = Object.values(data.meta?.variables ?? {});
const byId = Object.fromEntries(consumerVariables.map(v => [v.id, v]));

const localCollections  = consumerCollections.filter(c => !c.remote);
const remoteCollections = consumerCollections.filter(c =>  c.remote);

console.log('── Variable collections ─────────────────────────────────────────');
for (const c of localCollections)  console.log(`  📁 LOCAL    ${c.name}  (${c.variableIds?.length ?? 0} vars)`);
for (const c of remoteCollections) console.log(`  🔗 LIBRARY  ${c.name}  (${c.variableIds?.length ?? 0} vars)`);

if (remoteCollections.length === 0) {
  console.error('\n❌ No linked library collections found.');
  console.error('   Cannot determine library sync status.');
  console.error('   Verify in Figma → Assets → Libraries that the DS is attached.');
  process.exit(1);
}

// Identify the linked DS collection: match by name, pick largest if multiple matches
const linkedDSCollection = remoteCollections
  .filter(c => c.name === COLOR_COLLECTION)
  .sort((a, b) => (b.variableIds?.length ?? 0) - (a.variableIds?.length ?? 0))[0]
  ?? remoteCollections.sort((a, b) => (b.variableIds?.length ?? 0) - (a.variableIds?.length ?? 0))[0];

console.log(`\n✅ DS library in consumer: "${linkedDSCollection.name}" (${linkedDSCollection.variableIds?.length ?? 0} vars)`);

// Build linked library component token set
const linkedVarIds = new Set(linkedDSCollection.variableIds ?? []);
const linkedTokenNames = new Set(
  consumerVariables
    .filter(v => linkedVarIds.has(v.id) && !v.name.startsWith(PRIM_PFX))
    .map(v => v.name)
);
console.log(`   Component tokens (excluding primitives): ${linkedTokenNames.size}`);

// Build local override token set
const localVarIds = new Set(localCollections.flatMap(c => c.variableIds ?? []));
const localTokenNames = new Set(
  consumerVariables
    .filter(v => localVarIds.has(v.id) && !v.name.startsWith(PRIM_PFX))
    .map(v => v.name)
);
console.log(`   Consumer local brand overrides: ${localTokenNames.size}`);

// ── A. Library sync diff ──────────────────────────────────────────────────────
const pendingUpdate = [];  // in DS snapshot, missing from consumer's linked copy
const staleInLinked = [];  // in consumer's linked copy, not in DS snapshot (DS removed them)
const inSync        = [];

for (const name of dsTokenNames) {
  if (linkedTokenNames.has(name)) inSync.push(name);
  else pendingUpdate.push(name);
}
for (const name of linkedTokenNames) {
  if (!dsTokenNames.has(name)) staleInLinked.push(name);
}

// ── B. Brand coverage diff ────────────────────────────────────────────────────
const notOverridden = [];
const overridden    = [];
for (const name of linkedTokenNames) {
  if (localTokenNames.has(name)) overridden.push(name);
  else notOverridden.push(name);
}

// ── Group by component prefix ─────────────────────────────────────────────────
function groupByComponent(tokens) {
  const out = {};
  for (const t of tokens) {
    const parts = t.split('/');
    const prefix = parts[0] === 'primitives' ? 'primitives' : parts.slice(0, 2).join('/');
    if (!out[prefix]) out[prefix] = [];
    out[prefix].push(t);
  }
  return Object.entries(out).sort((a, b) => b[1].length - a[1].length);
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  A. Library Sync  (DS snapshot vs consumer\'s linked library copy)');
console.log('══════════════════════════════════════════════════════════════════');
console.log(`  In sync:         ${inSync.length}  ✅`);
console.log(`  Pending update:  ${pendingUpdate.length}  ⏳  (in DS, not in consumer's linked copy)`);
console.log(`  Stale in linked: ${staleInLinked.length}  🗑   (in consumer's copy, removed from DS)`);

if (pendingUpdate.length > 0) {
  console.log('\n── ⏳ Tokens added to DS — not yet in consumer\'s linked library ─────');
  for (const [prefix, tokens] of groupByComponent(pendingUpdate)) {
    console.log(`\n  ${prefix}  (${tokens.length})`);
    for (const t of tokens.slice(0, 8)) console.log(`    ⏳ ${t}`);
    if (tokens.length > 8) console.log(`    … and ${tokens.length - 8} more`);
  }
  console.log('\n  → Fix: Open consumer file in Figma → Assets → Libraries → Update INNOVA DS');
}
if (staleInLinked.length > 0) {
  console.log('\n── 🗑  Tokens removed from DS, still in consumer\'s old linked copy ──');
  for (const [prefix, tokens] of groupByComponent(staleInLinked)) {
    console.log(`\n  ${prefix}  (${tokens.length})`);
    for (const t of tokens.slice(0, 5)) console.log(`    🗑  ${t}`);
    if (tokens.length > 5) console.log(`    … and ${tokens.length - 5} more`);
  }
  console.log('\n  → These disappear automatically when consumer accepts the library update.');
}

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  B. Brand Coverage  (linked library vs consumer\'s local overrides)');
console.log('══════════════════════════════════════════════════════════════════');
console.log(`  Overridden:      ${overridden.length}  ✅  (consumer has brand value)`);
console.log(`  Not overridden:  ${notOverridden.length}  ℹ️   (inheriting DS default)`);

if (notOverridden.length > 0) {
  console.log('\n── ℹ️  Tokens using DS default (no local brand override) ──────────');
  for (const [prefix, tokens] of groupByComponent(notOverridden)) {
    console.log(`\n  ${prefix}  (${tokens.length})`);
    for (const t of tokens.slice(0, 5)) console.log(`    ℹ️   ${t}`);
    if (tokens.length > 5) console.log(`    … and ${tokens.length - 5} more`);
  }
  console.log('\n  → Review: are these intentional (DS defaults are fine) or missing brand values?');
}

// ── Markdown full token report (--report-md) ──────────────────────────────────
if (REPORT_MD) {
  // Value resolver: handles COLOR→hex, FLOAT→number, BOOLEAN→bool, STRING→string,
  // VARIABLE_ALIAS→alias name (one hop — enough to show what it references).
  function toHex(c) {
    return '#' + ['r','g','b'].map(k => Math.round((c[k]??0)*255).toString(16).padStart(2,'0')).join('');
  }
  function resolveVal(val, modeId) {
    if (val == null) return '—';
    // Walk the full alias chain
    if (typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
      let cur = val; let depth = 0; const chain = [];
      while (typeof cur === 'object' && cur?.type === 'VARIABLE_ALIAS' && depth++ < 10) {
        const v = byId[cur.id];
        if (!v) return `(ext alias)`;
        chain.push(v.name);
        cur = v.valuesByMode?.[modeId] ?? Object.values(v.valuesByMode ?? {})[0];
      }
      // cur is now the concrete value; resolve it
      if (cur != null && typeof cur === 'object' && 'r' in cur) {
        const h = toHex(cur); const a = cur.a ?? 1;
        const suffix = a < 0.999 ? ` @${Math.round(a*100)}%` : '';
        return `${h}${suffix} (→ ${chain[chain.length-1]})`;
      }
      if (typeof cur === 'number') return `${Math.round(cur*100)/100} (→ ${chain[chain.length-1]})`;
      if (typeof cur === 'boolean') return `${cur} (→ ${chain[chain.length-1]})`;
      if (typeof cur === 'string') return `${cur} (→ ${chain[chain.length-1]})`;
      return `→ ${chain[chain.length-1]}`;
    }
    if (typeof val === 'object' && 'r' in val) {
      const h = toHex(val);
      const a = val.a ?? 1;
      return a < 0.999 ? `${h} @${Math.round(a*100)}%` : h;
    }
    if (typeof val === 'number')  return String(Math.round(val * 100) / 100);
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'string')  return val;
    return '—';
  }

  const linkedModes    = linkedDSCollection.modes ?? [];
  const localColObj    = localCollections.sort((a,b)=>(b.variableIds?.length??0)-(a.variableIds?.length??0))[0];
  const localVarIdsSet = new Set(localColObj?.variableIds ?? []);

  // Union of all token names: DS snapshot + linked + local
  const allMdNames = new Set([
    ...dsTokenNames,
    ...[...linkedVarIds].map(id=>byId[id]?.name).filter(n=>n&&!n.startsWith(PRIM_PFX)),
    ...[...localVarIdsSet].map(id=>byId[id]?.name).filter(n=>n&&!n.startsWith(PRIM_PFX)),
  ]);

  const rows = [];
  for (const name of allMdNames) {
    const linkedVar = consumerVariables.find(v => linkedVarIds.has(v.id) && v.name === name);
    const localVar  = consumerVariables.find(v => localVarIdsSet.has(v.id) && v.name === name);

    const inDS = dsTokenNames.has(name);
    let status;
    if (inDS && linkedVar)  status = 'SYNCED';
    else if (inDS)          status = 'PENDING_UPDATE';
    else                    status = 'STALE';

    const type = (linkedVar ?? localVar)?.resolvedType ?? 'COLOR';
    const modeValues = {};
    if (linkedVar || localVar) {
      // Token exists in consumer — read from API
      for (const mode of linkedModes) {
        const val = (linkedVar ?? localVar)?.valuesByMode?.[mode.modeId];
        modeValues[mode.name] = val !== undefined ? resolveVal(val, mode.modeId) : '—';
      }
      // If no linked var, try local collection's own modes
      if (!linkedVar && localVar && linkedModes.length === 0) {
        for (const mode of (localColObj?.modes ?? [])) {
          const val = localVar.valuesByMode?.[mode.modeId];
          modeValues[mode.name] = val !== undefined ? resolveVal(val, mode.modeId) : '—';
        }
      }
    } else {
      // PENDING: token not in consumer — show DS snapshot values so user knows what they'll get
      for (const mode of MODES) {
        const hex = snap.color?.[mode.snapshotKey]?.[name];
        modeValues[mode.name] = hex ? `${hex} *(DS)*` : '(new in DS)';
      }
    }
    rows.push({ name, status, type, modeValues });
  }
  rows.sort((a,b) => a.name.localeCompare(b.name));

  const synced  = rows.filter(r => r.status === 'SYNCED');
  const pending = rows.filter(r => r.status === 'PENDING_UPDATE');
  const stale   = rows.filter(r => r.status === 'STALE');
  const modeNames = [...new Set(rows.flatMap(r => Object.keys(r.modeValues)))];
  const modeHdr = modeNames.join(' | ');
  const modeSep = modeNames.map(() => '---').join(' | ');

  function mdSection(label, items) {
    if (!items.length) return '';
    let s = `## ${label} — ${items.length} tokens\n\n`;
    s += `| Token | Type | ${modeHdr} |\n|---|---|${modeSep}|\n`;
    for (const r of items) {
      const vals = modeNames.map(m => r.modeValues[m] ?? '—').join(' | ');
      s += `| ${r.name} | ${r.type} | ${vals} |\n`;
    }
    return s + '\n';
  }

  let md = `# Consumer Token Parity Report\n\n`;
  md += `Consumer: \`${CONSUMER_KEY}\`  |  DS snapshot: ${snapDate}  |  Generated: ${new Date().toISOString().slice(0,10)}\n\n`;
  md += `## Summary\n\n| Status | Count | Meaning |\n|---|---|---|\n`;
  md += `| ✅ SYNCED | ${synced.length} | In DS + consumer's linked library |\n`;
  md += `| ⏳ PENDING UPDATE | ${pending.length} | Added to DS — consumer hasn't accepted library update |\n`;
  md += `| 🗑 STALE | ${stale.length} | Removed from DS — disappears when consumer accepts update |\n`;
  md += `| **Total** | **${rows.length}** | |\n\n`;
  md += mdSection('✅ SYNCED', synced);
  md += mdSection('⏳ PENDING UPDATE', pending);
  md += mdSection('🗑 STALE', stale);

  const mdPath = REPORT_MD.startsWith('/') ? REPORT_MD : join(ROOT, REPORT_MD);
  writeFileSync(mdPath, md);
  console.log(`\n📊 Full token report → ${REPORT_MD}`);
}

// ── HTML full token report (--report-html) ────────────────────────────────────
if (REPORT_HTML) {
  function _toHex(c){ return '#'+['r','g','b'].map(k=>Math.round((c[k]??0)*255).toString(16).padStart(2,'0')).join(''); }
  function _toConcrete(val, modeId, depth=0) {
    if (depth > 10 || val == null) return {concrete: null, aliasName: null};
    if (typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
      const v = byId[val.id];
      if (!v) return {concrete: null, aliasName: null, ext: true};
      const next = v.valuesByMode?.[modeId] ?? Object.values(v.valuesByMode ?? {})[0];
      const inner = _toConcrete(next, modeId, depth + 1);
      return {...inner, aliasName: inner.aliasName ?? v.name};
    }
    return {concrete: val, aliasName: null};
  }
  function _resolveVal(val, modeId){
    if(val==null) return {display:'—',hex:null};
    if(typeof val==='object'&&val.type==='VARIABLE_ALIAS'){
      const {concrete, aliasName, ext} = _toConcrete(val, modeId);
      if (ext || concrete == null) return {display: aliasName ? `→ ${aliasName}` : '(ext)', hex:null};
      const inner = _resolveVal(concrete, modeId);
      return {...inner, aliasOf: aliasName};
    }
    if(typeof val==='object'&&'r' in val){
      const h=_toHex(val);
      const alpha = val.a??1;
      const opacityPct = alpha < 0.999 ? Math.round(alpha*100) : null;
      return {display:h, hex:h, alpha, opacityPct};
    }
    if(typeof val==='number') return {display:String(Math.round(val*100)/100),hex:null};
    if(typeof val==='boolean') return {display:val?'true':'false',hex:null};
    if(typeof val==='string') return {display:val,hex:null};
    return {display:'—',hex:null};
  }

  // Build a lookup: variableId → collection
  const varToCol = new Map();
  for (const col of consumerCollections)
    for (const id of (col.variableIds??[]))
      varToCol.set(id, col);

  // Collect variables across ALL collections.
  // Primitive prefix filter only applies to remote (library) collections —
  // local collections are the user's own and should always be included.
  const allVars = consumerVariables.filter(v => {
    const col = varToCol.get(v.id);
    if (!col) return false;
    if (col.remote && v.name.startsWith(PRIM_PFX)) return false;
    return true;
  });

  // Also add PENDING tokens (in DS snapshot but not in consumer at all)
  const consumerNames = new Set(allVars.map(v=>v.name));
  const pendingNames  = [...dsTokenNames].filter(n=>!consumerNames.has(n));

  // Build rows: one per unique (name, collectionId) — a token can appear in multiple collections
  const hRows = [];

  for (const v of allVars) {
    const col = varToCol.get(v.id);
    const inDSLinked = linkedVarIds.has(v.id);
    const inDS = dsTokenNames.has(v.name);

    let status;
    if      (!col.remote)                                               status = 'LOCAL';
    else if (!inDSLinked && !inDS)                                      status = 'SYNCED';  // non-main remote collection (Breakpoint, Language, etc.)
    else if (inDSLinked && !inDS && v.resolvedType === 'COLOR')         status = 'STALE';   // color token removed from DS
    else if (inDSLinked)                                                status = 'SYNCED';
    else /* !inDSLinked && inDS */                                      status = 'PENDING';

    // For the linked DS collection (Theme), filter to only DS-configured mode names
    // to exclude stale modes that persist in old cache entries (e.g. Light BPG V1).
    // All other collections (Breakpoint, Language, etc.) show their own modes as-is.
    const configuredModeNames = new Set(MODES.map(m => m.name));
    const isLinkedCol = col.remote && col.name === linkedDSCollection.name;
    const modeVals = {};
    for (const mode of (col.modes??[])) {
      if (isLinkedCol && !configuredModeNames.has(mode.name)) continue;
      const val = v.valuesByMode?.[mode.modeId];
      modeVals[mode.modeId] = {
        modeName: mode.name,
        colName:  col.name,
        colSize:  col.variableIds?.length ?? 0,
        ...(val !== undefined ? _resolveVal(val, mode.modeId) : {display:'—',hex:null}),
      };
    }

    hRows.push({
      name:    v.name,
      colName: col.name,
      remote:  col.remote,
      type:    v.resolvedType ?? '—',
      modeVals,
      status,
      group:   v.name.split('/').slice(0,2).join('/'),
    });
  }

  // Add PENDING rows (in DS snapshot, not in consumer at all)
  // Assign to the linked DS collection so they appear under the correct tab (e.g. Theme)
  const pendingColName = linkedDSCollection.name;
  const pendingModes   = linkedDSCollection.modes ?? [];
  for (const name of pendingNames) {
    const modeVals = {};
    for (const m of MODES) {
      const hex = snap.color?.[m.snapshotKey]?.[name];
      const matchingMode = pendingModes.find(pm => pm.name === m.name) ?? pendingModes[0];
      if (!matchingMode) continue;
      modeVals[matchingMode.modeId] = {
        modeName: matchingMode.name, colName: pendingColName,
        display: hex ?? '(new in DS)', hex: hex??null, fromDS: true,
      };
    }
    hRows.push({ name, colName: pendingColName, remote:true, type:'COLOR', modeVals, status:'PENDING', group: name.split('/').slice(0,2).join('/') });
  }

  hRows.sort((a,b) => a.name.localeCompare(b.name) || a.colName.localeCompare(b.colName));

  // Collect all unique collections (for per-collection mode columns)
  // Filter out internal library fragments: remote collections with ≤ 5 tokens
  // are not shown in Figma's Collections panel and are irrelevant to the user.
  const colRowCount = new Map();
  for (const r of hRows) colRowCount.set(r.colName, (colRowCount.get(r.colName)??0)+1);

  const colIsRemote = new Map();
  for (const r of hRows) if (!colIsRemote.has(r.colName)) colIsRemote.set(r.colName, r.remote);

  const colMap = new Map(); // colName → [unique modes {modeId, modeName}]
  for (const r of hRows) {
    if (colIsRemote.get(r.colName) && colRowCount.get(r.colName) <= 5) continue;
    if (!colMap.has(r.colName)) colMap.set(r.colName, new Map());
    for (const [mid, mv] of Object.entries(r.modeVals))
      if ((mv.colSize ?? 999) > 5)
        colMap.get(r.colName).set(mid, mv.modeName);
  }

  const nS  = hRows.filter(r=>r.status==='SYNCED').length;
  const nP  = hRows.filter(r=>r.status==='PENDING').length;
  const nT  = hRows.filter(r=>r.status==='STALE').length;
  const nL  = hRows.filter(r=>r.status==='LOCAL').length;

  const grouped = {};
  for (const r of hRows){ if(!grouped[r.group])grouped[r.group]=[]; grouped[r.group].push(r); }

  function sw(hex,fromDS,alpha){
    if(!hex) return '';
    const b=fromDS?'2px dashed #888':'1px solid rgba(0,0,0,.15)';
    const bg = (alpha!=null&&alpha<0.999)
      ? `rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${alpha})`
      : hex;
    return `<span class="sw" style="background:${bg};border:${b}"></span>`;
  }
  function badge(s){
    const m={SYNCED:['synced','s','Synced'],PENDING:['pending','p','Pending'],STALE:['stale','st','Stale'],LOCAL:['local','lo','Local']};
    const [cls,dc,lbl]=m[s]??['','',''];
    return `<span class="badge ${cls}"><span class="dot ${dc}"></span>${lbl}</span>`;
  }
  function typePill(t){
    return `<span class="tp tp-${t}">${t}</span>`;
  }
  function valCell(v, span=1){
    const colspan = span > 1 ? ` colspan="${span}"` : '';
    if(!v||v.display==='—') return `<td class="val empty"${colspan}>—</td>`;
    let inner;
    if(v.hex && v.aliasOf){
      // Aliased color — show swatch + variable name only (no hex), mirroring Figma
      const opBadge = v.opacityPct!=null ? `<span class="opacity-badge">${v.opacityPct}%</span>` : '';
      inner = `${sw(v.hex,v.fromDS,v.alpha)}<span class="alias-name" title="${v.aliasOf}">${v.aliasOf}</span>${opBadge}`;
    } else if(v.hex){
      // Direct (unaliased) color — show hex
      const opBadge = v.opacityPct!=null ? `<span class="opacity-badge">${v.opacityPct}%</span>` : '';
      inner = `${sw(v.hex,v.fromDS,v.alpha)}<code class="hex">${v.display}</code>${opBadge}`;
    } else {
      inner = `<code class="noncolor">${v.display}</code>`;
    }
    return `<td class="val"${colspan}>${inner}</td>`;
  }

  // Detect the local override collection (PB Theme) by ID overlap with the linked DS collection.
  // PB Theme shares variable IDs with remote Theme (Figma's override mechanism), so it never
  // appears in colMap independently — we must detect it from the raw collection data instead.
  const _linkedIds = new Set(linkedDSCollection.variableIds ?? []);
  const localOverrideCol = localCollections
    .filter(c => (c.variableIds ?? []).some(id => _linkedIds.has(id)))
    .sort((a,b) => (b.variableIds?.length ?? 0) - (a.variableIds?.length ?? 0))[0]?.name ?? null;

  // Build collectionOrder: DS collections first, local override absorbed into linked DS col tab
  const collectionOrder = [...colMap.keys()].filter(n => n !== localOverrideCol);

  // Build lookup: token name → PB Theme row (for merged columns)
  const overrideByName = new Map();
  if (localOverrideCol) {
    for (const r of hRows.filter(r => r.colName === localOverrideCol))
      overrideByName.set(r.name, r);
  }
  const overrideModes = localOverrideCol ? [...(colMap.get(localOverrideCol)?.entries() ?? [])] : [];

  // Build per-collection section tables
  let sections = '';
  for (const colName of collectionOrder) {
    const colModes  = [...colMap.get(colName).entries()]; // [[modeId, modeName], ...]
    // For the linked DS collection, append PB Theme modes as extra columns
    const isLinked  = colName === linkedDSCollection.name;
    const extraModes = isLinked ? overrideModes : [];
    const allModes  = [...colModes, ...extraModes];
    const colRows   = hRows.filter(r => r.colName === colName);
    if (!colRows.length) continue;

    const isRemote = colRows[0].remote;
    const colTag   = isRemote ? '🔗 Library' : '📁 Local';
    const nCols    = 2 + allModes.length + 1;

    // Build thead: group headers for DS vs PB Theme columns
    let modeThs;
    if (isLinked && extraModes.length) {
      const dsSpan   = colModes.length;
      const pbSpan   = extraModes.length;
      modeThs = `<th colspan="${dsSpan}" class="th-group">${colName}</th><th colspan="${pbSpan}" class="th-group th-group-pb">${localOverrideCol}</th>`;
      const modeRow  = [...colModes,...extraModes].map(([,mn])=>`<th class="th-mode">${mn}</th>`).join('');
      modeThs = `</tr><tr class="mode-header-row"><th></th><th></th>${modeRow}<th></th>`;
      // We'll build a two-row thead
    } else {
      modeThs = allModes.map(([,mn])=>`<th class="th-mode">${mn}</th>`).join('');
    }

    let theadHtml;
    if (isLinked && extraModes.length) {
      theadHtml = `<thead>
        <tr>
          <th rowspan="2">Token</th><th rowspan="2">Type</th>
          <th colspan="${colModes.length}" class="th-group">${colName}</th>
          <th colspan="${extraModes.length}" class="th-group th-group-pb">${localOverrideCol}</th>
          <th rowspan="2">Status</th>
        </tr>
        <tr>${[...colModes,...extraModes].map(([,mn])=>`<th class="th-mode">${mn}</th>`).join('')}</tr>
      </thead>`;
    } else {
      theadHtml = `<thead><tr><th>Token</th><th>Type</th>${allModes.map(([,mn])=>`<th class="th-mode">${mn}</th>`).join('')}<th>Status</th></tr></thead>`;
    }

    let tbody2 = '';
    let lastGroup = '';
    for (const r of colRows) {
      if (r.group !== lastGroup) {
        lastGroup = r.group;
        const g = colRows.filter(x=>x.group===r.group);
        const gs=g.filter(x=>x.status==='SYNCED').length;
        const gp=g.filter(x=>x.status==='PENDING').length;
        const gt=g.filter(x=>x.status==='STALE').length;
        const gl=g.filter(x=>x.status==='LOCAL').length;
        const pills=[gs?`<span class="gp s"><span class="dot s"></span>${gs}</span>`:'',gp?`<span class="gp p"><span class="dot p"></span>${gp}</span>`:'',gt?`<span class="gp t"><span class="dot st"></span>${gt}</span>`:'',gl?`<span class="gp l"><span class="dot lo"></span>${gl}</span>`:''].filter(Boolean).join('');
        tbody2 += `<tr class="gr"><td colspan="${nCols}"><span class="gname">${r.group}</span>${pills}</td></tr>`;
      }
      const dsCells    = colModes.map(([mid])=>valCell(r.modeVals[mid])).join('');
      const overrideRow = overrideByName.get(r.name);
      const pbCells    = extraModes.map(([mid])=>valCell(overrideRow?.modeVals[mid])).join('');
      tbody2 += `<tr class="tr s-${r.status}" data-status="${r.status}" data-col="${colName}">
        <td class="tname"><code>${r.name}</code></td>
        <td class="ttype">${typePill(r.type)}</td>
        ${dsCells}${pbCells}
        <td class="tst">${badge(r.status)}</td>
      </tr>`;
    }

    const totalShown = colRows.length + (isLinked ? overrideByName.size : 0);
    const modeLabel  = isLinked && extraModes.length
      ? `${colName}: ${colModes.map(([,n])=>n).join(', ')} · ${localOverrideCol}: ${extraModes.map(([,n])=>n).join(', ')}`
      : allModes.map(([,n])=>n).join(', ');

    const cs = colStats[colName] ?? {total:0,s:0,p:0,t:0,l:0};
    sections += `
<div class="col-section" data-col="${colName}" data-counts="${encodeURIComponent(JSON.stringify(cs))}">
  <div class="tw"><table>
    ${theadHtml}
    <tbody>${tbody2}</tbody>
  </table></div>
</div>`;
  }

  // Build per-collection status counts for tab badges
  const colStats = {};
  for (const n of collectionOrder) {
    const rows = hRows.filter(r=>r.colName===n);
    colStats[n] = {
      total: rows.length,
      s: rows.filter(r=>r.status==='SYNCED').length,
      p: rows.filter(r=>r.status==='PENDING').length,
      t: rows.filter(r=>r.status==='STALE').length,
      l: rows.filter(r=>r.status==='LOCAL').length,
    };
  }

  const firstCol = collectionOrder[0] ?? '';
  const tabsHtml = collectionOrder.map((n,i) => {
    const st = colStats[n];
    // mini status dots: only show statuses that have tokens
    const label = n === '—' ? 'DS Pending' : n;
    const isLocal = st.l === st.total;
    const isOrphanLocal = isLocal && n !== localOverrideCol;
    return `<button class="tab${i===0?' active':''}" data-col="${n}" onclick="switchTab('${n}',this)">
  <div class="tab-top">
    <span class="tab-name">${label}</span>
    <span class="tab-count">${st.total}</span>
    ${isOrphanLocal ? `<span class="tab-warn" title="Local collection with no DS counterpart — this shouldn't exist">⚠️</span>` : ''}
  </div>
  ${isLocal?'<div class="tab-bottom"><span class="tab-loc">Local</span></div>':''}
</button>`;
  }).join('');

  const html=`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Token Parity — ${dsFileName} × ${consumerFileName}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#111;background:#fff}
.top{padding:16px 28px 10px;border-bottom:1px solid #e4e7ec;flex-shrink:0;display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
.flink{color:inherit;text-decoration:none;border-bottom:1px solid #9ca3af}.flink:hover{border-bottom-color:#111}
.top-title h1{font-size:17px;font-weight:700;margin-bottom:3px}
.top-title .meta{font-size:11px;color:#777}
.sum{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start}
.stat{padding:10px 16px;border-radius:10px;min-width:100px;cursor:default}
.stat .n{font-size:22px;font-weight:800;line-height:1}
.stat .l{font-size:11px;font-weight:600;margin:2px 0 4px;display:flex;align-items:center}
.stat .d{font-size:10px;opacity:.75;line-height:1.3}
.stat.s{background:#dcfce7;color:#166534}
.stat.p{background:#fef9c3;color:#854d0e}
.stat.st{background:#fee2e2;color:#991b1b}
.stat.lo{background:#ede9fe;color:#5b21b6}
.stat.tot{background:#e5e7eb;color:#374151}
/* ── Nav (tabs + toolbar) ── */
.nav{position:sticky;top:0;z-index:20;background:#f8f9fc;flex-shrink:0}
.tabs-hdr{padding:8px 20px 0;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#9ca3af}
.tabs{display:flex;gap:6px;padding:6px 20px 10px;overflow-x:auto}
.tab{display:flex;flex-direction:column;gap:3px;padding:6px 12px;border:1.5px solid #e4e7ec;border-radius:10px;background:#fff;cursor:pointer;flex-shrink:0;transition:border-color .15s,box-shadow .15s;text-align:left}
.tab:hover{border-color:#c7d2fe;box-shadow:0 1px 4px rgba(99,102,241,.08)}
.tab.active{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.12);background:#fff}
.tab-top{display:flex;align-items:baseline;gap:8px}
.tab-name{font-size:12px;font-weight:600;color:#374151;white-space:nowrap}
.tab.active .tab-name{color:#4f46e5}
.tab-count{font-size:18px;font-weight:800;color:#1e1e2e;line-height:1}
.tab.active .tab-count{color:#4f46e5}
.tab-bottom{display:flex;align-items:center;gap:4px;min-height:10px}
.tdot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
.tdot.s{background:#22c55e}.tdot.p{background:#eab308}.tdot.t{background:#ef4444}.tdot.l{background:#a855f7}
.tab-loc{font-size:10px;color:#9ca3af;font-style:italic}
.tab-warn{font-size:12px;margin-left:2px;cursor:default}
/* ── Toolbar ── */
.toolbar{display:flex;gap:8px;align-items:center;padding:8px 20px;border-bottom:1px solid #e4e7ec;background:#fff;flex-wrap:wrap}
.fbtn{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border:1px solid #d1d5db;border-radius:14px;background:#fff;cursor:pointer;font-size:11px;color:#374151;white-space:nowrap}
.fbtn:hover{background:#f3f4f6}.fbtn.on{background:#4f46e5;color:#fff;border-color:#4f46e5}
.fcount{font-weight:700;opacity:.85}.fcount-zero{opacity:.35}
input{border:1px solid #d1d5db;border-radius:6px;padding:4px 10px;font-size:11px;width:200px;outline:none;margin-left:auto}
input:focus{border-color:#6366f1}
.col-info{font-size:10px;color:#888;margin-left:4px}
/* ── Collection panel ── */
.col-section{display:none}
.col-section.active{display:block}
.col-meta{padding:6px 20px;background:#f8f9fc;border-bottom:1px solid #e4e7ec;font-size:10px;color:#666;display:flex;gap:14px}
.col-tag{padding:1px 7px;border-radius:8px;background:#e0e7ff;color:#3730a3;font-weight:600;font-size:10px}
.col-tag.local{background:#ede9fe;color:#5b21b6}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse}
thead{position:relative;z-index:5}
thead th{background:#1e1e2e;color:#e2e8f0;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;padding:7px 10px;text-align:left;white-space:nowrap}
th.th-group{background:#2d2d44;color:#a5b4fc;font-size:10px;font-weight:700;letter-spacing:.6px;text-align:center;border-bottom:1px solid #3d3d5c}
th.th-group-pb{background:#312e3f;color:#c4b5fd}
th.th-mode{min-width:180px}
th:first-child{min-width:280px}
tr.tr{border-bottom:1px solid #f0f2f5}
tr.tr:hover{background:#fafbff}
tr.s-STALE .tname code{color:#c0c4cc}
tr.gr td{background:#f0f2f7;padding:5px 10px;border-top:2px solid #d0d7de}
.gname{font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-right:10px;color:#374151}
.gp{display:inline-flex;align-items:center;font-size:10px;margin-right:5px}.gp.s{color:#166534}.gp.p{color:#854d0e}.gp.t{color:#991b1b}.gp.l{color:#5b21b6}
td{padding:4px 10px;vertical-align:middle}
td.tname code{font-size:11px;word-break:break-all}
td.val{white-space:nowrap;padding:4px 10px}
td.val .sw{display:inline-block;width:13px;height:13px;border-radius:3px;vertical-align:middle;margin-right:4px;position:relative;top:-1px}
code.hex{font-size:11px;color:#1e1e2e;vertical-align:middle}
code.noncolor{font-size:11px;color:#444;background:#f4f4f8;border:1px solid #e0e0ea;border-radius:3px;padding:1px 5px}
.opacity-badge{font-size:10px;color:#6b21a8;background:#f3e8ff;border:1px solid #d8b4fe;border-radius:4px;padding:1px 5px;margin-left:4px;vertical-align:middle;font-weight:500}
.alias-name{font-size:11px;color:#0369a1;vertical-align:middle;max-width:260px;overflow:hidden;text-overflow:ellipsis;display:inline-block;white-space:nowrap;cursor:default}
td.empty{color:#ddd;font-size:11px;padding:4px 10px}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:middle;flex-shrink:0}
.dot.s{background:#22c55e}.dot.p{background:#eab308}.dot.st{background:#ef4444}.dot.lo{background:#a855f7}
.badge{display:inline-flex;align-items:center;padding:2px 7px;border-radius:8px;font-size:10px;font-weight:600;white-space:nowrap}
.badge.synced{background:#dcfce7;color:#166534}.badge.pending{background:#fef9c3;color:#854d0e}
.badge.stale{background:#fee2e2;color:#991b1b}.badge.local{background:#ede9fe;color:#5b21b6}
.tp{padding:1px 5px;border-radius:3px;font-size:10px;font-weight:500}
.tp-COLOR{background:#dbeafe;color:#1e40af}.tp-FLOAT{background:#ede9fe;color:#5b21b6}
.tp-BOOLEAN{background:#fef3c7;color:#92400e}.tp-STRING{background:#dcfce7;color:#166534}.tp-—{background:#f3f4f6;color:#6b7280}
tr.hidden{display:none}
.empty-msg{padding:40px;text-align:center;color:#aaa;font-size:13px}
</style></head><body>
<div class="top">
  <div class="top-title">
    <h1>Token Parity — ${dsFileName} × ${consumerFileName}</h1>
    <div class="meta"><a href="https://www.figma.com/design/${DS_FILE_KEY}" target="_blank" rel="noopener" class="flink">DS Figma file: ${dsFileName}</a> (${snapDate}) &nbsp;·&nbsp; <a href="https://www.figma.com/design/${CONSUMER_KEY}" target="_blank" rel="noopener" class="flink">Consumer Figma file: ${consumerFileName}</a> (${new Date().toISOString().slice(0,10)}) &nbsp;·&nbsp; ${hRows.length} tokens · ${collectionOrder.length} collections</div>
  </div>
  <div class="sum">
    <div class="stat s"><div class="n">${nS}</div><div class="l"><span class="dot s"></span>Synced</div><div class="d">In DS & consumer</div></div>
    <div class="stat p"><div class="n">${nP}</div><div class="l"><span class="dot p"></span>Pending</div><div class="d">Update library to sync</div></div>
    <div class="stat st"><div class="n">${nT}</div><div class="l"><span class="dot st"></span>Stale</div><div class="d">Removed from DS</div></div>
    <div class="stat lo"><div class="n">${nL}</div><div class="l"><span class="dot lo"></span>Local</div><div class="d">Consumer override</div></div>
    <div class="stat tot"><div class="n">${hRows.length}</div><div class="l">Total</div><div class="d">Across collections</div></div>
  </div>
</div>
<div class="nav">
  <div class="tabs-hdr">Collections</div>
  <div class="tabs">${tabsHtml}</div>
  <div class="toolbar">
    <button class="fbtn on" data-filter="ALL" onclick="setF('ALL',this)">All <span class="fcount" id="fc-all"></span></button>
    <button class="fbtn" data-filter="SYNCED" onclick="setF('SYNCED',this)"><span class="dot s"></span>Synced <span class="fcount" id="fc-synced"></span></button>
    <button class="fbtn" data-filter="PENDING" onclick="setF('PENDING',this)"><span class="dot p"></span>Pending <span class="fcount" id="fc-pending"></span></button>
    <button class="fbtn" data-filter="STALE" onclick="setF('STALE',this)"><span class="dot st"></span>Stale <span class="fcount" id="fc-stale"></span></button>
    <button class="fbtn" data-filter="LOCAL" onclick="setF('LOCAL',this)"><span class="dot lo"></span>Local <span class="fcount" id="fc-local"></span></button>
    <span class="col-info" id="col-info"></span>
    <input type="text" id="q" placeholder="Search token…" oninput="apply()">
  </div>
</div>
<div id="main">${sections}</div>
<script>
let af='ALL', activeCol='${firstCol}';
function updateFilterCounts(){
  const sec=document.querySelector('.col-section[data-col="'+activeCol+'"]');
  if(!sec)return;
  let cs={total:0,s:0,p:0,t:0,l:0};
  try{cs=JSON.parse(decodeURIComponent(sec.dataset.counts||'{}'));}catch{}
  const map={all:cs.total,synced:cs.s,pending:cs.p,stale:cs.t,local:cs.l};
  for(const[k,n] of Object.entries(map)){
    const el=document.getElementById('fc-'+k);
    if(!el)continue;
    el.textContent=n;
    el.classList.toggle('fcount-zero',n===0);
  }
}
function switchTab(col, btn){
  activeCol=col;
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.col-section').forEach(s=>s.classList.remove('active'));
  const sec=document.querySelector('.col-section[data-col="'+col+'"]');
  if(sec)sec.classList.add('active');
  document.getElementById('q').value='';
  af='ALL';
  document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('on'));
  document.querySelectorAll('.fbtn')[0].classList.add('on');
  updateFilterCounts();
  apply();
  stickyHead();
}
function setF(f,btn){af=f;document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('on'));btn.classList.add('on');apply();}
function apply(){
  const q=document.getElementById('q').value.toLowerCase();
  const sec=document.querySelector('.col-section[data-col="'+activeCol+'"]');
  if(!sec)return;
  const rows=sec.querySelectorAll('tr.tr');
  let vis=0;
  rows.forEach(r=>{
    const show=(af==='ALL'||r.dataset.status===af)&&(!q||r.querySelector('.tname code').textContent.toLowerCase().includes(q));
    r.classList.toggle('hidden',!show);
    if(show)vis++;
  });
  sec.querySelectorAll('tr.gr').forEach(g=>{
    let sib=g.nextElementSibling,hasVis=false;
    while(sib&&!sib.classList.contains('gr')){if(!sib.classList.contains('hidden'))hasVis=true;sib=sib.nextElementSibling;}
    g.classList.toggle('hidden',!hasVis);
  });
  let em=sec.querySelector('.empty-msg');
  if(!em){em=document.createElement('div');em.className='empty-msg';sec.querySelector('.tw').appendChild(em);}
  em.style.display=vis?'none':'block';
  em.textContent=vis?'':'No tokens match this filter.';
  document.getElementById('col-info').textContent=vis+' token'+(vis===1?'':'s')+' shown';
}
// Sticky thead — CSS position:sticky breaks inside overflow-x:auto containers,
// so we manually translate the thead to follow the scroll position.
function stickyHead(){
  const nav=document.querySelector('.nav');
  const navH=nav?nav.offsetHeight:0;
  const sec=document.querySelector('.col-section.active');
  if(!sec)return;
  const thead=sec.querySelector('thead');
  if(!thead)return;
  const tbl=sec.querySelector('table');
  const top=tbl.getBoundingClientRect().top;
  const offset=Math.max(0,navH-top);
  thead.style.transform=offset>0?'translateY('+offset+'px)':'';
}
window.addEventListener('scroll',stickyHead,{passive:true});
// init
document.addEventListener('DOMContentLoaded',()=>{
  const first=document.querySelector('.col-section');
  if(first)first.classList.add('active');
  updateFilterCounts();
  apply();
  stickyHead();
});
</script></body></html>`;

  const htmlPath = REPORT_HTML.startsWith('/') ? REPORT_HTML : join(ROOT, REPORT_HTML);
  writeFileSync(htmlPath, html);
  console.log(`\n🌐 HTML token report → ${REPORT_HTML} (${hRows.length} rows, ${collectionOrder.length} collections)`);
}

// ── Write report ──────────────────────────────────────────────────────────────
writeFileSync(join(ROOT, 'consumer-audit-report.json'), JSON.stringify({
  _generated: new Date().toISOString().slice(0, 10),
  dsSnapshot: snapDate,
  consumerFileKey: CONSUMER_KEY,
  librarySync: { inSyncCount: inSync.length, pendingUpdateCount: pendingUpdate.length,
    staleCount: staleInLinked.length, pendingUpdate, staleInLinked },
  brandCoverage: { overriddenCount: overridden.length, notOverriddenCount: notOverridden.length,
    notOverridden },
}, null, 2));
console.log('\n📄 Full report → consumer-audit-report.json\n');
