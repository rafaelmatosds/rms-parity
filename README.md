# rms-parity

A Claude Code skill + automated scripts for continuous Figma DS ↔ CSS code parity auditing.

Invoke `/rms-parity` in any project to run a full parity check: Phase 1 refreshes the live Figma snapshot, Phase 2 runs 14 automated gates. You can never accidentally audit against a stale snapshot.

---

## What it does

| Phase | What happens |
|---|---|
| **1 — Figma Refresh** | Queries live Figma (color, sizing, typography, component structure), diffs against stored snapshots, reports changes, writes updated snapshots, verifies resolvers pass |
| **2 — Code Parity** | Runs all 14 automated gates, component deep-walk, Master Token Table |

**14 automated gates:**

| Gate | Script | What it checks |
|---|---|---|
| [1]  | inline | **Is the data fresh?** Confirms the Figma snapshot was pulled today — so you're never auditing against yesterday's design. |
| [2]  | `parity-check.mjs` | **Do the colors, sizes, and fonts match Figma?** Compares every design token value (light mode, dark mode, all modes) against what's in the code. Flags mismatches, missing variables, and wrong alias chains. If the Figma file is a consumer of a library that hasn't been updated yet, marks those as ⏳ instead of ❌. |
| [3]  | `structure-check.mjs` | **Does the component look the way Figma says it should?** Checks that each component's height, spacing, font, and radius are all wired to the right design tokens — not hardcoded, not missing. |
| [4]  | `bound-check.mjs` | **Is anything in the design that isn't in the code?** Walks every Figma frame and finds tokens that are actively used in the design but have no matching CSS variable in the codebase. |
| [5]  | inline | **Are there CSS variables nobody's using?** Finds variables that are declared but never actually applied anywhere — dead weight that should be cleaned up. |
| [6]  | inline | **Are there raw values that should be tokens?** Catches any hardcoded color, size, spacing, or radius written directly into a CSS rule instead of using a design token variable. |
| [7]  | inline | **Is the built output up to date?** Makes sure the compiled files aren't older than the source — catches cases where you edited the source but forgot to rebuild. |
| [8]  | `subcomponent-isolation-check.mjs` | **Is a parent component accidentally overriding a child component's styles?** When one DS component lives inside another, their styles must not bleed into each other. This catches parent rules that silently clobber a child's design tokens. |
| [9]  | `visual-regression-check.mjs` | **Does it still look the same?** Takes a screenshot of the live Figma frame and compares it against the last accepted reference image. Flags any visual drift. Skips if no Figma token is configured. |
| [10] | `state-check.mjs` | **Are all component states covered?** Makes sure every interactive state defined in Figma (hover, pressed, disabled, selected…) has a corresponding token in the code. |
| [11] | `exemption-check.mjs` | **Are the documented exceptions still valid?** Any tokens manually marked as "skip this" are cross-checked against the current snapshot — if the token no longer exists or has changed, the exemption is flagged as stale. |
| [12] | `mode-completeness-check.mjs` | **Do all modes actually adapt?** Verifies that every token that's supposed to change between modes actually does — whether that's light vs dark, compact vs comfortable spacing, or any other mode your DS defines. Nothing should be accidentally stuck at the same value across modes that are meant to differ. |
| [13] | `naming-check.mjs` | **Do all CSS variable names trace back to a real Figma token?** Makes sure nobody invented a CSS variable that has no counterpart in the design system. |
| [14] | `pseudo-element-check.mjs` | **Are decorative `::before` / `::after` elements documented?** Any visual element added via CSS pseudo-elements must be declared in the component's structure contract so it doesn't silently drift from the design. |

**Everything is read-only.** No source file is ever modified automatically. The only exception is `node scripts/parity-check.mjs --fix`, which must be invoked explicitly and only rewrites sizing/typography literal values.

---

## Example output

```
────────────────────────────────────────────────────────────
  PARITY AUDIT  ·  2026-06-17
────────────────────────────────────────────────────────────

✅  [1] Snapshot freshness
       src/figma-vars.snapshot.json ✓ (updated today)
       src/figma-structure.snapshot.json ✓ (updated today)
       bound-tokens.json ✓ (2h old)

❌  [2] Token parity  (color · sizing · typography)
       ✅ PASS  87   (color + sizing + typography)
       ❌ FAIL  2
         ❌ [color/Dark] buttonPrimary/background → --buttonPrimary-background
              Figma: #ededed   CSS: #d4d4d4
              Fix:  theme.css:42 — --buttonPrimary-background: var(--neutral-200) should resolve to var(--neutral-100) (#ededed)
         ❌ [sizing/-] gap/m → --gap-m
              Figma: 10px   CSS: 8px
              Fix:  theme.css:15 — change --gap-m: 8px → 10px

✅  [3] Structure     (snapshot · CSS height · base-rule vars)
       ✅ PASS 7/7 components

✅  [4] Bound-token coverage  (DS frames → CSS vars)
       ✅ COVERED 43   ❌ UNCOVERED 0

✅  [5] Unused CSS vars
       ✅ 0 unused vars  (3 known-unused exempted)

✅  [6] Hardcoded values  (no raw hex / font-size in rules)
       ✅ Clean

⏭  [7] Build freshness  (source ≤ built output)
       ⏭ No plugins configured in ds-config.json — skipped

✅  [8] Sub-component isolation  (no parent rule overrides sub-component styles)
       ✅ No new undocumented rules

⏭  [9] Visual regression  (frames match stored references)
       ⏭ FIGMA_TOKEN not set — skipped (set env var to enable)

✅  [10] State completeness  (all COMPONENT_SET states covered)
       ✅ COVERED 12   UNCOVERED 0

✅  [11] Exemption validity  (EXPLICIT · SKIP_TOKENS · COVERED not stale)
       ✅ VALID 8   STALE 0

✅  [12] Dark mode completeness  (all mode-variant tokens adapt)
       ✅ ADAPTS 31   STATIC 0

✅  [13] CSS naming round-trip  (every var traceable to a Figma token)
       ✅ TRACEABLE 90   UNINVENTED 0

────────────────────────────────────────────────────────────

  AUDIT FAILED — fix all ❌ above before declaring parity

────────────────────────────────────────────────────────────
```

When all gates pass:

```
────────────────────────────────────────────────────────────

  ALL GATES PASS ✅

────────────────────────────────────────────────────────────
```

**Trend view** (`node scripts/audit.mjs --trend`):

```
─── Parity Trend ───────────────────────────────────────────
  ✅  2026-06-15  14/14 [██████████████]
  ❌  2026-06-16  11/13 [████████████░░]
  ✅  2026-06-17  14/14 [██████████████]
────────────────────────────────────────────────────────────
```

---

## Utility flags

```bash
node scripts/audit.mjs --init            # first-time setup only: scaffold config files, then exit
node scripts/audit.mjs --trend           # show last 20 audit runs + trend bar
node scripts/parity-check.mjs --fix      # auto-fix sizing/typography divergences in theme.css
node scripts/setup-webhook.mjs --list    # list registered Figma webhooks for this file
node scripts/setup-webhook.mjs --delete <id>
```

---

## Setup for a new project

### 1. Add as submodule

```bash
git submodule add https://github.com/rafaelmatosds/rms-parity scripts
```

This mounts the scripts at `scripts/` so `node scripts/audit.mjs` works as expected.

### 2. Run --init (or just run the audit)

```bash
node scripts/audit.mjs --init
```

This asks 4 questions, then auto-detects everything else:

1. **Figma file URL** — paste the browser URL; file key is parsed automatically
2. **Token CSS path** — auto-detected if exactly one file found; confirm or override
3. **Figma personal access token** *(optional)* — used to query Figma collections automatically and for Gate [9] visual regression; saved to `.env`
4. **Consumer file?** *(optional)* — if this Figma file uses an external DS library, provide the DS source URL to enable `⏳ PENDING FIGMA SYNC` cross-check in Gate [2]

What gets created automatically:
- `ds-config.json` — with Figma collection names detected via API (no manual lookup needed)
- `parity-map.mjs` — scaffolded from example with commented instructions
- `structure-contract.mjs` — scaffolded from example with commented instructions
- `.env` — FIGMA_TOKEN written if provided
- `.gitignore` entries added for all of the above

Then fill in what the checklist tells you (frame node IDs, primitive scale, component contracts) and run `/rms-parity` Phase 1.

### 3. Set up the global skill

```bash
mkdir -p ~/.claude/commands
ln -sf ~/path/to/rms-parity/.claude/commands/rms-parity.md ~/.claude/commands/rms-parity.md
```

Now `/rms-parity` is available in every project.

---

## Consumer file support

When your project Figma file uses a DS library (and may lag behind the latest library updates), set `figmaSourceKey` in `ds-config.json` to the DS library file key. Phase 1 queries both files. Any token where CSS matches the DS source but not the consumer is classified as `⏳ PENDING FIGMA SYNC` instead of `❌ FAIL` — it's not a code bug, it's a pending Figma library update.

---

## Webhook automation (optional)

Automatically trigger parity checks when Figma publishes a library update:

```bash
# Start the server (keep running, e.g. via pm2)
node scripts/webhook-server.mjs

# Register with Figma once (requires a public URL)
FIGMA_TOKEN=xxx node scripts/setup-webhook.mjs --url https://your-host.com/webhook
```

Configure `webhook.port` and `webhook.secret` in `ds-config.json`. The server never modifies source files — it only reports.

---

## Visual regression

Gate [9] compares live Figma frame screenshots against stored references.

Requires `FIGMA_TOKEN` in `.env` and at least one entry in `ds-config.json → frames`. Skips silently if either is absent.

Get a token: Figma → Account Settings → Personal access tokens → Generate (File content: read scope).

To accept a visual change as the new baseline:

```bash
mv .parity-refs/<frame-id>.new.png .parity-refs/<frame-id>.png
```

---

## Keeping projects in sync

When you improve the workflow on one project, commit and push. All other projects get the update via:

```bash
git submodule update --remote scripts
```

Project-specific data (`ds-config.json`, `parity-map.mjs`, `structure-contract.mjs`) never leaves the project.

---

## Hard Rules

1. Every Figma component token → dedicated CSS variable
2. Every CSS variable → at least one rule consumer (no orphans)
3. Naming convention exact (see skill for full spec)
4. All configured modes must match
5. No hardcoded hex/px in CSS rules (declarations OK)
6. New Figma tokens detected → implemented before audit closes
7. Hidden node WITH a boolean visibility variable → implement its tokens. Hidden node with NO boolean variable → flag, never implement
8. DS sub-components nested inside parent components → always retain their own styles
9. CSS alias chains must mirror Figma exactly — same primitive, same order
