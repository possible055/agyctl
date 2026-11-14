import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const defaultSourceRoot = path.join(repoRoot, 'src');

// The capsule inputs are real ES modules bundled into one classic script.
// The list is the bundle graph in evaluation order: lib modules
// first, then i18n (its top-level locale state needs locale-state and
// locale), the UI fragments, and entry.js last (its trailing
// initializeCapsule() call defers the DOM mount). The assembly must stay
// dependency-free: it also runs from independently staged runtimes without
// node_modules, so no bundler API is available there.
export const CAPSULE_INPUTS = Object.freeze([
  'plugin/lib/pricing-core.mjs',
  'plugin/lib/metrics-core.mjs',
  'plugin/lib/poll-policy.mjs',
  'plugin/lib/upstream-contract.mjs',
  'plugin/lib/limit-status-core.mjs',
  'plugin/lib/model-label.mjs',
  'plugin/lib/locale.mjs',
  'plugin/lib/locale-state.mjs',
  'capsule/i18n.js',
  'capsule/anchors.js',
  'capsule/styles.js',
  'capsule/host-ui.js',
  'capsule/main.js',
  'capsule/entry.js',
]);

/**
 * Turns one ES module into a classic-script fragment. Import declarations are
 * removed because every imported binding comes from an earlier fragment with
 * the same name; export keywords are dropped so the declarations stay
 * module-scope bindings. Anything the transform does not recognize —
 * `export *`, `export default`, renamed exports, dynamic-form imports —
 * fails the build instead of being mangled.
 */
function toClassicFragment(source, name) {
  const withoutImports = source
    .replace(/^import\s[\s\S]*?from\s*['"][^'"]*['"];[ \t]*$/gm, '')
    .replace(/^import\s*['"][^'"]*['"];[ \t]*$/gm, '');
  if (/(^|\n)\s*import(?:\s|['"(])/.test(withoutImports)) {
    throw new Error(`${name} contains import syntax the packer cannot strip`);
  }
  const stripped = withoutImports
    .replace(/^export\s+(?=(?:async\s+)?function\b|class\b|const\b|let\b|var\b)/gm, '')
    .replace(/^export\s*\{[^}]*\};?[ \t]*$/gm, '');
  if (/(^|\n)\s*export[\s{]/.test(stripped)) {
    throw new Error(`${name} contains export syntax the packer cannot strip`);
  }
  return stripped;
}

function readCapsuleInput(sourceRoot, relative) {
  const file = path.join(sourceRoot, relative);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Capsule input missing: ${relative}`, { cause: err });
  }
  return toClassicFragment(source, relative);
}

export function assembleCapsule({ sourceRoot = defaultSourceRoot } = {}) {
  const fragments = CAPSULE_INPUTS.map((relative) => readCapsuleInput(sourceRoot, relative));
  const joined = fragments.map((fragment) => fragment.trimEnd()).join('\n\n');
  // The capsule is injected repeatedly over a page's lifetime (reinjection
  // after Host reloads), so every fragment lives in one strict-mode IIFE:
  // re-running the script must never redeclare a top-level binding. Compile
  // as a classic script, which is how webFrame.executeJavaScript runs it.
  const code = `${HEADER}(() => {\n'use strict';\n${joined}\n})();\n`;
  new vm.Script(code, { filename: 'input-capsule.js' });
  return code;
}

export async function writeCapsule() {
  const { validateLocaleSources } = await import('../src/plugin/lib/locale-validation.mjs');
  await validateLocaleSources();
  const out = assembleCapsule();
  const destDir = path.join(repoRoot, 'dist', 'capsule');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'input-capsule.js');
  fs.writeFileSync(dest, out, 'utf8');
  console.log(`[capsule-build] wrote ${dest} (${(out.length / 1024).toFixed(1)} KB)`);
}

const HEADER =
  '// AGYCTL_LOCALE_BOOTSTRAP_V1\n' +
  '// ===========================================================================\n' +
  '// GENERATED FILE — do not edit by hand.\n' +
  '// Bundled from the ES module inputs in dependency order; see\n' +
  '// CAPSULE_INPUTS in scripts/capsule-build.mjs. entry.js is evaluated last\n' +
  '// and defers mountCapsule() until the Host document is ready.\n' +
  '// Rebuild with: npm run capsule:build\n' +
  '// ===========================================================================\n\n';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeCapsule();
}
