# /rms-parity — Figma DS ↔ Code Parity

Full parity workflow in one command. Phase 1 (live Figma refresh) always runs before Phase 2 (code audit) — you can never accidentally audit against a stale snapshot.

> **Phase 1 is never skipped** — unless you ran `/rms-parity` earlier in this same conversation and the snapshot was updated then. A same-day snapshot from a *prior session or context window* is not safe — renames and additions since that run would be invisible without a fresh query. If you are resuming after a context summary, compaction, or a new conversation, always re-query.

## Usage

```
/rms-parity
```

**Utility flags (no full audit — just run the script directly):**
```bash
node scripts/audit.mjs --trend          # show last 20 audit runs + pass/fail trend
node scripts/parity-check.mjs --fix     # auto-fix sizing/typography divergences in theme.css
node scripts/setup-webhook.mjs --list   # list registered Figma webhooks for this file
```

---

## Project Config

At the start of every run, read `./ds-config.json` from the project root.

**If it doesn't exist**, ask the user for exactly four things — nothing else:

1. **Figma file URL** — the full browser URL of the Figma file (e.g. `https://www.figma.com/design/abc123/My-DS`). Extract the file key from the URL: it's the path segment after `/design/` or `/file/`. Never ask for the raw key — accept the URL and parse it.
2. **Theme CSS path** — the path to `theme.css` relative to the project root (e.g. `packages/ui/src/theme.css`). If you can find exactly one `theme.css` in the project by scanning common locations (`packages/`, `src/`, `app/`), show it as the default and let the user confirm with Enter.
3. **DS frame node IDs** *(optional but recommended)* — the Figma node IDs of the top-level plugin/screen frames that are the live DS designs (e.g. `308-10425`). Find them from the frame's Figma URL (`node-id=308-10425`). Ask for each frame's name and ID. If the user skips this, set `frames: []` and warn: **⚠️ Gates [4] and [9] will not run until frame IDs are added to `ds-config.json → frames`.**
4. **Figma personal access token** *(optional)* — needed for Gate [9] visual regression screenshots. Get it from Figma → Account settings → Personal access tokens → Generate new token (requires "File content" read scope). If the user skips this, warn: **⚠️ Gate [9] will not run until `FIGMA_TOKEN` is set in `.env`.** Never store the token in `ds-config.json` — write it to `.env` at the project root instead.

Then auto-detect and write `ds-config.json`:
- `snapshotVars` / `snapshotStructure` → sibling files next to theme CSS
- `pluginCSS` → scan `apps/*/ui.src.html` and `src/ui.src.html`
- `plugins` → derived from pluginCSS paths
- `figma.colorCollection` → `"Color"` (default, user can edit later)
- `figma.sizingCollection` → `"Sizing"` (default)
- `figma.primitivePrefix` → `"primitives/"` (default)
- `figma.modes` → Light (`:root`) + Dark (`dark-media`) (default)
- `frames` → from user input, or `[]` if skipped

If the user provided a token, write `FIGMA_TOKEN=<token>` to `.env` at the project root.

Write `ds-config.json` to the project root. Also append `ds-config.json`, `parity-map.mjs`, `structure-contract.mjs`, `.env` to `.gitignore` if not already present. Then continue the audit immediately — do not stop.

Once `ds-config.json` exists, extract:
- `figmaFileKey` — Figma file key
- `frames` — array of `{ name, nodeId }` — the DS frame(s) to audit
- `figma.colorCollection` — name of the color variable collection (e.g. `"Color"`)
- `figma.sizingCollection` — name of the sizing collection, if any (e.g. `"Sizing"`)
- `figma.modes` — array of `{ name, snapshotKey, cssSelector }` defining all DS modes
  - OR legacy: `figma.darkMode` / `figma.lightMode` (two-mode shorthand)
- `figma.primitivePrefix` — token path prefix to exclude from component token walks (e.g. `"primitives/"`)
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
- **Token naming convention:** `token/path/default` → `--token-path` (drop `/default`, `/color`; `/` → `-`). Any additional shortenings are documented in `parity-map.mjs`.
- **Primitive scale:** document your DS's primitive tokens in `parity-map.mjs` under `NEUTRAL_LIGHT` / `NEUTRAL_DARK` (two modes) or `NEUTRAL_MAPS` (three or more modes) so the resolver can follow alias chains automatically.
- **Snapshot files** at paths defined in `ds-config.json`.

---

## Hard Rules

1. **Every Figma component token must have a dedicated CSS variable.** No token may be covered only by an inline value. `via` is acceptable only when a semantic alias is documented in `parity-map.mjs`.
2. **Every CSS variable must be wired into at least one CSS rule.** A declared-but-unused var must be deleted. Variables are declared when the component exists in code, not before.
3. **Naming convention must be followed exactly.** A correct value under a wrong name is still a divergence.
4. **All modes must match.** A token correct in dark but wrong in light is still a divergence.
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
| **2** | **`node scripts/audit.mjs`** | **All 9 gates — Gate [1] always ✅ since Phase 1 just ran** | **0 ❌ gates** |
| 2 | Component walk | Deep per-component inspection of all states, vars, tokens | 0 new divergences |
| 2 | Master Token Table | Single source of truth with resolved hex for every token | 0 ❌ rows |

---

# PHASE 1 — Figma Refresh

---

## Phase 1 — Step 1: Query live Figma values

Use collection/mode names from `ds-config.json`. Build the color output for **every configured mode** (not just light/dark):

```js
function toHex(c) {
  return '#' + [c.r,c.g,c.b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');
}
const collections = await figma.variables.getLocalVariableCollectionsAsync();
const idToVar = {};
for (const col of collections) {
  for (const id of col.variableIds) {
    const v = await figma.variables.getVariableByIdAsync(id); if (v) idToVar[id] = v;
  }
}
function resolveInMode(varId, modeId, depth=0) {
  if (depth > 10) return { hex: null };
  const v = idToVar[varId]; if (!v) return { hex: null };
  const val = v.valuesByMode[modeId] ?? Object.values(v.valuesByMode)[0];
  if (!val) return { hex: null };
  if (typeof val === 'object' && val.type === 'VARIABLE_ALIAS') return resolveInMode(val.id, modeId, depth + 1);
  if (typeof val === 'object' && 'r' in val) return { hex: toHex(val) };
  return { hex: String(val) };
}

// Read from ds-config.json:
const COLOR_COLLECTION  = 'YOUR_COLOR_COLLECTION';   // figma.colorCollection
const SIZING_COLLECTION = 'YOUR_SIZING_COLLECTION';  // figma.sizingCollection (or null)
const PRIMITIVE_PREFIX  = 'YOUR_PRIMITIVE_PREFIX';   // figma.primitivePrefix
// figma.modes = [{ name, snapshotKey, cssSelector }]
// Build mode lookup: snapshotKey → Figma modeId
const MODES = [/* from ds-config.json figma.modes */];

// Capture full alias chain: token → [hop1, hop2, ..., "primitives/X"]
// parity-check.mjs uses this to verify the CSS var() chain routes through
// the SAME primitives in the SAME order as Figma (Gate [2] ALIAS FAIL check).
function getAliasChain(varId, modeId, depth=0) {
  if (depth > 10) return [];
  const v = idToVar[varId]; if (!v) return [];
  const val = v.valuesByMode[modeId] ?? Object.values(v.valuesByMode)[0];
  if (!val || typeof val !== 'object' || val.type !== 'VARIABLE_ALIAS') return [];
  const aliasedVar = idToVar[val.id]; if (!aliasedVar) return [];
  return [aliasedVar.name, ...getAliasChain(val.id, modeId, depth + 1)];
}

const col = collections.find(c => c.name === COLOR_COLLECTION);
const colorOut = {};
const aliasesOut = {};  // full alias chain per token per mode — arrays like ["semantic/negative", "primitives/red"]
for (const m of MODES) {
  const modeId = col.modes.find(fm => fm.name === m.name)?.modeId;
  if (!modeId) continue;
  colorOut[m.snapshotKey]  = {};
  aliasesOut[m.snapshotKey] = {};
  for (const id of col.variableIds) {
    const v = idToVar[id];
    if (!v || v.resolvedType !== 'COLOR' || v.name.startsWith(PRIMITIVE_PREFIX)) continue;
    colorOut[m.snapshotKey][v.name] = resolveInMode(id, modeId).hex;
    const chain = getAliasChain(id, modeId);
    if (chain.length > 0) aliasesOut[m.snapshotKey][v.name] = chain;
  }
}

const sizingOut = {};
if (SIZING_COLLECTION) {
  const sizingCol = collections.find(c => c.name === SIZING_COLLECTION);
  if (sizingCol) {
    const modeId = sizingCol.modes[0].modeId;
    for (const id of sizingCol.variableIds) {
      const v = idToVar[id]; if (!v) continue;
      // Follow VARIABLE_ALIAS chains — sizing vars can alias each other (e.g. radii/button → radii/input).
      // Without this, aliased vars return [object Object] and silently corrupt the snapshot.
      let val = v.valuesByMode[modeId] ?? Object.values(v.valuesByMode)[0];
      let depth = 0;
      while (typeof val === 'object' && val?.type === 'VARIABLE_ALIAS' && depth++ < 10) {
        const aliased = idToVar[val.id];
        val = aliased?.valuesByMode[modeId] ?? Object.values(aliased?.valuesByMode ?? {})[0];
      }
      sizingOut[v.name] = typeof val === 'number' ? val + 'px' : String(val ?? '');
    }
  }
}

// Typography — capture ALL local text styles, keyed by last path segment
const WEIGHT = {'Thin':100,'Extra Light':200,'Light':300,'Regular':400,'Medium':500,'Semi Bold':600,'Bold':700,'Extra Bold':800,'Black':900};
const styles = await figma.getLocalTextStylesAsync();
const typo = {};
for (const st of styles) {
  const key = st.name.trim().toLowerCase().split('/').pop();
  const entry = { size: Math.round(st.fontSize * 10) / 10 + 'px' };
  const w = WEIGHT[st.fontName.style]; if (w) entry.weight = String(w);
  if (st.lineHeight?.unit === 'PIXELS') entry.lh = Math.round(st.lineHeight.value * 10) / 10 + 'px';
  typo[key] = entry;
}
return { color: colorOut, aliases: aliasesOut, sizing: sizingOut, typography: typo };
```

> Fill in the config constants from `ds-config.json`. The snapshot `color` object now has one key per mode (`snapshotKey`), e.g. `{ light: {...}, dark: {...}, "high-contrast": {...} }`.

---

## Phase 1 — Step 1c: Capture component structure → `figma-structure.snapshot.json`

Navigate to your DS Components page, find each `COMPONENT_SET`, navigate to the `State=Default` child (never the SET — its height equals all variants stacked), and extract structural facts:

```js
// Extract: h, paddingVar {tb,lr}, gapVar, fontSizeVar, fontWeightVar,
//          fillStructure ('direct' | 'before' | 'none'), innerRadiusVar, strokeOnDefault
// fillStructure = 'before' when fill is on a child "Background" rect (→ CSS ::before)
//                 'direct' when on the frame itself
//                 'none' when default state has no fill
// strokeOnDefault = node.strokes?.length > 0 on the State=Default variant
```

Write the result in this shape:
```json
{
  "_updated": "YYYY-MM-DD",
  "_note": "Auto-generated by /rms-parity. Do not edit manually.",
  "components": {
    "button": { "h": 32, "paddingVar": { "tb": "padding/s", "lr": "padding/m" }, "gapVar": "gap/s" }
  }
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

## Phase 2 — Step 2: Run all 10 audit gates

```bash
node scripts/audit.mjs
```

All 10 gates must pass. Gate [1] is always ✅ since Phase 1 just ran.

| Gate | What it catches |
|---|---|
| [1] | Snapshot freshness — always ✅ after Phase 1 |
| [2] | Token value parity — color (all modes) + sizing + typography. NEW SKIP = missing CSS var — treat as ❌ |
| [3] | Structural parity — height · padding/gap/font/radius per-rule var bindings · fill structure · stroke |
| [4] | Bound-token coverage — token used in Figma but no CSS var |
| [5] | Unused CSS vars (Hard Rule #2) |
| [6] | Hardcoded values in CSS rules (Hard Rule #5) |
| [7] | Build freshness — source newer than built output |
| [8] | Sub-component isolation (Hard Rule #8) |
| [9] | Effect token coverage — shadow/blur tokens have CSS vars (skips if no `effects` in snapshot) |
| [10] | State completeness — all COMPONENT_SET states covered (skips if `component-state-tokens.json` missing) |

**Gate [2] fix mode:** if Gate [2] fails on sizing/typography values only, run `node scripts/parity-check.mjs --fix` to auto-apply the correct values to `theme.css`, then re-run the audit.

**History:** every run appends to `parity-history.json`. View trend: `node scripts/audit.mjs --trend`.

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
| Sub-component isolation | Automated (Gate [8]) | High |
| Build freshness | Automated (Gate [7]) | High |
| Removed tokens reconciled | Manual (Phase 1 diff) | Medium — verify any "used in a rule" replacements visually |
| Component states fully wired | Manual (Step 3 deep-walk) | Low if skipped; High if run |
| Visual regression | Automated (Gate [9], requires FIGMA_TOKEN) or Manual (Step 7 screenshots) | **Not run** if neither is configured |

Flag any row marked **not run** or **skipped** explicitly in the summary — do not imply full coverage.
