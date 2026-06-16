// parity-map.mjs — Copy to your PROJECT ROOT and fill in your DS token mappings.
// Consumed by parity-check.mjs and bound-check.mjs.
// Do not commit to the public scripts repo — project-specific, lives at project root.

// ─── Primitive scale (for resolving alias chains in color tokens) ──────────────
// Two-mode setup (default): export NEUTRAL_LIGHT + NEUTRAL_DARK.
// Three-or-more modes:      export NEUTRAL_MAPS instead (see below).
//
// Keys match the capture group in NEUTRAL_VAR_RE (default: --neutral-NNN).
//
// Example — numeric scale:
//   export const NEUTRAL_LIGHT = { 100: '#0a0a0a', 200: '#2b2b2b', 900: '#f7f7f7' };
//   export const NEUTRAL_DARK  = { 100: '#ededed', 200: '#d4d4d4', 900: '#212121' };
//
// Example — named scale with custom var pattern:
//   export const NEUTRAL_LIGHT  = { primary: '#000000', muted: '#595959' };
//   export const NEUTRAL_DARK   = { primary: '#ffffff', muted: '#808080' };
//   export const NEUTRAL_VAR_RE = /^--color-([a-z]+)$/;
export const NEUTRAL_LIGHT = {};
export const NEUTRAL_DARK  = {};
// Uncomment and customize if your primitive vars don't follow --neutral-NNN:
// export const NEUTRAL_VAR_RE = /^--neutral-(\d+)$/;

// ─── Multi-mode primitive maps (3+ modes) ─────────────────────────────────────
// Used instead of NEUTRAL_LIGHT / NEUTRAL_DARK when ds-config.json defines 3+ modes.
// Can be an array (indexed by mode order) or an object keyed by mode name.
//
// Array form (matches order of figma.modes in ds-config.json):
//   export const NEUTRAL_MAPS = [
//     { 100: '#0a0a0a', 900: '#f7f7f7' },   // mode 0: Light
//     { 100: '#ededed', 900: '#212121' },   // mode 1: Dark
//     { 100: '#000000', 900: '#ffffff' },   // mode 2: High Contrast
//   ];
//
// Object form (keyed by mode name):
//   export const NEUTRAL_MAPS = {
//     Light:          { 100: '#0a0a0a', ... },
//     Dark:           { 100: '#ededed', ... },
//     'High Contrast': { 100: '#000000', ... },
//   };
// export const NEUTRAL_MAPS = {};

// ─── COLOR: Token path → CSS var name ──────────────────────────────────────────
// Convention: token/path/default → --token-path  (drop /default, /color; / → -)
// Only add entries where the naming convention doesn't produce the right var.
// Example: 'button/iconText': '--button-text'
export const EXPLICIT = {
  // Add your token→var exceptions here
};

// ─── Tokens that share a CSS var with another token ───────────────────────────
// Avoids duplicate-check noise when two tokens intentionally map to the same var.
// Example: 'radioButton/background/selected' shares --radioButton-background
export const NULL_TOKENS = new Set([
  // Add tokens that deliberately share a CSS var
]);

// ─── Tokens with no CSS implementation ────────────────────────────────────────
// Figma-native chrome, unbound nodes, rgba-only values, intentionally deferred.
export const SKIP_TOKENS = new Set([
  // Add tokens that are permanently un-implementable or intentionally deferred
]);

// ─── Tokens whose Figma value is legitimately null in the snapshot ────────────
export const KNOWN_NULL = new Set([
  // Add tokens where the Figma value is expected to be null
]);

// ─── SIZING: Token path → CSS var name ────────────────────────────────────────
export const EXPLICIT_SIZING = {
  // Example: 'radii/button': '--radius-full'
};

// ─── Sizing tokens with no CSS consumer — Map<token, reason> ──────────────────
export const SIZING_SKIP = new Map([
  // ['general/window-radii', 'Figma window-chrome — not controlled by HTML/CSS'],
]);

// ─── TYPOGRAPHY: CSS var → [scale, prop] snapshot path ────────────────────────
// Only include vars that have a Figma text-style equivalent.
// Example: '--m-size': ['m', 'size']
export const TYPO = {
  // '--m-size':   ['m', 'size'],
  // '--m-weight': ['m', 'weight'],
  // '--m-lh':     ['m', 'lh'],
  // '--s-size':   ['s', 'size'],
  // '--s-weight': ['s', 'weight'],
  // '--s-lh':     ['s', 'lh'],
  // '--l-size':   ['l', 'size'],
};

// ─── BOUND-TOKEN COVERAGE: Tokens not given a dedicated CSS var ───────────────
// These are covered by semantic aliases, shared primitives, or are un-implementable.
// Used by bound-check.mjs (Gate [4]).
export const COVERED = new Set([
  // Add token paths that are intentionally deferred or covered by aliases
]);

// ─── STATE WALK COVERAGE: Additional tokens deferred for the state walk ───────
// Superset of COVERED — adds tokens that appear in COMPONENT_SET variant states
// but have no HTML/CSS equivalent (e.g. internal Figma preview layers).
// Used by state-check.mjs (Gate [10]). Falls back to COVERED if absent.
export const COVERED_STATE = new Set([
  ...[], // spread COVERED entries here, then add state-walk-specific tokens
  // 'icon/backgroundpreview',  // internal Figma preview layer
]);

// ─── Token path prefixes that are always deferred ─────────────────────────────
export const COVERED_PREFIX = [
  // 'primitives/',
  // 'Settings/',
];

// ─── SYSTEM VARS: CSS vars with no direct 1:1 Figma token ────────────────────
// Used by naming-check.mjs (Gate [13]).
// Include: primitive scale vars, semantic one-word aliases, sizing scale vars,
// animation/motion vars, browser-chrome vars, any CSS utility not in the DS.
export const SYSTEM_VARS = new Set([
  // '--bg', '--text', '--border', '--surface', '--accent',
  // '--neutral-100', '--neutral-200', ... '--neutral-1000',
  // '--gap-xs', '--gap-s', '--gap-m', '--gap-l', '--gap-xl',
  // '--padding-xs', '--padding-s', '--padding-m', '--padding-l',
  // '--radius-full', '--radius-sm', '--radius-md',
  // '--m-size', '--m-weight', '--s-size', '--s-weight', '--l-size', '--l-weight',
  // '--modal-duration', '--modal-easing',  // CSS-only motion tokens
  // '--overlay-bg', '--scrollbar-thumb',   // browser chrome
]);
