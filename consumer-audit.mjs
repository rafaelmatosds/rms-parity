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

  // Collect all non-primitive variables across ALL collections
  const allVars = consumerVariables.filter(v => {
    const col = varToCol.get(v.id);
    return col && !v.name.startsWith(PRIM_PFX);
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
    if      (inDS && inDSLinked) status = 'SYNCED';
    else if (inDS)               status = 'PENDING';
    else if (!col.remote)        status = 'LOCAL';
    else                         status = 'STALE';

    const modeVals = {};
    for (const mode of (col.modes??[])) {
      const val = v.valuesByMode?.[mode.modeId];
      modeVals[mode.modeId] = {
        modeName: mode.name,
        colName:  col.name,
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
  for (const name of pendingNames) {
    const modeVals = {};
    for (const m of MODES) {
      const hex = snap.color?.[m.snapshotKey]?.[name];
      // Use a fake modeId key for pending rows
      modeVals[`ds_${m.snapshotKey}`] = {
        modeName: m.name, colName: 'DS (not in consumer)',
        display: hex ?? '(new in DS)', hex: hex??null, fromDS: true,
      };
    }
    hRows.push({ name, colName:'—', remote:true, type:'COLOR', modeVals, status:'PENDING', group: name.split('/').slice(0,2).join('/') });
  }

  hRows.sort((a,b) => a.name.localeCompare(b.name) || a.colName.localeCompare(b.colName));

  // Collect all unique collections (for per-collection mode columns)
  const colMap = new Map(); // colName → [unique modes {modeId, modeName}]
  for (const r of hRows) {
    if (!colMap.has(r.colName)) colMap.set(r.colName, new Map());
    for (const [mid, mv] of Object.entries(r.modeVals))
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
    const m={SYNCED:['synced','✅ Synced'],PENDING:['pending','⏳ Pending'],STALE:['stale','🗑 Stale'],LOCAL:['local','📁 Local']};
    const [cls,lbl]=m[s]??['',''];
    return `<span class="badge ${cls}">${lbl}</span>`;
  }
  function typePill(t){
    return `<span class="tp tp-${t}">${t}</span>`;
  }
  function valCell(v, span=1){
    const colspan = span > 1 ? ` colspan="${span}"` : '';
    if(!v||v.display==='—') return `<td class="val empty"${colspan}>—</td>`;
    const aliasTip = v.aliasOf ? ` title="aliased from: ${v.aliasOf}"` : '';
    const inner = v.hex
      ? `${sw(v.hex,v.fromDS,v.alpha)}<code class="hex"${aliasTip}>${v.display}</code>${v.opacityPct!=null?`<span class="opacity-badge">${v.opacityPct}%</span>`:''} ${v.aliasOf?`<span class="alias-tag">↩ ${v.aliasOf.split('/').pop()}</span>`:''}`
      : `<code class="noncolor">${v.display}</code>`;
    return `<td class="val"${colspan}>${inner}</td>`;
  }

  // Build one table per collection group, each with its own mode columns
  // Collect all unique collections in order of occurrence
  const collectionOrder = [...colMap.keys()];

  // Build per-collection section tables
  let sections = '';
  for (const colName of collectionOrder) {
    const colModes = [...colMap.get(colName).entries()]; // [[modeId, modeName], ...]
    const colRows  = hRows.filter(r => r.colName === colName);
    if (!colRows.length) continue;

    const isRemote = colRows[0].remote;
    const colTag   = isRemote ? '🔗 Library' : '📁 Local';
    const modeThs  = colModes.map(([,mn])=>`<th class="th-mode">${mn}</th>`).join('');
    const nCols    = 2 + colModes.length + 1; // token + type + modes + status

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
        const pills=[gs?`<span class="gp s">✅ ${gs}</span>`:'',gp?`<span class="gp p">⏳ ${gp}</span>`:'',gt?`<span class="gp t">🗑 ${gt}</span>`:'',gl?`<span class="gp l">📁 ${gl}</span>`:''].filter(Boolean).join('');
        tbody2 += `<tr class="gr"><td colspan="${nCols}"><span class="gname">${r.group}</span>${pills}</td></tr>`;
      }
      const mCells = colModes.map(([mid])=>valCell(r.modeVals[mid])).join('');
      tbody2 += `<tr class="tr s-${r.status}" data-status="${r.status}" data-col="${colName}">
        <td class="tname"><code>${r.name}</code></td>
        <td class="ttype">${typePill(r.type)}</td>
        ${mCells}
        <td class="tst">${badge(r.status)}</td>
      </tr>`;
    }

    sections += `
<div class="col-section" data-col="${colName}" id="col-${colName.replace(/\s+/g,'_')}">
  <div class="col-header">
    <span class="col-tag">${colTag}</span>
    <strong>${colName}</strong>
    <span class="col-count">${colRows.length} tokens</span>
    <span class="col-modes">Modes: ${colModes.map(([,n])=>n).join(', ')}</span>
  </div>
  <div class="tw"><table>
    <thead><tr><th>Token</th><th>Type</th>${modeThs}<th>Status</th></tr></thead>
    <tbody class="col-tbody">${tbody2}</tbody>
  </table></div>
</div>`;
  }

  const collectionNav = collectionOrder.map(n =>
    `<a href="#col-${n.replace(/\s+/g,'_')}" class="col-link">${n} (${hRows.filter(r=>r.colName===n).length})</a>`
  ).join('');

  const html=`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Token Parity — ${CONSUMER_KEY}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#111;background:#fff}
.top{padding:20px 28px 14px;border-bottom:1px solid #e4e7ec}
h1{font-size:18px;font-weight:700;margin-bottom:4px}
.meta{font-size:11px;color:#666}
.sum{display:flex;gap:12px;padding:14px 28px;background:#f7f8fa;border-bottom:1px solid #e4e7ec;flex-wrap:wrap}
.stat{padding:10px 20px;border-radius:8px;text-align:center;min-width:80px}
.stat .n{font-size:24px;font-weight:800;line-height:1}
.stat .l{font-size:10px;text-transform:uppercase;letter-spacing:.4px;margin-top:3px}
.stat.s{background:#dcfce7;color:#166534}.stat.p{background:#fef9c3;color:#854d0e}
.stat.st{background:#fee2e2;color:#991b1b}.stat.tot{background:#e5e7eb;color:#111}.stat.lo{background:#ede9fe;color:#5b21b6}
.legend{padding:8px 28px;font-size:10px;color:#777;border-bottom:1px solid #e4e7ec;display:flex;gap:16px;flex-wrap:wrap}
.bar{padding:10px 28px;display:flex;gap:8px;align-items:center;border-bottom:1px solid #e4e7ec;position:sticky;top:0;background:#fff;z-index:20;flex-wrap:wrap}
.btn{padding:4px 12px;border:1px solid #d1d5db;border-radius:20px;background:#fff;cursor:pointer;font-size:11px;color:#374151}
.btn:hover{background:#f3f4f6}.btn.on{background:#111;color:#fff;border-color:#111}
input{border:1px solid #d1d5db;border-radius:6px;padding:4px 10px;font-size:11px;width:220px;outline:none}
input:focus{border-color:#6366f1}
.col-nav{padding:8px 28px;display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid #e4e7ec;background:#fafbff}
.col-link{font-size:11px;color:#5b21b6;text-decoration:none;padding:2px 8px;border:1px solid #ede9fe;border-radius:12px;background:#fff}
.col-link:hover{background:#ede9fe}
.col-section{border-bottom:2px solid #e4e7ec;margin-bottom:0}
.col-header{padding:10px 28px;background:#f8f9fc;border-bottom:1px solid #e4e7ec;display:flex;align-items:center;gap:10px}
.col-tag{font-size:10px;padding:2px 8px;border-radius:10px;background:#e0e7ff;color:#3730a3;font-weight:600}
.col-header strong{font-size:13px}
.col-count{font-size:11px;color:#888}
.col-modes{font-size:10px;color:#666;margin-left:auto;font-style:italic}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse}
thead th{background:#1e1e2e;color:#e2e8f0;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;padding:7px 10px;text-align:left;white-space:nowrap}
th.th-mode{min-width:160px}
th:first-child{min-width:300px}
tr.tr{border-bottom:1px solid #f0f2f5}
tr.tr:hover{background:#fafbff}
tr.s-STALE .tname code{color:#bbb}
tr.gr td{background:#f0f2f7;padding:5px 10px;border-top:2px solid #d0d7de}
.gname{font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-right:10px;color:#374151}
.gp{font-size:10px;margin-right:5px}.gp.s{color:#166534}.gp.p{color:#854d0e}.gp.t{color:#991b1b}.gp.l{color:#5b21b6}
td{padding:4px 10px;vertical-align:middle}
td.tname code{font-size:11px;word-break:break-all}
td.val{white-space:nowrap;padding:4px 10px}
td.val .sw{display:inline-block;width:13px;height:13px;border-radius:3px;vertical-align:middle;margin-right:4px;position:relative;top:-1px}
code.hex{font-size:11px;color:#1e1e2e;vertical-align:middle}
code.noncolor{font-size:11px;color:#444;background:#f4f4f8;border:1px solid #e0e0ea;border-radius:3px;padding:1px 5px}
.opacity-badge{font-size:10px;color:#6b21a8;background:#f3e8ff;border:1px solid #d8b4fe;border-radius:4px;padding:1px 5px;margin-left:4px;vertical-align:middle;font-weight:500}
.alias-tag{font-size:10px;color:#0369a1;background:#e0f2fe;border:1px solid #bae6fd;border-radius:4px;padding:1px 5px;vertical-align:middle;max-width:140px;overflow:hidden;text-overflow:ellipsis;display:inline-block;white-space:nowrap}
td.empty{color:#ddd;font-size:11px;padding:4px 10px}
.badge{padding:2px 6px;border-radius:8px;font-size:10px;font-weight:600;white-space:nowrap}
.badge.synced{background:#dcfce7;color:#166534}.badge.pending{background:#fef9c3;color:#854d0e}
.badge.stale{background:#fee2e2;color:#991b1b}.badge.local{background:#ede9fe;color:#5b21b6}
.tp{padding:1px 5px;border-radius:3px;font-size:10px;font-weight:500}
.tp-COLOR{background:#dbeafe;color:#1e40af}.tp-FLOAT{background:#ede9fe;color:#5b21b6}
.tp-BOOLEAN{background:#fef3c7;color:#92400e}.tp-STRING{background:#dcfce7;color:#166534}.tp-—{background:#f3f4f6;color:#6b7280}
tr.hidden{display:none}
.col-section.hidden{display:none}
</style></head><body>
<div class="top"><h1>Token Parity — BancoBAI × INNOVA DS</h1>
<div class="meta">DS snapshot: ${snapDate} &nbsp;·&nbsp; Generated: ${new Date().toISOString().slice(0,10)} &nbsp;·&nbsp; Consumer: ${CONSUMER_KEY}</div></div>
<div class="sum">
  <div class="stat s"><div class="n">${nS}</div><div class="l">✅ Synced</div></div>
  <div class="stat p"><div class="n">${nP}</div><div class="l">⏳ Pending</div></div>
  <div class="stat st"><div class="n">${nT}</div><div class="l">🗑 Stale</div></div>
  <div class="stat lo"><div class="n">${nL}</div><div class="l">📁 Local</div></div>
  <div class="stat tot"><div class="n">${hRows.length}</div><div class="l">Total</div></div>
</div>
<div class="legend">
  <span>✅ <b>Synced</b> — in DS and consumer</span>
  <span>⏳ <b>Pending</b> — in DS, consumer must accept library update (values = DS defaults)</span>
  <span>🗑 <b>Stale</b> — removed from DS, still in consumer's copy</span>
  <span>📁 <b>Local</b> — consumer's own local collection (brand overrides)</span>
</div>
<div class="bar">
  <button class="btn on" onclick="setF('ALL',this)">All</button>
  <button class="btn" onclick="setF('SYNCED',this)">✅ Synced (${nS})</button>
  <button class="btn" onclick="setF('PENDING',this)">⏳ Pending (${nP})</button>
  <button class="btn" onclick="setF('STALE',this)">🗑 Stale (${nT})</button>
  <button class="btn" onclick="setF('LOCAL',this)">📁 Local (${nL})</button>
  <input type="text" id="q" placeholder="Search token…" oninput="apply()">
</div>
<div class="col-nav">${collectionNav}</div>
<div id="main">${sections}</div>
<script>
let af='ALL';
function setF(f,btn){af=f;document.querySelectorAll('.btn').forEach(b=>b.classList.remove('on'));btn.classList.add('on');apply();}
function apply(){
  const q=document.getElementById('q').value.toLowerCase();
  document.querySelectorAll('.col-section').forEach(sec=>{
    const rows=sec.querySelectorAll('tr.tr');
    const gv={};
    rows.forEach(r=>{
      const show=(af==='ALL'||r.dataset.status===af)&&(!q||r.querySelector('.tname code').textContent.toLowerCase().includes(q));
      r.classList.toggle('hidden',!show);
      if(show)gv[r.closest('tbody').id||'x']=true;
    });
    sec.querySelectorAll('tr.gr').forEach(g=>{
      let sib=g.nextElementSibling,vis=false;
      while(sib&&!sib.classList.contains('gr')){if(!sib.classList.contains('hidden'))vis=true;sib=sib.nextElementSibling;}
      g.classList.toggle('hidden',!vis);
    });
    const anyVisible=[...rows].some(r=>!r.classList.contains('hidden'));
    sec.classList.toggle('hidden',!anyVisible);
  });
}
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
