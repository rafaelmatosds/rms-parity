# /rms-figma-code-parity — Figma DS ↔ Code Parity

**What it does:** Audits whether the CSS codebase faithfully implements the DS Figma file.
Checks token values, alias chains, structure, bound tokens, unused vars, hardcoded values, build freshness, and more (14 gates). Outputs an HTML report with a gate summary banner and a per-dimension token table (Color / Sizing / Typography). Fix anything red before declaring parity.

> **Sister skill:** `/rms-figma-sync` checks whether a *consumer Figma file* is in sync with the DS. Use that for design handoff validation; use this one for code implementation validation.

Full parity workflow in one command. Phase 1 (live Figma refresh) always runs before Phase 2 (code audit) — you can never accidentally audit against a stale snapshot.

> **Phase 1 is never skipped** — unless you ran `/rms-figma-code-parity` earlier in this same conversation and the snapshot was updated then. A same-day snapshot from a *prior session or context window* is not safe — renames and additions since that run would be invisible without a fresh query. If you are resuming after a context summary, compaction, or a new conversation, always re-query.

## Usage

```
/rms-figma-code-parity
```

**Utility flags (no full audit — just run the script directly):**
```bash
node scripts/audit.mjs --init                         # first-time setup only: scaffold config files, then exit
node scripts/audit.mjs --trend                        # show last 20 audit runs + pass/fail trend
node scripts/audit.mjs --report-html parity.html      # generate HTML report only (no Phase 1)
node scripts/parity-check.mjs --fix                   # auto-fix sizing/typography divergences in theme.css
node scripts/setup-webhook.mjs --list                 # list registered Figma webhooks for this file
```

---

## Project Config

At the start of every run, read `./ds-config.json` from the project root.

**If it doesn't exist** (or `--init` flag is passed), ask the user for exactly four things — nothing else:

1. **Main Design System Figma file** — the full browser URL of the DS file. Extract the file key (path segment after `/design/` or `/file/`). Accept URL, never ask for raw key.
2. **Theme CSS path** — relative path to the token CSS file(s). Auto-scan common locations; show as default if exactly one is found.
3. **Figma personal access token** *(optional)* — needed for collection auto-detection and Gate [9]. If already in `.env`, use it silently. Write to `.env` if provided. Never store in `ds-config.json`.
4. **DS source file for cross-checking** *(optional)* — if the project's snapshot is taken from a downstream file (e.g. a branded fork), provide the upstream DS Figma URL to parse `figmaSourceKey`. Enables `⏳ PENDING FIGMA SYNC` in Gate [2] — mismatches where code matches the upstream source are flagged as pending rather than failures.

**Do not ask for frame node IDs, collection names, or primitive prefixes** — these are either auto-detected or added later.

Then auto-detect and write `ds-config.json`:
- `snapshotVars` / `snapshotStructure` → sibling files next to theme CSS
- `pluginCSS` → scan `apps/*/ui.src.html` and `src/ui.src.html`
- `plugins` → derived from pluginCSS paths
- `figma.colorCollection` / `sizingCollection` / `primitivePrefix` → **queried from Figma API** if token available. Calls `GET /v1/files/:key/variables/local`, inspects every collection's variable types (`COLOR`, `FLOAT`, etc.), variable count, naming patterns, and mode count. The collection with the most `COLOR` vars becomes `colorCollection`; the collection with the most `FLOAT` vars (if distinct) becomes `sizingCollection`; single-mode collections with a dominant path prefix become `primitivePrefix`. Falls back to `"Color"` / `null` / `"primitives/"` only when the token is absent or the call fails.
- `figma.modes` → Light (`:root`) + Dark (`dark-media`) (default — edit if your DS has more modes)
- `frames` → `[]` (add frame node IDs manually after setup)

Also:
- Scaffold `parity-map.mjs` from `parity-map.example.mjs` if not present
- Scaffold `structure-contract.mjs` from `structure-contract.example.mjs` if not present
- Append `ds-config.json`, `parity-map.mjs`, `structure-contract.mjs`, `.env` to `.gitignore`
- Print a **next-steps checklist** (frame IDs, primitive scale, component contracts)

With `--init`: stop after setup (print checklist, exit). Without `--init` and when called because `ds-config.json` was missing: continue the audit immediately.

Once `ds-config.json` exists, extract:
- `figmaFileKey` — Figma DS file key (the file whose tokens are being audited against the code)
- `figmaSourceKey` *(optional)* — upstream DS source file key for cross-checking. When set, Phase 1 queries both files. Mismatches where code matches the upstream source → `⏳ PENDING FIGMA SYNC` (not a gate failure). Absent = no cross-check.
- `frames` — array of `{ name, nodeId }` — the DS frame(s) to audit
- `figma.colorCollection` — name of the color variable collection (e.g. `"Color"`)
- `figma.sizingCollection` — name of the sizing collection, if any (e.g. `"Sizing"`)
- `figma.modes` — array of `{ name, snapshotKey, cssSelector }` defining all DS modes
  - OR legacy: `figma.darkMode` / `figma.lightMode` (two-mode shorthand)
- `figma.primitivePrefix` — token path prefix to exclude from component token walks (e.g. `"primitives/"`)
- `figma.namingConvention` *(optional)* — overrides for how Figma token paths are converted to CSS var names:
  - `dropSegments` — array of path segments to strip from the end of a token path before deriving the var name. Default: `["color", "default"]`. Set to `[]` to preserve all segments (e.g. when CSS vars end in `-color`).
  - `iconTextAlias` — when `true` (default), `/iconText/` in a token path is normalised to `/text/`. Set to `false` when the codebase keeps `iconText` as-is.
- `paths.themeCSS` — path to the token CSS file, **or an array of paths** for projects that split tokens across multiple files (e.g. `["src/tokens/base.css", "src/tokens/components.css"]`). All files are merged before any gate runs. Auto-detection finds any `.css`/`.scss` file containing `:root {` and `--` — no need to manually configure `pluginCSS` for component files in Vue/React/Svelte projects.
- `visualRefs` — directory for stored reference screenshots (default: `.parity-refs`)
- `webhook.port` / `webhook.secret` — webhook server config

Use these throughout all Figma queries. Never hardcode collection or mode names.

---

## Key Architecture Assumptions

- **CSS mode mapping:** each mode's `cssSelector` in `ds-config.json` defines how it maps to CSS:
  - `"root"` → `:root { }` (base/light)
  - `"dark-media"` → `@media (prefers-color-scheme: dark) { :root { } }`
  - `"high-contrast-media"` → `@media (prefers-contrast: more) { :root { } }`
  - `"class:<name>"` → `.<name> :root { }`
  - `"data:<attr>=<val>"` → `[data-theme="dark"] :root { }`
- **Token naming convention:** by default, `token/path/default` → `--token-path` (drop `/default`, `/color`; `/` → `-`). Override with `figma.namingConvention` in `ds-config.json` when the project uses a different convention (e.g. keeping `/color` as `-color` suffix). Any additional shortenings are documented in `parity-map.mjs`.
- **Primitive scale:** document your DS's primitive tokens in `parity-map.mjs` under `NEUTRAL_LIGHT` / `NEUTRAL_DARK` (two modes) or `NEUTRAL_MAPS` (three or more modes) so the resolver can follow alias chains automatically.
- **Snapshot files** at paths defined in `ds-config.json`.

---

## Hard Rules

1. **Every Figma component token must have a dedicated CSS variable.** No token may be covered only by an inline value. `via` is acceptable only when a semantic alias is documented in `parity-map.mjs`.
2. **Every CSS variable must be wired into at least one CSS rule.** A declared-but-unused var must be deleted. Variables are declared when the component exists in code, not before.
3. **Naming convention must be followed exactly.** A correct value under a wrong name is still a divergence.
4. **All modes must match.** A token correct in one mode but wrong in another is still a divergence — this applies to every mode your DS defines: light/dark, compact/comfortable, any breakpoint-based sizing mode, etc.
5. **Hardcoded values in CSS rules are always flagged.** Colors must use `var(--)`, font-sizes must use scale vars, border widths and radii must use your DS sizing tokens. Raw literal values in a CSS rule (not a `:root` declaration) are a divergence. Document intentional exceptions in `ds-config.json → knownHardcodedExceptions`.
6. **New Figma component tokens detected during any audit step must be implemented in code before the audit closes.**
7. **Hidden elements (visible=false) with a bound boolean variable → implement their tokens.** The boolean controls visibility and can be toggled on in other states or projects — the tokens are real. Add the boolean variable itself to CSS (e.g. a show/hide class or `display` binding). **Hidden elements with no boolean variable → flag but never implement.** A token whose only binding is on a statically hidden node (no `boundVariables.visible`) is not a code requirement.
9. **CSS alias chains must mirror Figma exactly.** When Figma aliases a component token directly to a primitive (e.g. `primitives/Neutral 700`), the CSS var must chain through the matching primitive var (e.g. `var(--neutral-700)`). Routing through a semantic intermediate (`var(--border)`, `var(--bg)`, `var(--text-muted)`) is never acceptable as a substitute — even when the resolved hex is identical. A `🔗 ALIAS FAIL` from Gate [2] is always fixed in CSS; there is no exemption map.
8. **Every DS sub-component nested inside another DS component must retain its own CSS styles.** A parent component's rule that combines a component class with a bare element tag (`.card svg { color: X }`) directly targets that element — direct targeting beats inheritance. When adding any CSS rule of the form `.<componentClass> <elementTag> { <visual-property> }`, either (a) prove it's a leaf component, or (b) add explicit `.<subComponent> <elementTag> { }` overrides later in the cascade. Add every such rule to the `ALLOWED` map in `subcomponent-isolation-check.mjs`. Gate [8] enforces this mechanically.

---

## Snapshot Files

| File | Contents | Path (from ds-config.json) |
|---|---|---|
| `figma-vars.snapshot.json` | color (all modes), sizing, typography | `paths.snapshotVars` |
| `figma-structure.snapshot.json` | per-component State=Default structure | `paths.snapshotStructure` |

Both are machine-generated — never hand-edit. `bound-tokens.json` (project root, gitignored) is a transient capture of Phase 2 Step 1b.

**Audit history** is appended to `parity-history.json` at project root after every run. View trend: `node scripts/audit.mjs --trend`.

---

## How to Execute

| Phase | Step | Purpose | Must pass |
|---|---|---|---|
| **1** | **Figma Refresh** | **Query live Figma, diff snapshots, overwrite both files, verify resolvers** | **Snapshots fresh; every change reconciled** |
| **2** | **Bound token walk** | **Walk all DS frames → save to `bound-tokens.json`** | **File written** |
| **2** | **`node scripts/audit.mjs`** | **All 13 gates — Gate [1] always ✅ since Phase 1 just ran** | **0 ❌ gates** |
| 2 | Component walk | Deep per-component inspection of all states, vars, tokens | 0 new divergences |
| 2 | Master Token Table | Single source of truth with resolved hex for every token | 0 ❌ rows |

---

# PHASE 1 — Figma Refresh

---

## Phase 1 — Step 1: Query live Figma values

> **⚠️ Figma MCP 20 kb limit:** the `use_figma` tool silently truncates responses above ~20 kb. A single query for a large collection (>200 tokens) will be cut off mid-JSON with no error. **Always run the probe first to check the count, then decide whether to batch.**

### Step 1a — Probe (always run first)

Fill in `COLOR_COLLECTION`, `SIZING_COLLECTION` (or `null`), and `PRIMITIVE_PREFIX` from `ds-config.json`.

```js
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const idToVar = {};
for (const col of collections) {
  for (const id of col.variableIds) {
    const v = await figma.variables.getVariableByIdAsync(id); if (v) idToVar[id] = v;
  }
}
const COLOR_COLLECTION  = 'Theme';       // figma.colorCollection from ds-config.json
const SIZING_COLLECTION = 'Sizing';      // figma.sizingCollection (or null)
const PRIMITIVE_PREFIX  = 'primitives/'; // figma.primitivePrefix
const col = collections.find(c => c.name === COLOR_COLLECTION);
const colorVarIds = col.variableIds.filter(id => {
  const v = idToVar[id];
  return v && v.resolvedType === 'COLOR' && !v.name.startsWith(PRIMITIVE_PREFIX);
});
const sizingCol = SIZING_COLLECTION ? collections.find(c => c.name === SIZING_COLLECTION) : null;
return {
  colorCount: colorVarIds.length,
  sizingCount: sizingCol?.variableIds.length ?? 0,
  modes: col.modes.map(m => m.name),
};
```

**Decision after probe:**
- `colorCount ≤ 190` → run the single-pass query (Step 1b-single).
- `colorCount > 190` → run batched queries (Step 1b-batched): `Math.ceil(colorCount / 190)` calls, each using `slice(i*190, (i+1)*190)`.

---

### Step 1b-single — Full query (≤190 tokens)

Use this when `colorCount ≤ 190`. Returns everything in one call.

```js
function toHex(c){return '#'+[c.r,c.g,c.b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');}
const collections=await figma.variables.getLocalVariableCollectionsAsync();
const idToVar={};
for(const col of collections){for(const id of col.variableIds){const v=await figma.variables.getVariableByIdAsync(id);if(v)idToVar[id]=v;}}
function resolve(varId,modeId,d=0){if(d>10)return null;const v=idToVar[varId];if(!v)return null;const val=v.valuesByMode[modeId]??Object.values(v.valuesByMode)[0];if(!val)return null;if(val?.type==='VARIABLE_ALIAS')return resolve(val.id,modeId,d+1);if('r'in val)return toHex(val);return null;}
function aliasChain(varId,modeId,d=0){if(d>10)return[];const v=idToVar[varId];if(!v)return[];const val=v.valuesByMode[modeId]??Object.values(v.valuesByMode)[0];if(!val||typeof val!=='object'||val.type!=='VARIABLE_ALIAS')return[];const a=idToVar[val.id];if(!a)return[];return[a.name,...aliasChain(val.id,modeId,d+1)];}
// Fill from ds-config.json:
const COLOR_COLLECTION='Theme'; const SIZING_COLLECTION='Sizing'; const PRIMITIVE_PREFIX='primitives/';
const MODES=[{name:'Light',snapshotKey:'light'},{name:'Dark',snapshotKey:'dark'}]; // from figma.modes
const col=collections.find(c=>c.name===COLOR_COLLECTION);
const colorOut={},aliasesOut={};
for(const m of MODES){
  const modeId=col.modes.find(fm=>fm.name===m.name)?.modeId; if(!modeId)continue;
  colorOut[m.snapshotKey]={}; aliasesOut[m.snapshotKey]={};
  for(const id of col.variableIds){
    const v=idToVar[id]; if(!v||v.resolvedType!=='COLOR'||v.name.startsWith(PRIMITIVE_PREFIX))continue;
    colorOut[m.snapshotKey][v.name]=resolve(id,modeId);
    const chain=aliasChain(id,modeId); if(chain.length>0)aliasesOut[m.snapshotKey][v.name]=chain;
  }
}
const sizingOut={};
if(SIZING_COLLECTION){const sc=collections.find(c=>c.name===SIZING_COLLECTION);if(sc){const mid=sc.modes[0].modeId;for(const id of sc.variableIds){const v=idToVar[id];if(!v)continue;let val=v.valuesByMode[mid]??Object.values(v.valuesByMode)[0];let d=0;while(typeof val==='object'&&val?.type==='VARIABLE_ALIAS'&&d++<10){const a=idToVar[val.id];val=a?.valuesByMode[mid]??Object.values(a?.valuesByMode??{})[0];}sizingOut[v.name]=typeof val==='number'?val+'px':String(val??'');}}}
const WEIGHT={'Thin':100,'Extra Light':200,'Light':300,'Regular':400,'Medium':500,'Semi Bold':600,'Bold':700,'Extra Bold':800,'Black':900};
const styles=await figma.getLocalTextStylesAsync(); const typo={};
for(const st of styles){const key=st.name.trim().toLowerCase().split('/').pop();const entry={size:Math.round(st.fontSize*10)/10+'px'};const w=WEIGHT[st.fontName.style];if(w)entry.weight=String(w);if(st.lineHeight?.unit==='PIXELS')entry.lh=Math.round(st.lineHeight.value*10)/10+'px';typo[key]=entry;}
return {color:colorOut,aliases:aliasesOut,sizing:sizingOut,typography:typo};
```

---

### Step 1b-batched — Batch queries (>190 tokens)

When `colorCount > 190`, run **one query per batch of 190 tokens**. Each call returns `{tokenName: [lightHex, darkHex]}`. After all batches complete, merge all results into `light{}` and `dark{}` objects.

Run `Math.ceil(colorCount / 190)` calls, substituting `BATCH_START` and `BATCH_END` each time:

```js
// Batch query — substitute BATCH_START and BATCH_END each iteration
// Example: batch 0 → (0, 190), batch 1 → (190, 380), etc.
function toHex(c){return '#'+[c.r,c.g,c.b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');}
const collections=await figma.variables.getLocalVariableCollectionsAsync();
const idToVar={};
for(const col of collections){for(const id of col.variableIds){const v=await figma.variables.getVariableByIdAsync(id);if(v)idToVar[id]=v;}}
function resolve(varId,modeId,d=0){if(d>10)return null;const v=idToVar[varId];if(!v)return null;const val=v.valuesByMode[modeId]??Object.values(v.valuesByMode)[0];if(!val)return null;if(val?.type==='VARIABLE_ALIAS')return resolve(val.id,modeId,d+1);if('r'in val)return toHex(val);return null;}
// Fill from ds-config.json:
const COLOR_COLLECTION='Theme'; const PRIMITIVE_PREFIX='primitives/';
const MODES=[{name:'Light',snapshotKey:'light'},{name:'Dark',snapshotKey:'dark'}];
const col=collections.find(c=>c.name===COLOR_COLLECTION);
const modeIds=Object.fromEntries(MODES.map(m=>[m.snapshotKey, col.modes.find(fm=>fm.name===m.name)?.modeId]));
const vars=col.variableIds.map(id=>idToVar[id]).filter(v=>v&&v.resolvedType==='COLOR'&&!v.name.startsWith(PRIMITIVE_PREFIX));
const BATCH_START=0, BATCH_END=190; // ← substitute per iteration
const out={};
for(const v of vars.slice(BATCH_START,BATCH_END)){
  out[v.name]=MODES.map(m=>resolve(v.id,modeIds[m.snapshotKey]));
}
return out; // {tokenName: [lightHex, darkHex, ...]} — one value per mode in MODES order
```

**After all batch calls:** merge into per-mode objects:
```
light = {}; dark = {};
for each batch result:
  for each [tokenName, [lightHex, darkHex]] in result:
    light[tokenName] = lightHex
    dark[tokenName]  = darkHex
```

Then fetch **aliases in batches** (same BATCH_SIZE, same iteration count):

```js
// Alias batch — substitute BATCH_START / BATCH_END per iteration
function aliasChain(varId,modeId,d=0){if(d>10)return[];const v=idToVar[varId];if(!v)return[];const val=v.valuesByMode[modeId]??Object.values(v.valuesByMode)[0];if(!val||typeof val!=='object'||val.type!=='VARIABLE_ALIAS')return[];const a=idToVar[val.id];if(!a)return[];return[a.name,...aliasChain(val.id,modeId,d+1)];}
// Reuse collections / idToVar / col / vars / modeIds / MODES from above
const BATCH_START=0, BATCH_END=190;
const out={};
for(const m of MODES){out[m.snapshotKey]={};}
for(const v of vars.slice(BATCH_START,BATCH_END)){
  for(const m of MODES){
    const chain=aliasChain(v.id,modeIds[m.snapshotKey]);
    if(chain.length>0)out[m.snapshotKey][v.name]=chain;
  }
}
return out;
```

Merge alias batches the same way — accumulate into a single `aliases` object keyed by snapshotKey.

Then fetch **sizing and typography** in one separate call (these collections are small enough to avoid truncation):

```js
// Sizing + typography — single call, always safe
const collections=await figma.variables.getLocalVariableCollectionsAsync();
const idToVar={};
for(const col of collections){for(const id of col.variableIds){const v=await figma.variables.getVariableByIdAsync(id);if(v)idToVar[id]=v;}}
const SIZING_COLLECTION='Sizing'; // or null — fill from ds-config.json
const sizingOut={};
if(SIZING_COLLECTION){const sc=collections.find(c=>c.name===SIZING_COLLECTION);if(sc){const mid=sc.modes[0].modeId;for(const id of sc.variableIds){const v=idToVar[id];if(!v)continue;let val=v.valuesByMode[mid]??Object.values(v.valuesByMode)[0];let d=0;while(typeof val==='object'&&val?.type==='VARIABLE_ALIAS'&&d++<10){const a=idToVar[val.id];val=a?.valuesByMode[mid]??Object.values(a?.valuesByMode??{})[0];}sizingOut[v.name]=typeof val==='number'?val+'px':String(val??'');}}}
const WEIGHT={'Thin':100,'Extra Light':200,'Light':300,'Regular':400,'Medium':500,'Semi Bold':600,'Bold':700,'Extra Bold':800,'Black':900};
const styles=await figma.getLocalTextStylesAsync(); const typo={};
for(const st of styles){const key=st.name.trim().toLowerCase().split('/').pop();const entry={size:Math.round(st.fontSize*10)/10+'px'};const w=WEIGHT[st.fontName.style];if(w)entry.weight=String(w);if(st.lineHeight?.unit==='PIXELS')entry.lh=Math.round(st.lineHeight.value*10)/10+'px';typo[key]=entry;}
return {sizing:sizingOut,typography:typo};
```

**Final assembly** (after all calls complete):
```js
{
  color: { light, dark, /* other modes */ },
  aliases: aliasesOut,
  sizing: sizingOut,
  typography: typo
}
```

> The snapshot `color` object has one key per mode (`snapshotKey`), e.g. `{ light: {...}, dark: {...}, "high-contrast": {...} }`.

---

## Phase 1 — Step 1c: Capture component structure → `figma-structure.snapshot.json`

Navigate to your DS Components page, find each `COMPONENT_SET`, navigate to the `State=Default` child (never the SET — its height equals all variants stacked), and extract structural facts:

```js
// Extract: h, paddingVar {tb,lr}, gapVar, fontSizeVar, fontWeightVar,
//          fillStructure ('direct' | 'before' | 'none'), innerRadiusVar,
//          strokeOnDefault, strokeOnAnyState, childFramePadding
// fillStructure = 'before' when fill is on a child "Background" rect (→ CSS ::before)
//                 'direct' when on the frame itself
//                 'none' when default state has no fill
// strokeOnDefault  = node.strokes?.length > 0 on the State=Default variant's top-level frame
// strokeOnAnyState = true if a stroke exists ANYWHERE in ANY variant's subtree (deep walk).
//                    Must walk recursively into children — many components put strokes on a
//                    "Background" child rect rather than the component frame itself.
//                    Controls Gate [3c] phantom border scan — when false, any CSS `border`
//                    or `outline` on any selector matching this component is a phantom and fails.
// childFramePadding = direct child FRAME nodes (not RECTANGLE/TEXT/INSTANCE) that have at
//                    least one bound padding variable. These "wrapper frames" (e.g. LabelContainer)
//                    add inner padding on top of the outer component padding. The CSS must account
//                    for them via padding on the matching HTML child element (e.g. span, .label).
//                    Omit if no child frames have bound padding.
```

Capture `strokeOnAnyState` with a **deep recursive walk** across all variants:

```js
function deepHasStroke(node, depth = 0) {
  if ((node.strokes?.length ?? 0) > 0) return true;
  if (depth < 4 && 'children' in node) {
    return node.children.some(c => deepHasStroke(c, depth + 1));
  }
  return false;
}
// Walk ALL variants of the COMPONENT_SET, not just the default:
const strokeOnAnyState = set.children.some(v => deepHasStroke(v));
```

Capture `childFramePadding` by walking direct FRAME children of the State=Default variant:

```js
function getBoundPaddingVar(node, idToVar) {
  const bv = node.boundVariables ?? {};
  const res = (id) => id ? idToVar[id]?.name ?? null : null;
  const lr = res(bv.paddingLeft?.id ?? bv.paddingRight?.id);
  const tb = res(bv.paddingTop?.id ?? bv.paddingBottom?.id);
  return (lr || tb) ? { tb: tb ?? null, lr: lr ?? null } : null;
}
const childFramePadding = [];
for (const child of defaultVariant.children ?? []) {
  if (child.type !== 'FRAME') continue;
  const pv = getBoundPaddingVar(child, idToVar);
  if (pv) childFramePadding.push({ name: child.name, paddingVar: pv });
}
// Include childFramePadding in snapshot only when non-empty
```

Write the result in this shape:
```json
{
  "_updated": "YYYY-MM-DD",
  "_note": "Auto-generated by /rms-figma-code-parity. Do not edit manually.",
  "components": {
    "button": {
      "h": 32,
      "paddingVar": { "tb": "padding/s", "lr": "padding/m" },
      "gapVar": "gap/s",
      "strokeOnDefault": false,
      "strokeOnAnyState": false
    },
    "buttonTertiary": {
      "h": 24,
      "paddingVar": { "tb": null, "lr": "padding/xs" },
      "strokeOnDefault": false,
      "strokeOnAnyState": false,
      "childFramePadding": [
        { "name": "LabelContainer", "paddingVar": { "tb": null, "lr": "padding/xs" } }
      ]
    }
  }
}
```

**`childFramePadding` → CSS rule required.** Each entry is a Figma wrapper frame that adds padding inside the component, stacking on top of the outer frame's padding. The CSS must apply equivalent padding to the matching HTML child element. When you find a `childFramePadding` entry:

1. **Identify the HTML equivalent** — determine which element in the rendered HTML corresponds to the Figma child frame (e.g. `LabelContainer` → `<span>` inside `.buttonTertiary`).
2. **Verify or add a CSS rule** — grep for `.<component> <element> { padding`. If none exists, the padding layer is missing from the implementation — add it.
3. **Document in `structure-contract.mjs`** so Gate [3] enforces it automatically:
   ```js
   buttonTertiary: {
     // ...other fields...
     childFramePadding: [
       { name: 'LabelContainer', cssSelector: '.buttonTertiary span', paddingVar: { tb: null, lr: 'padding/xs' } }
     ],
   }
   ```

---

## Phase 1 — Step 2: Read the snapshots

Read both snapshot files. Parse them. If either is missing, treat all live values as new and skip to Step 4.

---

## Phase 1 — Step 3: Diff

Compare live vs snapshot across all sections: `color` (all modes), `sizing`, `typography`, `structure`.

**Lead with the name-set diff** before comparing values — print these two lines first:
```
Token names added   (+N): foo/background/hover/color, …
Token names removed (−N): foo/background/color, …
```
A rename shows as both added and removed. A pure addition shows only as added. This makes renames and new state tokens visible even when no values change.

**Changed tokens** → ⚠️ value changed
**New tokens** → 🆕 needs CSS var (Hard Rule #1)
**Removed tokens** → 🗑 check if CSS var can be removed:
  - If the CSS var is **unused** (no CSS rule references it) → delete it
  - If the CSS var is **used in a CSS rule** → do NOT just delete it. Replace the var with the nearest equivalent remaining token from the same component (e.g. if `--foo-text-hover` is used in a `:hover` rule, replace it with `--foo-text`). Then delete the declaration. Document the decision as a comment.
  - Never leave a dangling `var(--deleted-name)` reference in a rule.

**Rename pattern** (REMOVED + NEW pair with same value) → A token rename adds a `/default/` or other state segment (e.g. `foo/background/color` → `foo/background/default/color`). Check whether the new name maps to the same CSS var via convention — if dropping `/default` produces the same var name, no CSS var change is needed, only a snapshot and comment update. **Also check if sibling state tokens were added alongside the rename** (e.g. `foo/background/hover/color`) — those are genuine new tokens requiring their own CSS vars and rule wiring.

After any token rename, **re-run the bound walk** before Gate [4] — `bound-tokens.json` still has old names and may diverge from what Figma currently binds in the frames. Also update any matching entries in the `EXPLICIT` map in `parity-check.mjs` and the `EXPLICIT`/`COVERED` sets in `bound-check.mjs` — these two files maintain independent maps that can silently diverge after a rename.

If diff is empty: print `✅ No DS changes since last snapshot (YYYY-MM-DD).`

---

## Phase 1 — Step 4: Impact analysis

For every changed or new token:
- ✅ CSS var exists and already correct — no action
- ⚠️ CSS var exists but value wrong — list it
- ❌ No CSS var — must add one (Hard Rule #1)

**Blocking:** reconcile all changes in CSS before running Phase 2.

---

## Phase 1 — Step 5: Update snapshots

Write fresh live data to both files. **Always stamp `_updated` to today's date on both snapshots**, even when no changes were detected — this is what tells Gate [1] the data is fresh. Only overwrite the `typography` section if the text-style capture returned real values (empty capture = keep existing). Always write the `aliases` section from the Phase 1 query — it is used by `parity-check.mjs` to verify CSS var chains route through the correct primitive.

**Projects with upstream source cross-check (`figmaSourceKey` set):** After querying the primary file (`figmaFileKey`), also query the upstream DS source file (`figmaSourceKey`) using the same variable script. Write the source results to `figma-vars.snapshot.json` under a `"source"` key alongside the normal `"color"` key. The source data does not replace the primary data — both are written:
```json
{
  "_updated": "YYYY-MM-DD",
  "color":  { "light": { ... }, "dark": { ... } },
  "source": { "light": { ... }, "dark": { ... } },
  "aliases": { ... }
}
```
`parity-check.mjs` reads `snap.source` automatically and routes mismatches where CSS matches the upstream source (but not the primary snapshot) to `⏳ PENDING FIGMA SYNC` instead of `❌ FAIL`. Gate [2] only fails on genuine divergences.

> **⚠️ 32k output token limit:** Claude's response (including all tool call parameters) must stay under 32,000 output tokens. A snapshot for a large collection (>300 tokens) cannot be written in a single `Write` call — the JSON content alone exceeds the limit. **Always use the chunked write protocol below for large snapshots.**

### Chunked snapshot write protocol

**Step A — Write the skeleton** (tiny, always safe):

```json
{
  "_updated": "YYYY-MM-DD",
  "_note": "Machine-generated by /rms-parity. Do not edit manually.",
  "color": {
    "light": { "__L__": 0 },
    "dark":  { "__D__": 0 }
  },
  "aliases": { "light": { "__AL__": 0 }, "dark": { "__AD__": 0 } },
  "sizing": {},
  "typography": {}
}
```

`__L__`, `__D__`, `__AL__`, `__AD__` are placeholder entries that act as write cursors.

**Step B — Fill each section per batch** using Edit. For each batch of ~190 tokens, replace the placeholder:

- old: `"__L__": 0`
- new: `"token/name/a": "#hex", ...(~190 entries)..., "token/name/z": "#hex", "__L__": 0`

Repeat for every batch. The placeholder migrates to the end of each inserted block.

**Step C — Remove the placeholder** after the last batch:

- old: `, "__L__": 0` (with leading comma)
- new: `` (empty — delete it entirely)

Apply the same B→C pattern for `__D__` (dark), `__AL__` (alias light), `__AD__` (alias dark).

**Step D — Fill sizing and typography** in a single Edit each (these sections are always small).

**Why this works:** each Edit contains ~190 tokens × ~70 chars ≈ 13 kb ≈ 3,200 output tokens — well under the 32k limit. The file stays valid JSON at every step.

**ALIAS FAIL = fix the CSS, never add exceptions.** When `parity-check.mjs` reports `🔗 ALIAS FAIL`, the CSS must be updated to route through the same primitive as Figma. Semantic intermediate vars (`--border`, `--bg`, `--text-muted`) are not allowed as a shortcut when Figma aliases directly to a primitive. There is no exemption map — every alias chain must match exactly.

---

## Phase 1 — Step 6: Verify resolvers

```bash
node scripts/parity-check.mjs
node scripts/structure-check.mjs
```

If either reports FAIL, reconcile CSS before Phase 2.

**NEW SKIP = missing CSS var.** A NEW SKIP in Gate [2] means a token is in the snapshot but has no CSS var and no explicit exemption. Treat it exactly like a NEW token from Phase 1 — implement the CSS var before proceeding. Do not accept a passing Gate [2] that has non-zero NEW SKIPs for non-exempt tokens.

**ALIAS FAIL = wrong primitive chain.** A `🔗 ALIAS FAIL` means hex matches but the CSS var routes through a different primitive than Figma. Either fix the CSS chain or add an entry to `KNOWN_INDIRECT_ALIAS` in `parity-check.mjs` if the semantic intermediate is intentional. Treat non-zero ALIAS FAILs the same as FAIL — do not close the audit.

---

## Phase 1 — Step 7: Summary

Print tokens changed/added/removed per section, which CSS vars need updating, confirmation both snapshots refreshed and resolvers pass.

---

# PHASE 2 — Code Parity

---

## Phase 2 — Step 1b: Bound token walk → `bound-tokens.json`

Walk all DS frames and capture every token bound to a node (Hard Rule #7 split: boolean-hidden → implement; statically hidden → flag only). Use frame IDs from `ds-config.json → frames`.

```js
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const idToVar = {};
for (const col of collections) {
  for (const id of col.variableIds) {
    const v = await figma.variables.getVariableByIdAsync(id); if (v) idToVar[id] = v;
  }
}
const PRIMITIVE_PREFIX = 'YOUR_PRIMITIVE_PREFIX'; // from ds-config.json
// frameIds from ds-config.json → frames[].nodeId
const frameIds = ['YOUR_FRAME_NODE_ID_1', 'YOUR_FRAME_NODE_ID_2'];
const used = {}, hidden = {};
for (const fid of frameIds) {
  const frame = figma.currentPage.findOne(n => n.id === fid);
  if (!frame) { console.error(`❌ Frame not found: ${fid} — check ds-config.json → frames and ensure you are on the correct Figma page`); continue; }
  function walk(node, ancestorStaticHidden = false) {
    // Hard Rule #7: hidden WITH a boolean variable → implement (boolean can be toggled).
    //               hidden WITHOUT a boolean variable → statically hidden → flag, don't implement.
    const hasBoolVar       = !!node.boundVariables?.visible;
    const selfStaticHidden = node.visible === false && !hasBoolVar;
    const isStaticHidden   = ancestorStaticHidden || selfStaticHidden;

    if (node.boundVariables) {
      for (const [prop, binding] of Object.entries(node.boundVariables)) {
        for (const b of (Array.isArray(binding) ? binding : [binding])) {
          if (!b?.id) continue;
          const v = idToVar[b.id];
          if (!v || v.name.startsWith(PRIMITIVE_PREFIX)) continue;
          const bucket = isStaticHidden ? hidden : used;
          if (!bucket[v.name]) bucket[v.name] = [];
          bucket[v.name].push({ frame: fid, nodeId: node.id, nodeName: node.name, prop, hasBoolVar });
        }
      }
    }
    if ('children' in node) node.children.forEach(c => walk(c, isStaticHidden));
  }
  walk(frame);
}
if (Object.keys(hidden).length)
  console.log('⚠️ STATICALLY HIDDEN — no boolean var, do not implement:', Object.keys(hidden));
return used;
```

**Save output to `bound-tokens.json` at project root.**

> **Output truncation fallback:** the Figma MCP tool may truncate large responses. If the walk output is cut off mid-JSON, run a compact second pass that returns only the keys — `bound-check.mjs` accepts either shape:
> ```js
> // Compact pass — run if full walk was truncated
> // (reuse the same idToVar / walk logic above)
> const compact = {};
> for (const [k, arr] of Object.entries(used)) compact[k] = arr.length;
> return { used: compact, hiddenTokens: Object.keys(hidden) };
> ```
> Write the compact object as `bound-tokens.json` — `bound-check.mjs` uses `Object.keys()` so counts work fine.

---

## Phase 2 — Step 2: Run all 14 audit gates

```bash
node scripts/audit.mjs
```

All 14 gates must pass. Gate [1] is always ✅ since Phase 1 just ran.

| Gate | Script | What it checks |
|---|---|---|
| [1]  | inline | **Snapshot freshness** — Is the data fresh? Always ✅ after Phase 1 runs. |
| [2]  | `parity-check.mjs` | **Token value parity** — Do the colors, sizes, and fonts match Figma? Every token across every mode. NEW SKIP = token in Figma but no CSS var yet — treat as ❌. `⏳ PENDING FIGMA SYNC` when code matches the upstream DS source but the primary snapshot has a newer value (not a code bug — snapshot needs updating). |
| [3]  | `structure-check.mjs` | **Structural parity** — Does the component look the way Figma says it should? Height, spacing, font, and radius must all point to the right design tokens — no hardcodes, no gaps. Also enforces `childFramePadding` HTML structure: for every entry in the structure contract's `childFramePadding[]`, grep every file in `paths.pluginCSS` for the component class and verify that any button/element containing visible text has the required child element (e.g. `<span>`) so the CSS padding rule can apply. A button with bare text instead of a wrapped child is flagged as ❌ structural mismatch — fix by wrapping the text in the required element, then rebuild and re-audit. |
| [4]  | `bound-check.mjs` | **Bound-token coverage** — Is anything in the design that isn't in the code? Walks the Figma frames and finds tokens actively used in the design that have no CSS variable yet. |
| [5]  | inline | **Unused CSS vars** — Are there CSS variables nobody's using? Declared-but-orphaned variables that can be safely deleted. Scans the whole repo (`.vue`, `.jsx`, `.tsx`, `.html`, `.css`, `.scss`, `.js`, `.ts`). |
| [6]  | inline | **Hardcoded values** — Are there raw values that should be tokens? Every CSS rule is scanned — colors, padding, margin, width, height, border-radius, gap, font-size, line-height, and more. Any literal value written directly into a rule instead of `var(--)` is flagged. Intentional layout math (`100%`, `50%`) goes in `ds-config.json → knownHardcodedExceptions`. |
| [7]  | inline | **Build freshness** — Is the built output up to date? Catches cases where you edited the source but forgot to rebuild. Skips if no build plugins are configured. |
| [8]  | `subcomponent-isolation-check.mjs` | **Sub-component isolation** — Is a parent component accidentally overriding a child's styles? When one DS component lives inside another, their styles must not bleed into each other. |
| [9]  | `visual-regression-check.mjs` | **Visual regression** — Does it still look the same? Compares a live screenshot of the Figma frame against the last accepted reference. Flags any visual drift. Skips if `FIGMA_TOKEN` isn't set or no frames are configured. |
| [10] | `state-check.mjs` | **State completeness** — Are all component states covered? Every interactive state in Figma (hover, pressed, disabled, selected…) must have a token in the code. Skips if no state data is available. |
| [11] | `exemption-check.mjs` | **Exemption validity** — Are the documented exceptions still valid? Tokens marked as "skip this" are cross-checked against the snapshot. If a token no longer exists or has changed, the exemption is flagged as stale. |
| [12] | `mode-completeness-check.mjs` | **Mode completeness** — Do all modes actually adapt? Verifies that every token meant to vary between modes actually does — light vs dark, compact vs comfortable spacing, any breakpoint or density mode your DS defines. Nothing should be frozen at the same value across modes that are supposed to differ. |
| [13] | `naming-check.mjs` | **CSS naming round-trip** — Do all CSS variable names trace back to a real Figma token? Catches variables someone invented that have no counterpart in the design system. |
| [14] | `pseudo-element-check.mjs` | **Pseudo-element audit** — Are decorative `::before` / `::after` elements documented? Any visual element added via CSS pseudo-elements must be declared in the component's structure contract so it doesn't silently drift. |

**Gate [2] fix mode:** run `node scripts/parity-check.mjs --fix` to auto-apply sizing/typography value fixes. Color divergences require manual review.

**History:** every run appends to `parity-history.json`. View trend: `node scripts/audit.mjs --trend`.

---

## Gate [3g] — Figma annotation parity

Every Figma annotation attached to a component node is a design specification. The audit fetches `doc.annotations[]` for every component via the REST API and stores them in `figma-component-props.snapshot.json`. Gate [3g] then enforces that each annotation is acknowledged in the contract and, where applicable, verified in CSS.

### How it works

1. **`audit.mjs` refresh** — `refreshComponentProps()` fetches `doc.annotations[]` alongside `componentPropertyDefinitions` for every component node. Nodes with either properties **or** annotations are included in the snapshot.
2. **Gate [3g] check** — for every component in the snapshot that has annotations, `structure-check.mjs` looks up `CONTRACT[key].annotations` and verifies each annotation label is present. Missing label → `FAIL`. If a CSS selector is provided, it must exist in the CSS — not found → `FAIL`.
3. **`anyFail`** — annotation failures count the same as property failures; the gate exits non-zero.

### CONTRACT.annotations schema

```js
// in structure-contract.mjs
someComponent: {
  annotations: {
    // Selector existence — just verifies the rule exists
    'Another annotation label': 'css-selector',

    // Property assertion — verifies a specific property uses the right token
    'Background must match surface': { sel: '.myComp', prop: 'background', expectedVar: '--area-bg' },

    // Exact value assertion
    'Must be transparent': { sel: '.myComp::after', prop: 'content', expected: 'none' },

    // Prose-only — acknowledged, nothing to verify in CSS
    'Accessibility note': null,
  },
  propertyMap: { /* ... */ },
},
```

- **`'css-selector'`** — selector must exist in the compiled CSS. Minimum check — only use when existence alone is enough.
- **`{ sel, prop, expectedVar }`** — verifies that `sel`'s `prop` uses `var(--expectedVar[, fallback])`. Use this for token-driven properties like `background`, `color`, `gap`. Catches wrong token even if the selector exists.
- **`{ sel, prop, expected }`** — verifies an exact CSS value (e.g. `'none'`, `'transparent'`). Use for non-token assertions.
- **`null`** — prose-only guidance (e.g. accessibility notes, copy constraints). Acknowledged but no CSS required.

**Prefer `{ sel, prop, expectedVar }` over a plain selector** whenever the annotation specifies a visual property — it's the only form that would have caught `background: var(--bg)` being wrong while `.dividerSection` still existed.

### Reading annotations correctly

Annotations describe design intent, not CSS mechanics. Read them for what they require the code to guarantee:

| Annotation says | Correct CSS | Wrong CSS |
|---|---|---|
| "inherit from the parent surface / never leave undefined" | `background: var(--surface-token)` — always a defined value | `background: inherit` — resolves to transparent if parent has none |
| "never visible without a label" | show/hide guard class (e.g. `.no-label .label { display: none }`) | omit the element in JS conditionally |
| "matches the containing surface" | use the surface's token var, not a hardcoded color | `background: #1a1a1a` |

**Key rule:** "inherit" in annotation prose means "take on the same value as the surface" — implement with the surface token var, not the CSS `inherit` keyword.

### Workflow when an annotation appears

1. `pnpm parity` fails: `someComponent: annotation "..." not acknowledged in CONTRACT.annotations`
2. Read the annotation — decide what it requires in code
3. Implement the CSS if needed
4. Add to `CONTRACT.annotations` with the appropriate selector or `null`
5. Re-run `pnpm parity` — gate must pass before closing

---

## Gate [3] — childFramePadding HTML structure check

When `structure-contract.mjs` has a component entry with `childFramePadding[]`, the CSS padding rule targets a child element (e.g. `.buttonTertiary span`). If the HTML renders bare text without that child element, the padding is silently missing — the CSS rule matches nothing.

**Run this check after every Gate [3] pass** (or any time you add a `childFramePadding` entry to the contract):

For each component that has `childFramePadding` entries:
1. Extract the `cssSelector` for each entry (e.g. `.buttonTertiary span` → child tag = `span`, parent class = `buttonTertiary`)
2. Grep every file in `ds-config.json → paths.pluginCSS` for the parent class
3. For every match that is a **text-bearing button** (i.e. the button content is visible text, not a pure SVG icon), verify the text is wrapped in the required child element
4. Flag any bare-text instance as ❌ with the file path, line number, and the required fix (wrap text in `<span>...</span>` or whichever element the `cssSelector` requires)

**What counts as "text-bearing":** the button innerHTML contains a text node or interpolated string literal that is not an SVG — e.g. `>Cancel<`, `>${text}<`, `>${label}<`. Icon-only buttons (SVG-only content) do not need the child wrapper.

**Example grep pattern for `.buttonTertiary`:**
```bash
grep -rn "buttonTertiary" apps/ --include="ui.src.html" | grep -v "\.buttonTertiary\b"
```
Then for each matched line, check whether text content is wrapped: `>Cancel<` is ❌, `><span>Cancel</span><` is ✅.

---

## Phase 2 — State walk → `component-state-tokens.json` (enables Gate [10])

Walk all COMPONENT_SET nodes (not just DS frame instances) to capture tokens bound in EVERY state variant — not just State=Default. This reveals tokens like `buttonList/icon/hover` that are used in Figma's design but may not be wired into CSS hover rules.

```js
// Walk all COMPONENT_SET children (all state variants, not just State=Default)
// idToVar must be populated first (same as bound-token walk)
const PRIMITIVE_PREFIX = 'YOUR_PRIMITIVE_PREFIX';
const stateTokens = {};
const sets = figma.currentPage.findAll(n => n.type === 'COMPONENT_SET');
for (const set of sets) {
  for (const variant of set.children) {
    function walkVariant(node) {
      if (node.boundVariables) {
        for (const [prop, binding] of Object.entries(node.boundVariables)) {
          for (const b of (Array.isArray(binding) ? binding : [binding])) {
            if (!b?.id) continue;
            const v = idToVar[b.id];
            if (!v || v.name.startsWith(PRIMITIVE_PREFIX)) continue;
            if (!stateTokens[v.name]) stateTokens[v.name] = [];
            stateTokens[v.name].push({ set: set.name, variant: variant.name, prop });
          }
        }
      }
      if ('children' in node) node.children.forEach(walkVariant);
    }
    walkVariant(variant);
  }
}
return stateTokens;
```

**Save output to `component-state-tokens.json` at project root** (gitignored). Gate [10] will then verify all captured state tokens are implemented in CSS or in the `EXPLICIT`/`COVERED` sets in `bound-check.mjs`. Re-run after any DS component state addition.

---

## Phase 2 — Steps 3–10: When are manual steps required?

| Condition | Steps 3–10 |
|---|---|
| All 10 gates pass AND Phase 1 found no new tokens | **Spot-check** — sample 1–2 components per run; full walk not required |
| Any gate ❌ OR Phase 1 found new/changed tokens | **Mandatory** — run the full sequence before declaring parity |
| New component added to DS | **Mandatory** — Step 3 deep-walk for that component at minimum |

Gate failures take priority. Fix every ❌ before running the manual steps.

---

## Phase 2 — Step 3: Component deep-walk

For every DS component, walk all states and extract fill/stroke/padding/gap/radius/text with bound variable names. Use the `describe()` pattern:

```js
function getVar(node, prop) {
  const bv = node.boundVariables?.[prop]; if (!bv) return null;
  const ref = Array.isArray(bv) ? bv[0] : bv;
  return idToVar[ref?.id]?.name || null;
}
function toHex(c) { return '#'+[c.r,c.g,c.b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join(''); }
function describe(n, depth=0) {
  const o = { id: n.id, name: n.name, type: n.type, w: Math.round(n.width), h: Math.round(n.height) };
  try { if (n.layoutMode) o.layoutMode = n.layoutMode; } catch{}
  try { o.padding = {t:n.paddingTop,r:n.paddingRight,b:n.paddingBottom,l:n.paddingLeft};
        o.paddingVar = getVar(n,'paddingTop') || getVar(n,'paddingLeft'); } catch{}
  try { if (n.itemSpacing) { o.gap = n.itemSpacing; o.gapVar = getVar(n,'itemSpacing'); } } catch{}
  try { if (n.cornerRadius && n.cornerRadius !== figma.mixed) { o.radius=n.cornerRadius; o.radiusVar=getVar(n,'cornerRadius'); } } catch{}
  try { if (n.fills?.length && n.fills[0].type==='SOLID') { o.fill=toHex(n.fills[0].color); o.fillVar=getVar(n,'fills'); } } catch{}
  try {
    if (n.strokes?.length) {
      o.strokeVar=getVar(n,'strokes'); o.strokeWeight=n.strokeWeight;
      o.strokeStyle=(n.dashPattern?.length>0)?'dashed':'solid';
    } else { o.strokes='none'; }
  } catch{}
  try { if (n.type==='TEXT') { o.fontSize=n.fontSize; o.fontWeight=n.fontWeight; o.textFillVar=getVar(n,'fills'); } } catch{}
  if (depth<3 && n.children) o.children=n.children.map(c=>describe(c,depth+1));
  return o;
}
```

**Critical:** always query `State=Default` CHILD, never the SET.

**Stroke presence rule:** if `strokes: 'none'` on the Default state → CSS must use a transparent border (`border: ... solid transparent`). Never use a token color on the default state's border.

Compare results against your `structure-contract.mjs`. Any drift → update contract AND CSS together.

**State/variant selectors — full chain:** for every non-default Figma state or variant property value (Hover, Disabled, Selected, Size=Small, etc.), document in `structure-contract.mjs → STATE_SELECTORS`:
- `selector` — the CSS selector that activates this state
- `vars` — for each visual property in this state, the exact token var that must be used

`structure-check.mjs` verifies: (1) the selector exists in CSS, and (2) the selector's rule uses the declared token var for each property. Token values are Gate [2]'s job — this gate verifies the *wiring*. Together they form the complete chain: Figma state exists → selector exists → correct var is bound → var resolves to correct hex.

---

## Phase 2 — Step 4: Hardcoded value scan (A–F)

Run across all production CSS files:

**A.** Hex colors in rules (not `:root` declarations) — must use `var(--)` 
**B.** Hardcoded font sizes — must use your scale vars
**C.** Hardcoded border radius — must use your sizing token vars
**D.** Hardcoded border widths — must use your sizing token vars
**E.** Hardcoded spacing — must use your gap/padding token vars
**F.** JS inline styles (`element.style.color = ...`)

Document intentional exceptions in `ds-config.json → knownHardcodedExceptions`.

---

## Phase 2 — Step 5: State coverage check

For every DS component with multiple states, verify a corresponding CSS rule exists and is reachable.

---

## Phase 2 — Step 6: Mode override completeness

Every token where modes have different values must have an explicit CSS override for non-default modes (or use a self-resolving var that already carries both values). Gate [2] catches this automatically for all tokens in the snapshot.

---

## Phase 2 — Step 7: Screenshots

Gate [9] handles this automatically if `FIGMA_TOKEN` is set. For manual review: use `get_screenshot` with `figmaFileKey` and each `frames[].nodeId` from `ds-config.json`. Compare against `.parity-refs/` reference images. Flag any visible difference not already surfaced by the automated gates.

To accept a visual change after verifying it's intentional:
```bash
mv .parity-refs/<frame-id>.new.png .parity-refs/<frame-id>.png
```

---

## Phase 2 — Step 8: Build freshness

If your project has a build step:

```bash
# rebuild, then check for uncommitted changes in built output
git status --short -- '<your built output paths>'
```

Expected: empty output. Any listed file = stale build.

---

## Phase 2 — Step 9: Master Token Table

Produce one table covering every Figma component token:

| Figma token | CSS var | Name | Mode A Figma | Mode A Code | A | Mode B Figma | Mode B Code | B | Alias |
|---|---|---|---|---|---|---|---|---|---|

- `none` = token exists in Figma, no CSS var yet
- `via --alias` = covered by a semantic alias documented in `parity-map.mjs`
- `~` = Figma value null/missing
- **Mode A Code / Mode B Code must show the actual resolved value**, not just the var reference

After the table: Divergence summary (❌ rows), Unused vars, New Figma tokens.

---

## Naming Convention

| Rule | Notes |
|---|---|
| Token path → CSS var | `component/property/state` → `--component-property-state` |
| Drop `/default` state | Base token has no state suffix |
| Drop `/color` suffix | Always omit |
| `/` → `-` | Path separator becomes hyphen |
| Preserve camelCase | Component names stay as-is |
| State names verbatim | `active`, `selected`, `hover`, `disabled` — never substitute |

Any DS-specific shortenings are documented in `parity-map.mjs` under `EXPLICIT`.

---

## Alias Chain Rule

If Figma aliases `component/background → primitives/SomeToken`, CSS must use `var(--some-token)` — never a hardcoded literal. The alias chain must be fully traceable through CSS `var()` references.

Document your primitive → CSS var mapping in `parity-map.mjs` under `NEUTRAL_LIGHT` / `NEUTRAL_DARK` (two modes) or `NEUTRAL_MAPS` (three or more modes) so the resolver can follow chains automatically.

---

## Webhook Automation

Once deployed, the webhook server auto-triggers parity checks on every DS change without manual invocation:

```bash
# Start the server (keep running)
node scripts/webhook-server.mjs

# Register with Figma once (public URL required)
FIGMA_TOKEN=xxx node scripts/setup-webhook.mjs --url https://your-host.com/webhook

# Manage webhooks
node scripts/setup-webhook.mjs --list
node scripts/setup-webhook.mjs --delete <id>
```

Configure `webhook.port` and `webhook.secret` in `ds-config.json`.

---

## Audit Rules

- Never change source files to *hide* a divergence — report it.
- Always compare **all** configured modes.
- Naming violations are flagged regardless of whether the value is correct.
- When renaming: update declarations, all usages, then rebuild. Update `EXPLICIT` in both `parity-check.mjs` and `bound-check.mjs` if the old name had an explicit entry.
- When adding a token group: add CSS var + rule consumer + update `parity-map.mjs` + rebuild.
- When removing a token from DS: remove CSS var if unused (Gate [5] catches it), replace in rules if used, remove from `parity-map.mjs`, remove from `EXPLICIT`/`COVERED` if present.
- When removing an entire component from DS: Phase 1 shows many REMOVED tokens for that component. Remove all its CSS vars (Gate [5] flags any that remain). Remove all its CSS rules. Remove from `parity-map.mjs`, `EXPLICIT`, `COVERED`, and `figma-structure.snapshot.json`. Re-run bound walk to purge it from `bound-tokens.json`. Rebuild.

---

## End-of-Run Confidence Summary

After every run, report this table so the practitioner knows exactly what the audit guarantees:

| Area | Method | Confidence |
|---|---|---|
| Token values match Figma | Automated (Gate [2] — resolver against live snapshot) | High |
| All Figma tokens have a CSS var | Automated (Gate [4] — bound-check against frame walk) | High if frames configured; **not run** if `frames: []` |
| No unused CSS vars | Automated (Gate [5]) | High |
| No hardcoded values in rules | Automated (Gate [6]) | High |
| Structural parity (height, padding, gap) | Automated (Gate [3]) | High |
| Figma annotation acknowledgment + CSS verification | Automated (Gate [3g]) | High |
| Sub-component isolation | Automated (Gate [8]) | High |
| Build freshness | Automated (Gate [7]) | High |
| Removed tokens reconciled | Manual (Phase 1 diff) | Medium — verify any "used in a rule" replacements visually |
| Component states fully wired | Manual (Step 3 deep-walk) | Low if skipped; High if run |
| Visual regression | Automated (Gate [9], requires FIGMA_TOKEN) or Manual (Step 7 screenshots) | **Not run** if neither is configured |

Flag any row marked **not run** or **skipped** explicitly in the summary — do not imply full coverage.
