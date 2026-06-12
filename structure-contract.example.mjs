// structure-contract.mjs — Copy to your PROJECT ROOT and fill in your DS component contracts.
// This file is consumed by structure-check.mjs.

// ─── Structural contract (ground-truth per component, State=Default variant) ──
// Captured from live Figma via /rms-parity Phase 1.
// Fields:
//   h              — height in px, or 'auto'
//   paddingVar     — { tb: 'padding/token', lr: 'padding/token' } or null
//   gapVar         — 'gap/token' or null
//   fontSizeVar    — scale key ('m', 's', 'l') or null
//   fontWeightVar  — scale key or null
//   fillStructure  — 'direct' | 'before' | 'none'
//                    'before' = fill is on a child Background rect → CSS ::before
//   innerRadiusVar — 'radii/token' or null
//   strokeOnDefault — true if Figma State=Default has a stroke
export const CONTRACT = {
  // Example:
  // button: {
  //   h: 32,
  //   paddingVar: { tb: 'padding/s', lr: 'padding/m' },
  //   gapVar: 'gap/s',
  //   fontSizeVar: 'm', fontWeightVar: 'm',
  //   fillStructure: 'direct', innerRadiusVar: 'radii/button',
  //   strokeOnDefault: false,
  // },
};

// ─── CSS height/min-height rules to verify ──
// For each component with a fixed height, verify the CSS selector enforces it.
export const CSS_HEIGHT_RULES = {
  // Example:
  // button: { selector: '.button', prop: 'height' },
};

// ─── CSS base-rule var bindings to verify ──
// For multi-state components, verify the correct var is wired into the base rule.
// This catches "right value, wrong var" (e.g. --node-label instead of --node-label-unselected).
export const CSS_BASE_RULE_VARS = [
  // Example:
  // { key: 'node/label', selector: '.node', prop: 'color', expectedVar: '--node-label-unselected' },
];

// ─── Figma state/variant → CSS selector mapping ───────────────────────────────
// For every Figma variant property value that has a distinct visual state,
// document the CSS selector that activates it in code.
// structure-check.mjs verifies each selector exists in your CSS files.
//
// component  — matches a key in CONTRACT above
// figmaState — Figma variant property value (e.g. 'Hover', 'Disabled', 'Small')
// selector   — the CSS selector that activates this state
//
// The check only verifies the selector EXISTS and is syntactically present —
// the correct token values for each state are already covered by Gate [2].
export const STATE_SELECTORS = [
  // { component: 'button',   figmaState: 'Hover',       selector: '.button:hover' },
  // { component: 'button',   figmaState: 'Disabled',    selector: '.button[disabled]' },
  // { component: 'button',   figmaState: 'Active',      selector: '.button:active' },
  // { component: 'input',    figmaState: 'Focus',       selector: '.input:focus-within' },
  // { component: 'input',    figmaState: 'Error',       selector: '.input.error' },
  // { component: 'checkbox', figmaState: 'Selected',    selector: '.checkbox[checked]' },
  // { component: 'tooltip',  figmaState: 'Visible',     selector: '.tooltip.visible' },
];
