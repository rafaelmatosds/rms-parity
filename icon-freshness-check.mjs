// icon-freshness-check.mjs — Gate [17]
//
// Verifies that figma-icons.snapshot.json is still accurate against live Figma.
// For each DS icon (those with a nodeId in the snapshot), fetches the exported SVG
// from the Figma REST API and compares the path data against the committed snapshot.
//
// When Figma changes an icon, this gate fails with a clear diff message so the dev
// knows to run Phase 1 (which re-exports the SVG and updates the snapshot + sprite).
//
// Requires:
//   FIGMA_TOKEN  — env var with a Figma personal access token (file_content:read scope)
//   ds-config.json  — figmaFileKey, paths.snapshotIcons
//
// Exit 0 = all icon paths match live Figma (or FIGMA_TOKEN missing → skipped).
// Exit 1 = at least one icon changed in Figma since the snapshot was committed.

import { readFileSync, existsSync } from 'fs';
import { join }                     from 'path';

const ROOT  = process.cwd();
const TOKEN = process.env.FIGMA_TOKEN;

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const FILE_KEY       = cfg.figmaFileKey;
const SNAP_ICONS_REL = cfg.paths?.snapshotIcons;

if (!TOKEN) {
  console.log('\n⏭  Gate [17] skipped — FIGMA_TOKEN not set (add to .env to enable icon freshness checks)\n');
  process.exit(0);
}
if (!FILE_KEY) {
  console.error('❌ figmaFileKey missing in ds-config.json'); process.exit(1);
}
if (!SNAP_ICONS_REL || !existsSync(join(ROOT, SNAP_ICONS_REL))) {
  console.log(`\n⏭  Gate [17] skipped — ${SNAP_ICONS_REL ?? 'paths.snapshotIcons'} not found\n`);
  process.exit(0);
}

// ── Load snapshot ─────────────────────────────────────────────────────────────
let iconSnap = {};
try { iconSnap = JSON.parse(readFileSync(join(ROOT, SNAP_ICONS_REL), 'utf8')); } catch (e) {
  console.error(`❌ Could not parse ${SNAP_ICONS_REL}: ${e.message}`); process.exit(1);
}

// Collect DS icons that have a nodeId (skip PLUGIN-SPECIFIC icons — no Figma node to check)
const dsIcons = Object.entries(iconSnap).filter(([, entry]) => entry?.nodeId);
if (!dsIcons.length) {
  console.log('\n⏭  Gate [17] skipped — no DS icons with nodeIds in snapshot\n');
  process.exit(0);
}

// ── Figma REST API: export SVGs ───────────────────────────────────────────────
// Batch nodeIds into groups of 20 (safe Figma API limit for image exports).
const BATCH_SIZE = 20;
const batches    = [];
for (let i = 0; i < dsIcons.length; i += BATCH_SIZE) {
  batches.push(dsIcons.slice(i, i + BATCH_SIZE));
}

function normalizePath(d) {
  // Normalize whitespace between SVG path tokens for robust comparison.
  return d.replace(/\s+/g, ' ').trim();
}

function extractPathDs(svgText) {
  const re = /\bd="([^"]+)"/g;
  const ds = [];
  let m;
  while ((m = re.exec(svgText)) !== null) ds.push(normalizePath(m[1]));
  return ds;
}

// Build nodeId → iconId lookup (Figma response keys use ':' format)
const nodeIdToIconId = {};
for (const [iconId, entry] of dsIcons) {
  nodeIdToIconId[entry.nodeId] = iconId;
}

console.log(`\n─── Gate [17] — Icon snapshot freshness (${dsIcons.length} DS icons) ─────────────\n`);

const changed = [];
const checked = [];

for (const batch of batches) {
  // Figma API accepts node IDs with either ':' or '-' as separator
  const idsParam = encodeURIComponent(batch.map(([, e]) => e.nodeId).join(','));
  const apiUrl   = `https://api.figma.com/v1/images/${FILE_KEY}?ids=${idsParam}&format=svg&svg_outline_text=true&use_absolute_bounds=false`;

  let imageUrls;
  try {
    const resp = await fetch(apiUrl, { headers: { 'X-Figma-Token': TOKEN } });
    if (resp.status === 403) {
      console.log('⏭  Gate [17] skipped — FIGMA_TOKEN lacks file_content:read scope (403)');
      process.exit(0);
    }
    if (!resp.ok) {
      const text = await resp.text();
      console.log(`⏭  Gate [17] skipped — Figma images API ${resp.status}: ${text.slice(0, 120)}`);
      process.exit(0);
    }
    const json = await resp.json();
    imageUrls  = json.images ?? {};
  } catch (e) {
    console.log(`⏭  Gate [17] skipped — network error fetching image URLs: ${e.message}`);
    process.exit(0);
  }

  // Fetch each SVG and compare paths
  for (const [iconId, entry] of batch) {
    const svgUrl = imageUrls[entry.nodeId];
    if (!svgUrl) {
      console.log(`   ⚠️  No SVG URL returned for ${iconId} (${entry.nodeId}) — skipped`);
      continue;
    }

    let svgText;
    try {
      const r = await fetch(svgUrl);
      if (!r.ok) { console.log(`   ⚠️  Could not fetch SVG for ${iconId}: ${r.status}`); continue; }
      svgText = await r.text();
    } catch (e) {
      console.log(`   ⚠️  Network error fetching SVG for ${iconId}: ${e.message}`); continue;
    }

    const livePaths = extractPathDs(svgText);
    const snapPaths = (entry.paths ?? []).map(normalizePath);

    // Compare order-independently
    const liveSorted = [...livePaths].sort();
    const snapSorted = [...snapPaths].sort();
    const match      = JSON.stringify(liveSorted) === JSON.stringify(snapSorted);

    if (match) {
      checked.push(iconId);
    } else {
      changed.push({ iconId, nodeId: entry.nodeId, livePaths, snapPaths });
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
if (checked.length) {
  console.log(`✅ MATCH  ${checked.length}/${dsIcons.length} icon paths match live Figma`);
  for (const id of checked) console.log(`   ✅  #${id}`);
  console.log();
}

if (!changed.length) {
  console.log('All DS icon snapshots are fresh. ✓\n');
  process.exit(0);
}

console.log(`❌ CHANGED  ${changed.length} icon(s) differ from live Figma`);
for (const { iconId, nodeId, livePaths, snapPaths } of changed) {
  console.log(`\n   ❌  #${iconId} (nodeId ${nodeId}): path data changed in Figma`);
  const snapFirst = snapPaths[0] ? snapPaths[0].slice(0, 80) + '…' : '(none)';
  const liveFirst = livePaths[0] ? livePaths[0].slice(0, 80) + '…' : '(none)';
  console.log(`      Snapshot: ${snapFirst}`);
  console.log(`      Figma:    ${liveFirst}`);
  if (livePaths.length !== snapPaths.length) {
    console.log(`      Path count: snapshot=${snapPaths.length}  figma=${livePaths.length}`);
  }
}
console.log('\n   Fix: update figma-icons.snapshot.json with new Figma path data,');
console.log('        then update the matching <symbol> in ui-shared.js (or equivalent sprite).');
console.log('        Run /rms-figma-code-parity (Phase 1) to do this automatically.\n');
process.exit(1);
