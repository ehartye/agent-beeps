#!/usr/bin/env node
// @ts-nocheck (plain Node script; its tests import it)
// Generate the slim `agent-beeps-runtime` package: the files the runtime entries reach, a package.json that names only what they
// need, the licence and a short README. Nothing is copied by hand and nothing is edited; every file is byte-identical to its source,
// so the package can never drift in behaviour, only lag in time.
//
// Why this exists: npm installs a git dependency's whole `dependencies` list and cannot install a subdirectory of a repository. A
// game that imported `agent-beeps/runtime/engine/index.js` would install playwright, commander and the rest of the CLI to use 17 files
// that need nothing at all (and a schema parser that needs only zod). A game depends on the generated package instead;
// see docs/runtime-package.md.
//
// Usage:
//   node scripts/build-runtime-package.mjs --out <dir>        write the package into <dir> (created, must be empty or absent)
//   node scripts/build-runtime-package.mjs --check <dir>      exit 1 unless <dir> already equals what would be generated
//   node scripts/build-runtime-package.mjs --publish          commit the package onto the local `runtime` branch (never pushes)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_NAME = 'agent-beeps-runtime';
export const BRANCH = 'runtime';

/** The package's entries: the import specifier a game uses, the files that define it, and the packages each may reach at run time. */
export const ENTRIES = {
  '.': { files: ['runtime/engine/index.js', 'runtime/engine/index.d.ts'], types: './runtime/engine/index.d.ts', default: './runtime/engine/index.js', allow: [] },
  './schema': { files: ['src/schema/patch.ts', 'runtime/engine/params.d.ts'], default: './src/schema/patch.ts', allow: ['zod'] },
};

const posix = path => path.split(sep).join('/');
const SPECIFIERS = [
  /^\s*(?:import|export)\s+[^;]*?from\s+['"]([^'"]+)['"]/gm,
  /^\s*import\s+['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const NL = String.fromCharCode(10);
/** A line that is a comment (JSDoc types live in them) and a statement that imports only types. */
const COMMENT_LINE = /^\s*(?:\*|\/\/|\/\*)/;
const TYPE_STATEMENT = /^\s*(?:import|export)\s+type\b/;

/** The package name a bare specifier belongs to: `three/examples/x.js` is `three`, `@a/b/c` is `@a/b`. */
export const packageOf = spec => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

/**
 * Every file reachable from the entry files through relative import/export statements (type-only ones and JSDoc `import()` types
 * too, so a consumer's type checker finds every declaration), and the bare specifiers they name, split into those the emitted
 * JavaScript needs at run time and those only the type checker reads (`import type`, JSDoc, .d.ts).
 */
export function runtimeClosure(entries, base = root) {
  const files = new Set();
  const seen = new Set(); // "file" reached through run-time edges, "file:type" through type-only ones
  const runtime = new Set();
  const typeOnly = new Set();
  // A file reached only through type edges (a JSDoc import, an `import type`, a .d.ts) is read by the type checker alone, so
  // everything it imports is type-only too.
  const visit = (file, viaType) => {
    const key = viaType ? `${file}:type` : file;
    if (seen.has(key) || (viaType && seen.has(file))) return;
    seen.add(key);
    files.add(file);
    const source = readFileSync(join(base, file), 'utf8');
    const typeFile = viaType || file.endsWith('.d.ts');
    for (const pattern of SPECIFIERS) {
      for (const match of source.matchAll(pattern)) {
        const spec = match[1];
        const lineStart = source.lastIndexOf(NL, match.index) + 1;
        const lineEnd = source.indexOf(NL, match.index);
        const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        const isType = typeFile || COMMENT_LINE.test(line) || TYPE_STATEMENT.test(match[0]);
        if (spec.startsWith('.')) visit(posix(relative(base, resolve(base, dirname(file), spec))), isType);
        else (isType ? typeOnly : runtime).add(spec);
      }
    }
  };
  for (const e of entries) visit(e, e.endsWith('.d.ts'));
  return { files: [...files].sort(), runtime: [...runtime].sort(), typeOnly: [...typeOnly].sort() };
}

/**
 * Throws unless the closure's run-time packages are within `allow` and its type-only ones within `allowTypes`. The engine entry may
 * reach no package at run time; its types borrow the schema's, which are zod's.
 */
export function assertSlim(closure, allow, allowTypes = allow) {
  const stray = [
    ...closure.runtime.filter(spec => !allow.includes(packageOf(spec))),
    ...closure.typeOnly.filter(spec => !allowTypes.includes(packageOf(spec))).map(s => `${s} (types)`),
  ];
  if (stray.length) throw new Error(`runtime closure reaches beyond ${allowTypes.length ? allowTypes.join(' and ') : 'its own files'}: ${stray.join(', ')}`);
}

/** The closure of each entry, checked against what that entry may reach. */
export function closures(base = root) {
  const out = {};
  for (const [name, e] of Object.entries(ENTRIES)) {
    out[name] = runtimeClosure(e.files, base);
    assertSlim(out[name], e.allow, ['zod']);
  }
  return out;
}

export function packageJson(rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))) {
  return {
    name: PACKAGE_NAME,
    version: rootPackage.version,
    description: 'Browser-safe runtime of agent-beeps: a patch, a seed and named inputs in, a voice in your AudioContext out. Generated; do not edit.',
    license: 'MIT',
    type: 'module',
    sideEffects: false,
    repository: { type: 'git', url: 'git+https://github.com/ehartye/agent-beeps.git' },
    exports: Object.fromEntries([...Object.entries(ENTRIES).map(([name, e]) => [name, e.types ? { types: e.types, default: e.default } : e.default]), ['./package.json', './package.json']]),
    // Only the schema entry needs zod, and a game that never imports it never loads it; it is a dependency (not an optional peer) so
    // `import 'agent-beeps-runtime/schema'` works after a plain install.
    dependencies: { zod: `^${rootPackage.dependencies.zod}` },
    engines: { node: '>=24' },
  };
}

const README = `# agent-beeps-runtime

Generated from [agent-beeps](https://github.com/ehartye/agent-beeps) by \`scripts/build-runtime-package.mjs\`. Do not edit.

The browser-safe runtime: files byte-identical to their sources, no dependencies for the engine (\`zod\` only for the schema
entry). The engine entry is plain JavaScript with \`.d.ts\` types; the schema entry is TypeScript source, so import it with a
bundler or runner that accepts \`.ts\`.

\`\`\`js
import { build, parseCue, createReverbBus } from 'agent-beeps-runtime';
import { parsePatch } from 'agent-beeps-runtime/schema'; // only to parse raw patch JSON; cues are already parsed

const voice = build(ctx, ctx.destination, parseCue(cueJson), { params: { speed: 0.4 } }).start();
voice.set('speed', 0.9);
voice.stop();
\`\`\`

See docs/runtime.md in agent-beeps for the API, inputs, the shared reverb bus and what to measure.
`;

/** The package as a map of relative path to file contents. */
export function generate(base = root) {
  const all = closures(base);
  const files = new Set(Object.values(all).flatMap(c => c.files));
  const out = new Map();
  for (const file of [...files].sort()) out.set(file, readFileSync(join(base, file)));
  out.set('package.json', `${JSON.stringify(packageJson(JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))), null, 2)}\n`);
  out.set('LICENSE', readFileSync(join(base, 'LICENSE')));
  out.set('README.md', README);
  return out;
}

function listFiles(dir, prefix = '') {
  const found = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listFiles(dir, rel));
    else found.push(rel);
  }
  return found.sort();
}

const text = value => (typeof value === 'string' ? value : value.toString('utf8')).replaceAll('\r\n', '\n');

/** Differences between a directory and the generated package; empty means equal. Line endings are compared as LF. */
export function diff(dir, generated = generate()) {
  const problems = [];
  const present = new Set(existsSync(dir) ? listFiles(dir) : []);
  for (const [path, content] of generated) {
    if (!present.has(path)) problems.push(`missing ${path}`);
    else if (text(readFileSync(join(dir, path))) !== text(content)) problems.push(`differs ${path}`);
  }
  for (const path of present) if (!generated.has(path)) problems.push(`extra ${path}`);
  return problems;
}

function write(dir, generated) {
  for (const [path, content] of generated) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Commit the package onto the local `runtime` branch (append-only, so every pinned commit stays reachable). Returns the commit or null if unchanged. */
export function publish() {
  const generated = generate();
  // The package is built from the working tree, so refuse to stamp a commit hash on files that are not that commit's.
  const dirty = git(root, 'status', '--porcelain', '--', ...[...generated.keys()].filter(f => !['package.json', 'LICENSE', 'README.md'].includes(f)));
  if (dirty) throw new Error(`commit your changes to the runtime files first (the package is stamped with the commit it is built from):\n${dirty}`);
  const source = git(root, 'rev-parse', '--short', 'HEAD');
  const scratch = mkdtempSync(join(tmpdir(), 'ab-runtime-'));
  const tree = join(scratch, 'tree');
  try {
    const exists = (() => { try { git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`); return true; } catch { return false; } })();
    if (exists) git(root, 'worktree', 'add', '-q', tree, BRANCH);
    else git(root, 'worktree', 'add', '-q', '--detach', tree);
    if (!exists) { git(tree, 'checkout', '-q', '--orphan', BRANCH); try { git(tree, 'rm', '-rfq', '.'); } catch { /* an orphan checkout can start empty */ } }
    for (const path of listFiles(tree)) rmSync(join(tree, path), { force: true });
    write(tree, generated);
    git(tree, 'add', '-A');
    if (!git(tree, 'status', '--porcelain')) return null;
    git(tree, 'commit', '-q', '-m', `runtime ${packageJson().version} from agent-beeps ${source}\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`);
    return git(tree, 'rev-parse', 'HEAD');
  } finally {
    try { git(root, 'worktree', 'remove', '--force', tree); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, target] = process.argv.slice(2);
  try {
    if (mode === '--out' && target) {
      const dir = resolve(target);
      if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
      const generated = generate();
      write(dir, generated);
      console.log(`wrote ${generated.size} files to ${dir}`);
    } else if (mode === '--check' && target) {
      const problems = diff(resolve(target));
      if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; } else console.log('runtime package is current');
    } else if (mode === '--publish') {
      const commit = publish();
      console.log(commit ? `committed ${commit} on ${BRANCH}; push with: git push origin ${BRANCH}` : `${BRANCH} is already current`);
    } else throw new Error('Usage: node scripts/build-runtime-package.mjs --out <dir> | --check <dir> | --publish');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
