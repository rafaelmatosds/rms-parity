# /rms-figma-code-parity — Figma DS ↔ Code Parity

**What it does:** Audits whether the CSS codebase faithfully implements the DS Figma file.
Checks token values, alias chains, structure, bound tokens, unused vars, hardcoded values, build freshness, and more (17 gates). Outputs an HTML report with a gate summary banner and a per-dimension token table (Color / Sizing / Typography). Fix anything red before declaring parity.

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
- `visualRefScale` *(optional)* — PNG export scale for Gate [9] screenshots (default: `2`). Set to `3` for higher-fidelity references. Changing this value invalidates all stored refs — accept the new `.new.png` files with `mv *.new.png *.png` after the first run at the new scale.
- `knownUnimplementedComponents` — array of component names (matching keys in `structure-contract.mjs`) to exclude from Gate [3] and Gate [4] checks. Use this only as a temporary hold for DS components not yet built in code. Remove a component from this list as soon as its CSS and propertyMap are implemented. An empty array is the target state.
- `knownStateExemptions` *(optional)* — array of `{ var, selector, _note }` objects exempting a specific `var`+`selector` pair from Gate [17]. Use when a state-suffix var is intentionally used outside its state selector — component mirrors (one component reusing another's token), semantic reuse (hover bg repurposed as neutral tint), or non-obvious class naming (`:checked` = selected for radio buttons). Always include a `_note` explaining the intent.
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

Both are machine-generated — never hand-edit. `component-state-tokens.json` (project root, gitignored) is auto-generated on every `pnpm parity` run when `FIGMA_TOKEN` is set. `bound-tokens.json` is **committed** — it is refreshed via REST when available, or via Plugin API and committed manually when the REST API returns 403 (Professional plan).

**Audit history** is appended to `parity-history.json` at project root after every run. View trend: `node scripts/audit.mjs --trend`.

---

## How to Execute

| Phase | Step | Purpose | Must pass |
|---|---|---|---|
| **1** | **Figma Refresh** | **Query live Figma, diff snapshots, overwrite both files, verify resolvers** | **Snapshots fresh; every change reconciled** |
| **2** | **`node scripts/audit.mjs`** | **All 17 gates — snapshot auto-refreshed; bound tokens from REST or committed snapshot** | **0 ❌ gates** |
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
for(const st of styles){const key=st.name.trim().toLowerCase().split('/').pop();const entry={size:Math.round(st.fontSize*10)/10+'px'};const w=WEIGHT[st.fontName.style];if(w)entry.weight=String(w);if(st.lineHeight?.unit==='PIXELS')entry.lh=Math.round(st.lineHeight.value*10)/10+'px';if(st.letterSpacing?.value)entry.ls=(st.letterSpacing.unit==='PERCENT'?Math.round(st.letterSpacing.value*100)/10000+'em':Math.round(st.letterSpacing.value*100)/100+'px');if(st.textCase&&st.textCase!=='ORIGINAL')entry.textTransform=(st.textCase==='UPPER'?'uppercase':st.textCase==='LOWER'?'lowercase':st.textCase.toLowerCase());typo[key]=entry;}
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
for(const st of styles){const key=st.name.trim().toLowerCase().split('/').pop();const entry={size:Math.round(st.fontSize*10)/10+'px'};const w=WEIGHT[st.fontName.style];if(w)entry.weight=String(w);if(st.lineHeight?.unit==='PIXELS')entry.lh=Math.round(st.lineHeight.value*10)/10+'px';if(st.letterSpacing?.value)entry.ls=(st.letterSpacing.unit==='PERCENT'?Math.round(st.letterSpacing.value*100)/10000+'em':Math.round(st.letterSpacing.value*100)/100+'px');if(st.textCase&&st.textCase!=='ORIGINAL')entry.textTransform=(st.textCase==='UPPER'?'uppercase':st.textCase==='LOWER'?'lowercase':st.textCase.toLowerCase());typo[key]=entry;}
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

## Phase 1 — Step 1d: Capture effect styles → `effects` key in snapshot

Run this after Step 1b. Effect styles (drop shadow, inner shadow, blur) are captured into a top-level `"effects"` key in `figma-vars.snapshot.json`. Once populated, Gate [5] can flag any `box-shadow` not documented in `knownHardcodedExceptions` or a future `EFFECT_USAGES` contract.

```js
// Effect styles capture — always safe (effect list is always small)
const effectStyles=await figma.getLocalEffectStylesAsync();
const effects={};
function toHex(c){return '#'+[c.r,c.g,c.b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');}
for(const es of effectStyles){
  const efx=es.effects.filter(e=>e.visible!==false);
  if(!efx.length)continue;
  effects[es.name]=efx.map(e=>{
    if(e.type==='DROP_SHADOW'||e.type==='INNER_SHADOW'){
      const c=e.color;
      return{type:e.type.toLowerCase().replace('_','-'),x:e.offset.x,y:e.offset.y,blur:e.radius,spread:e.spread??0,color:toHex(c),opacity:Math.round(c.a*100)/100};
    }
    if(e.type==='LAYER_BLUR'||e.type==='BACKGROUND_BLUR')return{type:e.type.toLowerCase().replace('_','-'),blur:e.radius};
    return null;
  }).filter(Boolean);
}
return {effects};
```

Merge the returned `effects` into `figma-vars.snapshot.json` alongside `color`/`sizing`/`typography`. If the DS has no effect styles yet, `effects` will be `{}` — store it anyway so the key exists.

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

## Phase 2 — Bound token walk

`bound-tokens.json` is a **committed snapshot** — works on any Figma plan, including CI.

### Auto-refresh (Enterprise — REST API available)

`audit.mjs` regenerates it on every run automatically:
1. `GET /v1/files/{key}/variables/local` → variable ID → name map
2. For each frame in `ds-config.json frames[]`, `GET /v1/files/{key}/nodes?ids={nodeId}` → walks subtree, collecting every `boundVariables` reference

### Plugin API refresh (Professional plan — REST returns 403)

When the REST API returns 403, run this in Figma (via `use_figma` or the Plugin console), then save the output as `bound-tokens.json` and commit it:

```js
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const idToName = {};
for (const col of collections) {
  for (const id of col.variableIds) {
    const v = await figma.variables.getVariableByIdAsync(id);
    if (v) idToName[id] = v.name;
  }
}
function collectBound(node, out) {
  if (!node) return;
  const bv = node.boundVariables ?? {};
  for (const val of Object.values(bv)) {
    const entries = Array.isArray(val) ? val : [val];
    for (const e of entries) {
      if (e?.type === 'VARIABLE_ALIAS' && idToName[e.id]) out.add(idToName[e.id]);
    }
  }
  for (const child of node.children ?? []) collectBound(child, out);
}
// Frame node IDs from ds-config.json frames[]
const FRAME_IDS = ['308-10425', '42-210732', '106-36547']; // update per project
const tokenSet = new Set();
for (const id of FRAME_IDS) {
  const node = await figma.getNodeByIdAsync(id);
  if (node) collectBound(node, tokenSet);
}
return Object.fromEntries([...tokenSet].map(t => [t, true]));
```

Save the returned JSON as `bound-tokens.json` at project root and commit it. Run this whenever DS frames change significantly.

**If `bound-tokens.json` is missing entirely:** Gate [4] hard-fails. Generate it via one of the two methods above.

---

## Phase 2 — Step 2: Run all 17 audit gates

```bash
node scripts/audit.mjs
```

All 17 gates must pass. Gate [1] is always ✅ since Phase 1 just ran.

| Gate | Script | What it checks |
|---|---|---|
| [1]  | inline | **Freshness** — Snapshot files pulled today and compiled outputs not older than source. Always ✅ after Phase 1 runs. |
| [2]  | `parity-check.mjs` | **Token parity** — Every token across every mode matches Figma. NEW SKIP = token in Figma but no CSS var yet — treat as ❌. `⏳ PENDING FIGMA SYNC` when code matches the upstream DS source but the primary snapshot has a newer value (not a code bug). |
| [3]  | `structure-check.mjs` | **Structural parity** — Height, spacing, font, and radius all point to the right design tokens — no hardcodes, no gaps. Also enforces `childFramePadding` HTML structure: text-bearing buttons must wrap text in the required child element (e.g. `<span>`) so CSS padding applies. |
| [4]  | `bound-check.mjs` | **Bound-token coverage** — Every token actively used in the Figma frames has a CSS variable. |
| [5]  | inline | **CSS hygiene** — No declared-but-orphaned CSS vars (unused weight) and no raw literal values in CSS rules (hardcoded hex, px, etc.). Also scans for hand-drawn icons: a `data:image/svg+xml` CSS `background-image` with a literal or `%23`-encoded color is a hand-drawn icon bypassing the DS icon sprite (`<use href="#icon-X">`) and its `currentColor`/`var()` token binding — invisible to Gates [13]/[15] since it's a CSS string, not DOM markup. This pass runs across **all** files regardless of `gate6ExcludeDirs` (same as the viewport-unit anti-pattern pass), since hardcoded plugin-local icon colors are exactly the class of bug `gate6ExcludeDirs` would otherwise hide. Intentional exceptions (e.g. native `<select>` dropdown arrows, which can't host inline `<svg><use>` markup) go in `ds-config.json → knownHardcodedExceptions`. |
| [6]  | `subcomponent-isolation-check.mjs` | **Sub-component isolation** — Parent component styles don't bleed into nested DS sub-components. |
| [7]  | `visual-regression-check.mjs` | **Visual regression** — Live Figma frame screenshot matches the stored reference. Skips if `FIGMA_TOKEN` isn't set or no frames are configured. |
| [8]  | `state-check.mjs` `state-binding-check.mjs` `component-selector-check.mjs` | **State coverage** — Three checks in one: (a) all Figma component states have tokens in code (`state-check`); (b) every `CONTRACT.propertyMap` state selector exists in CSS (`state-binding-check`); (c) state-suffix vars (`-hover`, `-selected`, `-disabled`, `-focus`, `-checked`) only appear inside selectors with a matching state indicator — derived from standard CSS patterns and `CONTRACT.propertyMap` (`component-selector-check`). Intentional exceptions go in `ds-config.json → knownStateExemptions`. |
| [9]  | `exemption-check.mjs` | **Exemption validity** — Tokens marked as "skip this" are cross-checked against the snapshot. Stale exemptions (token renamed or removed) are flagged. |
| [10] | `mode-completeness-check.mjs` | **Mode completeness** — Every token meant to vary between modes actually does — light vs dark, compact vs comfortable, any DS mode. Nothing frozen at the same value where modes should differ. |
| [11] | `naming-check.mjs` | **CSS naming round-trip** — Every CSS variable name traces back to a real Figma token. Catches invented variables with no DS counterpart. |
| [12] | `pseudo-element-check.mjs` `icon-check.mjs` | **Contract coverage** — `::before`/`::after` elements must be declared in the structure contract. SVG `<symbol>` elements must be in `ICON_SYMBOLS`: DS icons with Figma node ID, plugin icons marked `PLUGIN-SPECIFIC`. Also verifies rotation wrapper (`transform`), render size (`size`), fill-only stroke guard (`strokeNone`), and stroke-based rendering guard (`strokeBased`). |
| [13] | `icon-slot-check.mjs` | **Icon slot parity** — Two-phase check: (1) every slot declared in `ICON_USAGES` (structure-contract.mjs) uses the exact DS icon specified — catches wrong icons in known slots; (2) **exhaustiveness scan** — every `<button id="X">` with a direct `<use href="#icon-">` child MUST be in `ICON_USAGES`, or the gate fails with "undeclared icon slot." Prevents a developer from adding a wrong-icon button and hiding it from the contract. |
| [14] | `component-slot-check.mjs` | **Component slot parity** — Two-phase check: (1) every slot declared in `COMPONENT_USAGES` uses the correct DS component class (`buttonTertiary`, `buttonPrimary`, etc.); (2) **exhaustiveness scan** — every `<button id="X">` carrying a primary/secondary/tertiary/quaternary class MUST be in `COMPONENT_USAGES`, or the gate fails with "undeclared DS component." Prevents an undeclared button from silently using the wrong component type. |
| [15] | `html-structure-check.mjs` | **HTML structure snapshot** — Fingerprint includes: element IDs, DS component classes on interactive elements, icon `<use href>` refs with context, and **button inner structure** (whether each id'd `<button>` has SVG, span children with their classes, and text content). The button-content dimension specifically catches spurious text labels added inside icon buttons (e.g. `<span class="tab-label">Tree</span>` widening a segmented control). Diffs against stored snapshot; any undeclared structural change is ❌. Accept: `node scripts/html-structure-check.mjs --accept`. |
| [16] | `transition-check.mjs` | **Transition contract** — Every selector in `TRANSITION_CONTRACT` (structure-contract.mjs) must have a CSS `transition:` declaration containing each documented part (duration, easing, property). Catches animation drift before Figma EASING/TIMING tokens exist. Update the contract when the DS spec changes. |
| [17] | `icon-freshness-check.mjs` | **Icon snapshot freshness** — For every DS icon in `figma-icons.snapshot.json` (those with a `nodeId`), fetches the live SVG from the Figma REST API and compares path data against the committed snapshot. Fails if any icon path changed in Figma since the last commit. Requires `FIGMA_TOKEN` (`file_content:read` scope); skipped if not set. Fix: update `figma-icons.snapshot.json` + the matching sprite in `ui-shared.js`, then re-run. |

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

## Gate [3h] — Surface container token enforcement

Verifies that every surface container in `SURFACE_CONTAINERS` declares `--area-bg: var(--bgVar)` in its CSS rule. This ensures components using `var(--area-bg, fallback)` automatically inherit the correct surface color without per-instance wiring.

Add to `structure-contract.mjs`:

```js
export const SURFACE_CONTAINERS = [
  { sel: '.main-panel',   bgVar: '--bg'        },
  { sel: '.detail-panel', bgVar: '--bg-detail'  },
];
```

`structure-check.mjs` Gate [3h] verifies that each listed selector has `--area-bg: var(--bgVar[...])` in its CSS block. Fails if missing or uses the wrong var.

**When to add an entry:** any time you add a new surface container (a wrapper that gives components a distinct background context).

---

## Gate [3i] — Button class-base rules

Catches icon-only buttons (and other modifier-class buttons) using the wrong DS base class. The classic failure: a ghost icon button that should be `.buttonQuaternary` is coded as `.buttonTertiary.buttonUnpair`, giving it a visible border on hover.

**How it works:** Gate [3i] scans every plugin HTML source file for `<button>` elements whose class list includes a _modifier class_ defined in `BUTTON_CLASS_RULES`. For each match, it checks that at least one of the `allowedBases` classes is also present. If not, it fails with the file path and full class string.

```js
// structure-contract.mjs
export const BUTTON_CLASS_RULES = [
  // modifier: class that triggers the check
  // allowedBases: at least one must appear on the same <button>
  { modifier: 'buttonUnpair', allowedBases: ['buttonQuaternary'] },
];
```

**When to add an entry:** any time you introduce a modifier class that must only combine with specific base DS component classes. The gate is project-agnostic — `BUTTON_CLASS_RULES` in the consuming project's `structure-contract.mjs` drives the check.

---

## Gate [3g] — Inverse annotation check (WARN)

In addition to the Figma→Contract direction (annotation must be acknowledged), Gate [3g] also warns in the **Contract→Figma** direction: if a `propertyMap` entry maps a CSS selector but no Figma annotation covers that property name, a `⚠️ WARN` is emitted.

This is a warning, not a failure — it does not block the audit. Its purpose: surface documentation gaps and create pressure to add Figma annotations for behavioral CSS you've already implemented.

**To silence a warn:** add a Figma annotation to the component set explaining why the behavior exists.

---

## Phase 2 — State walk (auto, enables Gates [3c] + [10])

**No manual step needed.** `audit.mjs` auto-generates two files by walking every COMPONENT_SET:

### `component-state-tokens.json` — flat count map (Gate [10])

`{ "token/name": count }` — every token found in any variant state. Gate [10] (`state-check.mjs`) reads this and verifies all captured tokens have CSS vars.

**If the auto-refresh fails** (no `FIGMA_TOKEN`): Gate [10] uses whatever exists. If missing, Gate [10] hard-fails (exit 2).

> **Important:** must be a plain `{ "token/name": count }` object. Any `_`-prefixed key will be treated as an uncovered token and fail Gate [10].

### `component-state-bindings.json` — structured binding map (Gate [3c] auto-derivation)

```json
{ "ButtonPrimary": { "State=Default": { "props": { "state": "default" }, "bindings": [
  { "token": "buttonPrimary/background/color", "bindingField": "fills", "isText": false, "depth": 0 },
  { "token": "buttonPrimary/text/color",       "bindingField": "fills", "isText": true,  "depth": 1 }
] } } }
```

Gate [3c] auto-derives CSS var assertions using **naming convention** — no `CONTRACT.propertyMap` dependency:

- **Component name → CSS selector:** lowercase the first letter of the Figma component set name (e.g. `"ButtonSecondary"` → `.buttonSecondary`). Override per-component via `ds-config.json → componentSelectors` for non-convention selectors (e.g. `"Input": ".inputWrap"`, `"Tooltip": "#tt"`).
- **Variant props → CSS modifier:** `state=hover` → `:hover`, `state=focus` → `:focus`, `state=active`/`pressed` → `:active`, `state=focus-within` → `:focus-within`, `state=default`/any `=false` → base selector. Unknown values (e.g. `"negative"`, `"selected"`, `"true"`) → variant skipped, no assertion generated.

Only standard, universally-derivable states are mapped — no false positives for project-specific state semantics. Manual `CSS_BASE_RULE_VARS` entries handle non-standard states (badge severity levels, toast loading/success, etc.).

Coverage:

| Figma binding | Node type | Auto-derived CSS assertion |
|---|---|---|
| `fills` | Root frame | `background: var(--token-var)` |
| `strokes` | Root frame | `border-color: var(--token-var)` (with `border:` shorthand fallback) |
| `fills` | Direct TEXT child | `color: var(--token-var)` |

Manual `CSS_BASE_RULE_VARS` entries always override auto-derived for the same `selector+prop`. Use them for edge cases: shorthand combiners, deeply-nested selectors, or explicit exception overrides.

**If the auto-refresh fails** (REST API 403 / no `FIGMA_TOKEN`): Gate [3c] falls back to manual `CSS_BASE_RULE_VARS` only. No gate noise — the count just shows `(N manual)` instead of `(N auto-derived · M manual)`.

**Plugin API fallback** — when REST API is plan-limited, run this in Figma (via `use_figma` or Plugin console), save the output as `component-state-bindings.json` at project root (gitignored):

```js
const idToVar = {};
const allVars = await figma.variables.getLocalVariablesAsync();
for (const v of allVars) idToVar[v.id] = v;

function getBindings(node, maxDepth = 1, depth = 0) {
  if (depth > maxDepth) return [];
  const isText = node.type === 'TEXT';
  const result = [];
  for (const field of ['fills', 'strokes']) {
    const refs = Array.isArray(node.boundVariables?.[field])
      ? node.boundVariables[field]
      : node.boundVariables?.[field] ? [node.boundVariables[field]] : [];
    for (const r of refs) {
      const v = idToVar[r?.id];
      if (v) result.push({ token: v.name, bindingField: field, isText, depth });
    }
  }
  if ('children' in node) {
    for (const child of node.children) result.push(...getBindings(child, maxDepth, depth + 1));
  }
  return result;
}

const result = {};
const sets = figma.root.findAll(n => n.type === 'COMPONENT_SET');
for (const set of sets) {
  const variants = {};
  for (const variant of set.children) {
    if (variant.type !== 'COMPONENT') continue;
    const props = {};
    for (const part of (variant.name ?? '').split(',')) {
      const eq = part.indexOf('=');
      if (eq !== -1) props[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().toLowerCase();
    }
    const bindings = getBindings(variant, 1, 0);
    if (bindings.length) variants[variant.name] = { props, bindings };
  }
  if (Object.keys(variants).length) result[set.name] = variants;
}
return JSON.stringify(result, null, 2);
```

---

## Phase 2 — Steps 3–10: When are manual steps required?

| Condition | Steps 3–10 |
|---|---|
| All 17 gates pass AND Phase 1 found no new tokens | **Spot-check** — sample 1–2 components per run; full walk not required |
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

**Adding a new component to the contract:** when a component graduates from `knownUnimplementedComponents` to a real contract entry, the contract and the `figma-structure.snapshot.json` must declare the **exact same set of structural fields** (`h`, `gapVar`, `paddingVar`, `fontSizeVar`, `fontWeightVar`, `fillStructure`, `innerInset`, `innerRadiusVar`, `strokeOnDefault`, `strokeOnAnyState`). Gate [3] compares them field-by-field — a field present in the snapshot but absent (`undefined`) in the contract is a divergence even if both values would be `null`. Always include all structural fields in the contract explicitly, setting unknown/inapplicable ones to `null`.

**After adding structural fields, wire up CSS enforcement — or the fields are documentation only.** Gate [3] verifies that the contract and snapshot agree with each other, but it does NOT automatically verify that the CSS implements those values. You must explicitly wire each structural fact into a CSS check:

1. **`CSS_HEIGHT_RULES`** — for every component where `h` is a fixed number (not `null` or `'auto'`), add an entry:
   ```js
   export const CSS_HEIGHT_RULES = {
     myComponent: { selector: '.myComponent', prop: 'height' },   // h is fixed
     myOther:     { selector: '.myOther',     prop: 'min-height' }, // h is a minimum
   };
   ```
   Gate [3] verifies the declared selector has a `height`/`min-height` rule that uses the right token var (via `FIGMA_LAYOUT_TO_CSS`). A component with `h: 24` in the snapshot but no `CSS_HEIGHT_RULES` entry means Gate [3] will never catch a CSS height regression.

2. **`COMPONENT_CSS_SELECTORS`** — for every component in `CSS_HEIGHT_RULES`, add a matching entry so Gate [3] knows which CSS selector to check for padding, gap, and radius:
   ```js
   export const COMPONENT_CSS_SELECTORS = {
     myComponent: { main: '.myComponent' },
   };
   ```
   Without this, Gate [3] skips padding and gap binding checks for the component entirely.

3. **`CSS_PROPERTY_ASSERTIONS`** — use this for any structural constraint that Gate [3] cannot auto-verify from the root binding alone. Common cases:
   - `gapVar` or `paddingVar` that is bound on a **child frame** (not the root) — the snapshot records `null` but CSS must still use the right var
   - `innerRadiusVar` — verify `border-radius` on the right selector uses the correct var
   - Explicit value checks (`expected: '40px'`) when Figma doesn't use a variable but the DS still mandates a specific value
   ```js
   { sel: '.myComponent', prop: 'gap',           expectedVar: '--gap-s'       },
   { sel: '.myComponent', prop: 'border-radius', expectedVar: '--radius-full' },
   { sel: '.myComponent', prop: 'height',        expected:    '24px'          },
   ```

**Checklist for every new contract entry:**
- [ ] All structural fields in contract match snapshot (Gate [3a])
- [ ] `CSS_HEIGHT_RULES` entry if `h` is a fixed number
- [ ] `COMPONENT_CSS_SELECTORS` entry (required for padding/gap/radius checks)
- [ ] `CSS_PROPERTY_ASSERTIONS` for any padding/gap/radius/height that isn't auto-verifiable from the root binding
- [ ] `propertyMap` for every Figma variant/state property
- [ ] Run `node scripts/structure-check.mjs` and confirm ✅ PASS X/X (X = total contract count)

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

## CI Setup

To run parity on every PR/push via GitHub Actions, add `.github/workflows/parity.yml` to your project:

```yaml
name: Parity
on:
  push:
    branches: [main]
  pull_request:
jobs:
  parity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with:
          version: 9
      - run: pnpm install
      - run: pnpm parity
        env:
          FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}
          FIGMA_FILE_KEY: ${{ vars.FIGMA_FILE_KEY }}
```

**Prerequisites:**
- `ds-config.json` must be **committed** (it contains no secrets — only paths and the public Figma file key). If it's in `.gitignore`, CI will fail immediately with a clear message.
- `structure-contract.mjs` must be committed (it's safe to commit — no secrets).
- `FIGMA_TOKEN` must be added to GitHub Secrets.
- `FIGMA_FILE_KEY` can optionally be set as a GitHub Variable (used for logging context; `ds-config.json` is the actual source).

With `FIGMA_TOKEN` set, `pnpm parity` is fully self-contained: it auto-refreshes all snapshots, bound tokens, and state tokens via the Figma REST API. No Plugin API / MCP step needed.

---

## Gate [15] — SVG symbol audit

Every `<symbol>` element in any plugin HTML file must be declared in `ICON_SYMBOLS` in `structure-contract.mjs`. Undocumented symbols fail the gate.

**DS icons** must record the Figma node ID so the path is traceable back to source. Always fetch the path from Figma via MCP (`get_design_context` + `curl` the asset URL) — never hand-draw.

**Plugin-specific icons** must be marked `PLUGIN-SPECIFIC` with a description of their visual purpose.

```js
// structure-contract.mjs
export const ICON_SYMBOLS = {
  // DS icon — string form (no transform required)
  'icon-close': 'DS ICON — Icon/Close node 123-456; X mark',

  // DS icon — fill-based with transform + size + strokeNone guard
  'icon-fit':  { desc: 'DS ICON — Icon/Fit node 149-101965; four outward-pointing arrows', transform: 'rotate(-45 7.081 7.081)', size: 16, strokeNone: true },
  // DS icon — stroke-based with size + strokeBased guard
  'icon-info': { desc: 'DS ICON — Icon/Info node 67-46370; stroke circle with "i" mark', size: 12, strokeBased: true },

  // Plugin-specific — custom icon with no DS backing
  'icon-type-text': 'PLUGIN-SPECIFIC — Figma "T" text node type indicator; issue list',
};
```

**Object form:** use `{ desc, transform?, size?, strokeNone?, strokeBased? }` for DS icons that require additional checks:

- **`transform`** — when the Figma component wraps the SVG path in a rotation (visible as `-rotate-X` in the Figma component code). The gate verifies a `<g transform="...">` with that exact value is present inside the `<symbol>`. Prevents correct path + wrong orientation.
- **`size`** — the DS-specified icon container size in pixels (e.g. `16`). The gate finds every `<svg width="N" height="N"><use href="#id">` in HTML files and verifies `N === size`. Catches icons rendered at the wrong pixel dimensions.
- **`strokeNone: true`** — for fill-only DS icons that appear inside contexts with broad CSS stroke rules (e.g. `.buttonTertiary svg { stroke: var(--buttonTertiary-text) }`). The gate verifies the symbol body contains `stroke="none"` on a shape element. Without this, the CSS-inherited stroke adds unintended visual weight, making the icon appears thicker in button contexts than in other contexts (overlay labels, etc.).
- **`strokeBased: true`** — for stroke-only DS icons (circle outlines, line icons). The gate verifies the `<symbol>` tag itself has `fill="none"`. Without this, replacing the stroke icon with a fill-based SVG would pass all size and color checks while looking completely different (hollow circle vs filled circle). Use this for any DS icon whose Figma BOOLEAN_OPERATION or path uses stroke rendering, not fill.

**When the gate fails:**
- Undocumented symbol → fetch from Figma, add contract entry
- Missing transform → wrap `<path>` in `<g transform="...">` matching the contract value
- Wrong render size → update the `<svg width="N" height="N">` wrapping `<use href="#id">` to match the contract `size`
- Missing stroke guard → add `stroke="none"` to the `<path>` inside the symbol
- Not stroke-based → add `fill="none"` to the `<symbol ...>` opening tag and use stroke rendering

**Every new implementation edge case must add a gate check** — fix the code AND extend the contract/gate so the same mistake cannot recur silently.

**Never add a `DS ICON` entry without verifying the path came from Figma** — that would defeat the purpose of the gate.

---

## End-of-Run Confidence Summary

After every run, report this table so the practitioner knows exactly what the audit guarantees:

| Area | Method | Confidence |
|---|---|---|
| Token values match Figma | Automated (Gate [2] — resolver against live snapshot) | High |
| All Figma tokens have a CSS var | Automated (Gate [4] — bound-check against frame walk, auto-refreshed) | High if frames configured; **not run** if `frames: []` |
| All state tokens wired | Automated (Gate [10] — state walk, auto-refreshed) | High |
| No unused CSS vars | Automated (Gate [5]) | High |
| No hardcoded values in rules | Automated (Gate [6]) | High |
| Structural parity (height, padding, gap) | Automated (Gate [3]) | High |
| Figma annotation acknowledgment + CSS verification | Automated (Gate [3g]) | High |
| Surface container --area-bg declarations | Automated (Gate [3h]) | High if SURFACE_CONTAINERS populated |
| Button modifier-class base compliance | Automated (Gate [3i]) | High if BUTTON_CLASS_RULES populated |
| Sub-component isolation | Automated (Gate [8]) | High |
| Build freshness | Automated (Gate [7]) | High |
| Removed tokens reconciled | Manual (Phase 1 diff) | Medium — verify any "used in a rule" replacements visually |
| Component states fully wired | Automated (Gate [10]) | High |
| SVG symbols sourced from DS | Automated (Gate [12] — ICON_SYMBOLS contract) | High if all symbols documented |
| DS icon paths match live Figma | Automated (Gate [17] — icon-freshness-check, requires FIGMA_TOKEN) | High — catches path drift in Figma before code is updated |
| Visual regression | Automated (Gate [9], requires FIGMA_TOKEN) or Manual (Step 7 screenshots) | **Not run** if neither is configured |
| CI enforcement | GitHub Actions (`.github/workflows/parity.yml`) | High if configured |

Flag any row marked **not run** or **skipped** explicitly in the summary — do not imply full coverage.
