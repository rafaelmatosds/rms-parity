// audit.mjs — Single-command parity audit runner.
// Run from project root: node scripts/audit.mjs [--trend]
//
// --trend: print the last 20 audit runs and exit (no new run)
//
// First run: if ds-config.json is missing, asks 2 questions (Figma file key +
// theme CSS path) then auto-detects everything else and writes the config.
// Subsequent runs: config exists, audit starts immediately.
//
// Gates:
//   [1]  Snapshot freshness     — warns if snapshots are stale (> 24 h)
//   [2]  Parity check           — token values: color + sizing + typography
//   [3]  Structure check        — heights + CSS base-rule var bindings
//   [4]  Bound-token coverage   — every bound Figma token has a CSS var
//   [5]  Unused var check       — no declared-but-orphaned CSS vars
//   [6]  Hardcoded value scan   — no raw hex / px in CSS rules
//   [7]  Build freshness        — source files not newer than built output
//   [8]  Sub-component isolation — no broad element selector overrides sub-component styles
//   [9]  Visual regression      — Figma frame screenshots match stored references
//                                (requires FIGMA_TOKEN env var; skipped if not set)
//   [10] State completeness     — all COMPONENT_SET state tokens covered (skips if no data)
//   [11] Exemption validity     — EXPLICIT/SKIP_TOKENS/COVERED entries not stale in snapshot
//   [12] Dark mode completeness — all mode-variant tokens adapt between light and dark CSS
//   [13] CSS naming round-trip  — every theme.css var traces back to a Figma token
//
// Performance: gates 2–4, 8–13 (subprocess-based) run in parallel via Promise.all.

import readline                                                  from 'readline';
import { spawn, spawnSync }                                      from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync,
         writeFileSync }                                         from 'fs';
import { join, dirname, resolve }                               from 'path';
import { fileURLToPath }                                        from 'url';

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

// ── Bootstrap: generate ds-config.json from 2 questions ──────────────────────
// Called when ds-config.json is missing. Auto-detects CSS paths, plugin files,
// and snapshot locations; only prompts for what cannot be determined.
async function bootstrapConfig() {
  console.log('\n' + C.bold('rms-parity — first-time setup'));
  console.log(C.dim('─'.repeat(WIDTH)));

  // Auto-detect token CSS — scan common locations 2 levels deep for any .css file
  // containing :root { and -- (CSS custom properties). Accepts any filename.
  const candidates = [];
  const CSS_EXTS = ['.css', '.scss', '.sass', '.less'];
  function looksLikeTokenFile(absPath) {
    try {
      const t = readFileSync(absPath, 'utf8');
      return t.includes(':root') && t.includes('--');
    } catch { return false; }
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
  const pluginCSS = [];
  const plugins   = [];
  const appsDir   = join(ROOT, 'apps');
  if (existsSync(appsDir)) {
    try {
      for (const p of readdirSync(appsDir).sort()) {
        const uiSrc = join('apps', p, 'ui.src.html');
        if (existsSync(join(ROOT, uiSrc))) { pluginCSS.push(uiSrc); plugins.push(p); }
      }
    } catch {}
  }
  if (!pluginCSS.length && existsSync(join(ROOT, 'src', 'ui.src.html'))) {
    pluginCSS.push('src/ui.src.html');
  }
  if (pluginCSS.length) {
    const names = plugins.length ? plugins.slice(0, 3).join(', ') + (plugins.length > 3 ? '...' : '') : pluginCSS.join(', ');
    console.log(C.dim(`  Found ${pluginCSS.length} plugin CSS file(s): ${names}`));
  }
  console.log('');

  // Ask questions
  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, res));

  const figmaKey = (await ask('Figma file URL or file key (leave blank to skip Gate 9): ')).trim();

  // Accept comma-separated paths for multi-file token stores
  let themeCSS;
  const defaultHint = detectedCSS ?? (unique.length > 1 ? unique.join(', ') : null);
  if (defaultHint) {
    const ans = (await ask(`Token CSS file(s) — comma-separated if multiple [${defaultHint}]: `)).trim();
    const raw = ans || defaultHint;
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    themeCSS = parts.length === 1 ? parts[0] : parts;
  } else {
    const ans = (await ask('Token CSS file(s) — comma-separated if multiple (e.g. src/tokens/base.css, src/tokens/components.css): ')).trim();
    const parts = ans.split(',').map(s => s.trim()).filter(Boolean);
    themeCSS = parts.length === 1 ? (parts[0] || 'src/theme.css') : parts;
  }

  // Consumer file check — optional DS source for PENDING_FIGMA_SYNC cross-check
  let figmaSourceKey = '';
  const isConsumer = (await ask('Is this a Figma consumer file that uses an external DS library? (y/N): ')).trim().toLowerCase();
  if (isConsumer === 'y' || isConsumer === 'yes') {
    const srcUrl = (await ask('DS source Figma URL (paste full browser URL, or leave blank to skip): ')).trim();
    if (srcUrl) {
      const m = srcUrl.match(/figma\.com\/(?:design|file)\/([a-zA-Z0-9]+)/);
      figmaSourceKey = m ? m[1] : srcUrl;
      console.log(C.dim(`  DS source key: ${figmaSourceKey}`));
    }
  }

  rl.close();
  console.log('');

  // Derive snapshot paths from first token CSS file location
  const firstTheme       = [themeCSS].flat()[0];
  const cssDir           = dirname(firstTheme);
  const snapshotVars     = join(cssDir, 'figma-vars.snapshot.json').replace(/\\/g, '/');
  const snapshotStructure = join(cssDir, 'figma-structure.snapshot.json').replace(/\\/g, '/');

  // Parse file key from URL if user pasted a full URL
  const figmaFileKey = (() => {
    const m = figmaKey.match(/figma\.com\/(?:design|file)\/([a-zA-Z0-9]+)/);
    return m ? m[1] : figmaKey;
  })();

  const generated = {
    figmaFileKey: figmaFileKey || '',
    ...(figmaSourceKey ? { figmaSourceKey } : {}),
    frames: [],
    figma: {
      colorCollection:  'Color',
      sizingCollection: 'Sizing',
      primitivePrefix:  'primitives/',
      modes: [
        { name: 'Light', snapshotKey: 'light', cssSelector: 'root' },
        { name: 'Dark',  snapshotKey: 'dark',  cssSelector: 'dark-media' },
      ],
    },
    paths: {
      themeCSS,
      snapshotVars,
      snapshotStructure,
      pluginCSS,
      plugins,
    },
    visualRefs: '.parity-refs',
    webhook: { port: 3456, secret: 'YOUR_WEBHOOK_SECRET' },
    knownUnusedVars: [],
    knownHardcodedExceptions: [],
  };

  writeFileSync(join(ROOT, 'ds-config.json'), JSON.stringify(generated, null, 2) + '\n');
  console.log(C.green('✅ ds-config.json written'));

  // Update .gitignore
  const giPath    = join(ROOT, '.gitignore');
  const giContent = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const toAdd     = ['ds-config.json', 'parity-map.mjs', 'structure-contract.mjs']
    .filter(e => !giContent.split('\n').some(l => l.trim() === e));
  if (toAdd.length) {
    const sep    = giContent.endsWith('\n') ? '' : '\n';
    const block  = '\n# rms-parity project config (project-specific, not committed)\n' + toAdd.join('\n') + '\n';
    writeFileSync(giPath, giContent + sep + block);
    console.log(C.green('✅ .gitignore updated'));
  }

  console.log(C.dim('\n  Edit ds-config.json any time to add frame IDs, custom tokens, etc.'));
  console.log(C.dim('  Running audit now...\n'));

  return generated;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  // ── Load or generate config ─────────────────────────────────────────────────
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8'));
  } catch {
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
  const SNAP_VARS   = cfg.paths?.snapshotVars       ?? 'src/figma-vars.snapshot.json';
  const SNAP_STRUCT = cfg.paths?.snapshotStructure  ?? 'src/figma-structure.snapshot.json';
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
    'bound-tokens.json', 'parity-history.json', 'master-token-table.md',
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

  function runScriptAsync(scriptPath) {
    return new Promise(res => {
      const abs = resolve(SCRIPT_DIR, scriptPath);
      if (!existsSync(abs)) return res({ status: null, stdout: '', stderr: '' });
      const child = spawn('node', [abs], { cwd: ROOT, env: process.env });
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

  function boundAge() {
    try {
      return Math.floor((Date.now() - statSync(join(ROOT, 'bound-tokens.json')).mtime) / 3_600_000);
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
      return {
        pass: false,
        lines: [
          C.red('❌ HARD FAIL — bound-tokens.json missing.'),
          C.red('   Run /rms-parity Phase 2 Step 1b and save output to bound-tokens.json.'),
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

  // Generic parser for gates [10-13]: pass/fail from exit code, summary from keyword lines
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
    const bnd    = boundAge();
    const lines  = [];
    let warn     = false;

    if (vars === null) {
      lines.push(C.red(`${SNAP_VARS} missing — run /rms-parity Phase 1`)); warn = true;
    } else if (vars > 24) {
      lines.push(C.yellow(`⚠️  ${SNAP_VARS} is ${vars}h old`)); warn = true;
    } else {
      lines.push(`${SNAP_VARS} ✓ (updated today)`);
    }

    if (struct === null) {
      lines.push(C.red(`${SNAP_STRUCT} missing — run /rms-parity Phase 1`)); warn = true;
    } else if (struct > 24) {
      lines.push(C.yellow(`⚠️  ${SNAP_STRUCT} is ${struct}h old`)); warn = true;
    } else {
      lines.push(`${SNAP_STRUCT} ✓ (updated today)`);
    }

    if (bnd === null) {
      lines.push(C.red('bound-tokens.json missing — run /rms-parity Phase 2 Step 1b')); warn = true;
    } else if (bnd > 24) {
      lines.push(C.yellow(`⚠️  bound-tokens.json is ${bnd}h old`)); warn = true;
    } else {
      lines.push(`bound-tokens.json ✓ (${bnd}h old)`);
    }

    return { pass: !warn, lines };
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
    // Scan all source files — not just token CSS — so Vue/JSX inline styles are caught too
    const scanTargets = allSourceFiles();
    const scanArgs    = ['-n', '-E'];

    const hexR = sh('grep', [
      ...scanArgs,
      '(background|color|border|fill|stroke)\\s*:[^;]*#[0-9a-fA-F]{3,8}\\b',
      ...scanTargets,
    ]);
    const KNOWN_HEX_VARS = ['--swatch-stripe', '--semantic-positive', '--semantic-negative',
      '--semantic-warning', '--input-auto-border', '--overlay-bg', '--scrollbar-thumb', '--neutral-'];
    const hexHits = (hexR.stdout || '').split('\n').filter(l => {
      if (!l.trim()) return false;
      const codePart = l.replace(/^[^:]+:\d+:\s*/, '');
      if (/^\s*--[a-zA-Z]/.test(codePart)) return false;
      const stripped = codePart.replace(/\/\*[^*]*\*\//g, '');
      if (!/#[0-9a-fA-F]{3,8}\b/.test(stripped)) return false;
      if (KNOWN_HEX_VARS.some(k => l.includes(k))) return false;
      if (/color\s*:\s*['"]#[0-9a-fA-F]{3,8}['"]/i.test(codePart)) return false;
      return true;
    });

    const fsR = sh('grep', [
      ...scanArgs,
      'font-size\\s*:\\s*[0-9]+(\\.[0-9]+)?(px|rem|em)',
      ...scanTargets,
    ]);
    const fsHits = (fsR.stdout || '').split('\n').filter(l => {
      if (!l.trim()) return false;
      if (/[`"'].*font-size.*[`"']/.test(l)) return false;
      if (KNOWN_FS_EXCEPTS.some(e => l.includes(e.file ?? e) && l.includes(e.size ?? e))) return false;
      return true;
    });

    const hits = [...hexHits, ...fsHits];
    const pass = hits.length === 0;
    return {
      pass,
      lines: pass
        ? ['✅ Clean']
        : [`❌ ${hits.length} hit(s):`, ...hits.slice(0, 15).map(l => '  ' + l)],
    };
  }

  function computeGate7() {
    if (!PLUGINS.length) {
      return { pass: true, lines: ['⏭ No plugins configured in ds-config.json — skipped'] };
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

  // ── Run gates ─────────────────────────────────────────────────────────────────
  const gates  = [];
  let anyFail  = false;

  function addGate(label, result) {
    if (!result.pass) anyFail = true;
    gates.push({ label, ...result });
  }

  // Gate 1 — sync (file stat only)
  addGate('Snapshot freshness', computeGate1());

  // Gates 2–4, 8–13 — all subprocess-based; launch concurrently
  const [r2, r3, r4, r8, r9, r10, r11, r12, r13] = await Promise.all([
    runScriptAsync('parity-check.mjs'),
    runScriptAsync('structure-check.mjs'),
    runScriptAsync('bound-check.mjs'),
    runScriptAsync('subcomponent-isolation-check.mjs'),
    runScriptAsync('visual-regression-check.mjs'),
    runScriptAsync('state-check.mjs'),
    runScriptAsync('exemption-check.mjs'),
    runScriptAsync('dark-mode-check.mjs'),
    runScriptAsync('naming-check.mjs'),
  ]);

  addGate('Token parity  (color · sizing · typography)',               parseGate2(r2));
  addGate('Structure     (snapshot · CSS height · base-rule vars)',    parseGate3(r3));
  addGate('Bound-token coverage  (DS frames → CSS vars)',              parseGate4(r4));
  addGate('Unused CSS vars',                                           computeGate5());
  addGate('Hardcoded values  (no raw hex / font-size in rules)',       computeGate6());
  addGate('Build freshness  (source ≤ built output)',                  computeGate7());
  addGate('Sub-component isolation  (no parent rule overrides sub-component styles)', parseGate8(r8));
  addGate('Visual regression  (frames match stored references)',       parseGate9(r9));
  addGate('State completeness  (all COMPONENT_SET states covered)',    parseGeneric(r10, /COVERED|UNCOVERED/));
  addGate('Exemption validity  (EXPLICIT · SKIP_TOKENS · COVERED not stale)', parseGeneric(r11, /VALID|STALE|BROKEN/));
  addGate('Dark mode completeness  (all mode-variant tokens adapt)',   parseGeneric(r12, /ADAPTS|STATIC|SKIPPED/));
  addGate('CSS naming round-trip  (every var traceable to a Figma token)', parseGeneric(r13, /TRACEABLE|UNINVENTED/));

  // ── Final report ──────────────────────────────────────────────────────────────
  console.log('\n' + C.bold('─'.repeat(WIDTH)));
  console.log(C.bold(`  PARITY AUDIT  ·  ${today}`));
  console.log(C.bold('─'.repeat(WIDTH)) + '\n');

  gates.forEach((g, i) => {
    const icon = g.pass ? C.green('✅') : C.red('❌');
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
  console.log('─'.repeat(WIDTH) + '\n');

  // ── Write parity history ──────────────────────────────────────────────────────
  const histPath = join(ROOT, 'parity-history.json');
  let hist = [];
  try { hist = JSON.parse(readFileSync(histPath, 'utf8')); } catch {}
  hist.push({
    date:      today,
    timestamp: new Date().toISOString(),
    pass:      gates.filter(g => g.pass).length,
    fail:      gates.filter(g => !g.pass).length,
    total:     gates.length,
    gates:     gates.map(g => ({ label: g.label, pass: g.pass })),
  });
  if (hist.length > 100) hist = hist.slice(-100);
  try { writeFileSync(histPath, JSON.stringify(hist, null, 2) + '\n'); } catch {}

  process.exit(anyFail ? 1 : 0);
})();
