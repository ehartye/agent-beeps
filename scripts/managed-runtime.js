// @ts-nocheck -- plain Node script shared with sibling plugins; exercised by tests/managed-runtime.test.ts
// Shared by setup and the skill launcher. Runtime selection never uses PATH.
// The Claude Code plugin cache is a bare git checkout: no node_modules and no browser.
// Setup copies the runtime files to ~/.agent-beeps/releases/<key>, installs dependencies there,
// installs Chromium for offline renders, then links the CLI. Skills run the launcher only.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';

const NAME = 'agent-beeps';
const RUNTIME_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'scripts', 'src', 'runtime', 'craft', 'library', 'skills'];
const RECEIPT = 'managed-install.json';
const TEXT = /\.(?:[cm]?[jt]s|json|html|css|svg|txt|py|md)$/;
export const managedHome = () => resolve(process.env.AGENT_BEEPS_HOME || join(homedir(), '.agent-beeps'));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (parent, child) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };

function canonical(path) {
  if (existsSync(path)) return realpathSync(path);
  return join(canonical(dirname(path)), basename(path));
}

function runtimeFiles(root) {
  const paths = [];
  function visit(name) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Runtime source must not contain symlinks: ${path}`);
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) visit(`${name}/${child}`);
    else if (stat.isFile()) paths.push(name);
  }
  for (const name of RUNTIME_FILES) visit(name);
  return paths;
}

export function describeSource(source) {
  source = realpathSync(source);
  const pkg = readJson(join(source, 'package.json'));
  if (pkg.name !== NAME || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error(`Invalid ${NAME} package/version`);
  const pluginPath = join(source, '.claude-plugin', 'plugin.json');
  if (existsSync(pluginPath)) {
    const plugin = readJson(pluginPath);
    if (plugin.name !== pkg.name || plugin.version !== pkg.version) throw new Error('Plugin and CLI package version mismatch');
  }
  const lock = readJson(join(source, 'package-lock.json'));
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('Package and lockfile version mismatch');
  const files = runtimeFiles(source);
  const hash = createHash('sha256');
  for (const name of files) {
    const bytes = readFileSync(join(source, name));
    // Git checkouts and npm's Windows bin-link shebang repair can change CRLF. Normalize text, fingerprint binaries verbatim.
    const content = TEXT.test(name) ? bytes.toString('utf8').replaceAll('\r\n', '\n') : bytes;
    hash.update(name).update('\0').update(content).update('\0');
  }
  const fingerprint = hash.digest('hex');
  const key = `${pkg.version}-${fingerprint.slice(0, 16)}-${process.platform}-${process.arch}-${process.versions.modules}`;
  return { source, name: pkg.name, version: pkg.version, fingerprint, key, files };
}

function location(source, home) {
  const expected = describeSource(source);
  home = canonical(resolve(home));
  if (inside(expected.source, home) || inside(home, expected.source)) throw new Error('Managed installation must be outside the plugin/checkout, in a separate directory');
  const root = join(home, 'releases', expected.key);
  if (!inside(home, canonical(root))) throw new Error('Managed release resolves outside its installation home');
  return { ...expected, home, root, cli: join(root, 'scripts', 'beeps.mjs') };
}

export function resolveRuntime(source, { home = managedHome() } = {}) {
  const runtime = location(source, home);
  const receiptPath = join(runtime.root, RECEIPT);
  if (!existsSync(receiptPath)) throw new Error(`Managed CLI ${runtime.version} is missing. Run the beeps-setup skill (node "${join(runtime.source, 'scripts', 'setup.js')}").`);
  const receipt = readJson(receiptPath);
  if (receipt.fingerprint !== runtime.fingerprint || receipt.key !== runtime.key || describeSource(runtime.root).fingerprint !== runtime.fingerprint) {
    throw new Error(`Managed runtime modified or version mismatch at ${runtime.root}. Move this managed release aside and rerun beeps-setup.`);
  }
  return runtime;
}

function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const entry of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    candidates.push(join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    const npm = join(entry, 'npm');
    if (existsSync(npm)) candidates.push(realpathSync(npm));
  }
  const found = candidates.find(path => path && path.endsWith('npm-cli.js') && existsSync(path));
  if (!found) throw new Error('Cannot locate npm-cli.js. Install Node.js with npm, then rerun beeps-setup.');
  return found;
}

export function runNpm(args, { cwd, progress = false } = {}) {
  try {
    return execFileSync(process.execPath, [npmCli(), ...args], {
      cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      stdio: progress ? ['ignore', 2, 2] : ['ignore', 'pipe', 'pipe'],
    })?.trim() || '';
  } catch (error) {
    throw new Error(`npm ${args.join(' ')} failed: ${error.stderr || error.message}`);
  }
}

const node = (root, code) => execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, windowsHide: true, stdio: 'pipe', encoding: 'utf8' }).trim();


/** Chromium for offline renders and look images. Playwright keeps browsers in its own cache, so this is idempotent. */
export function installBrowser(root) {
  execFileSync(process.execPath, [join(root, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], { cwd: root, windowsHide: true, stdio: ['ignore', 2, 2] });
}

/** Extra Playwright engines (firefox, webkit) for `beeps loopcheck --engines`. Chromium is always installed by setup. */
export function installExtraBrowsers(root, names) {
  const bad = names.filter(n => !['chromium', 'firefox', 'webkit'].includes(n));
  if (bad.length) throw new Error(`--browsers takes chromium, firefox or webkit, not ${bad.join(',')}`);
  execFileSync(process.execPath, [join(root, 'node_modules', 'playwright', 'cli.js'), 'install', ...names], { cwd: root, windowsHide: true, stdio: ['ignore', 2, 2] });
}

/** Exercise the runtime rather than only checking that directories exist: imports and the browser. */
export function checkDependencies(root) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error(`agent-beeps runs TypeScript directly and needs Node 24 or newer; this is Node ${process.versions.node}`);
  node(root, "await import('zod'); await import('commander'); await import('playwright');");
  const browser = node(root, "const { chromium } = await import('playwright'); const { existsSync } = await import('node:fs'); console.log(existsSync(chromium.executablePath()) ? 'ok' : 'missing');");
  if (browser !== 'ok') throw new Error('Chromium for Playwright is missing, so renders would fail. Rerun beeps-setup.');
}

export function installRuntime(source, { home = managedHome(), npm = runNpm, checkDependencies: check = checkDependencies, installBrowser: browser = installBrowser } = {}) {
  const runtime = location(source, home);
  mkdirSync(runtime.home, { recursive: true });
  const lock = join(runtime.home, 'setup.lock');
  let fd;
  try { fd = openSync(lock, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another setup may be running (${lock}). Remove a stale lock only after confirming no setup is active.`);
    throw error;
  }
  let stage;
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    if (!existsSync(runtime.root)) {
      const releases = join(runtime.home, 'releases');
      mkdirSync(releases, { recursive: true });
      stage = mkdtempSync(join(releases, '.install-'));
      for (const name of runtime.files) {
        mkdirSync(dirname(join(stage, name)), { recursive: true });
        copyFileSync(join(runtime.source, name), join(stage, name));
      }
      npm(['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, progress: true });
      browser(stage);
      check(stage);
      if (describeSource(stage).fingerprint !== runtime.fingerprint) throw new Error('Runtime source changed during installation; rerun setup');
      writeFileSync(join(stage, RECEIPT), JSON.stringify({ key: runtime.key, version: runtime.version, fingerprint: runtime.fingerprint }, null, 2));
      renameSync(stage, runtime.root);
      stage = undefined;
    } else {
      resolveRuntime(source, { home });
      try { check(runtime.root); } catch {
        npm(['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: runtime.root, progress: true });
        browser(runtime.root);
        check(runtime.root);
      }
    }
    npm(['link', '--omit=dev', '--no-audit', '--no-fund'], { cwd: runtime.root, progress: true });
    const globalRoot = npm(['root', '--global'], { cwd: runtime.root });
    const linked = join(globalRoot, NAME);
    if (!existsSync(linked) || !samePath(realpathSync(linked), realpathSync(runtime.root))) throw new Error('npm link did not select the managed runtime');
    return runtime;
  } finally {
    closeSync(fd);
    if (stage && inside(join(runtime.home, 'releases'), realpathSync(stage))) rmSync(stage, { recursive: true, force: true });
    unlinkSync(lock);
  }
}

export function inspectInstallation(source, { home = managedHome(), npm = runNpm, checkDependencies: check = checkDependencies } = {}) {
  const expected = location(source, home);
  const report = { ok: false, pluginVersion: expected.version, cliVersion: null, runtimeRoot: expected.root, fingerprint: expected.fingerprint, linked: false, dependencies: false, errors: [] };
  try {
    const runtime = resolveRuntime(source, { home });
    report.cliVersion = runtime.version;
    check(runtime.root); report.dependencies = true;
    const globalRoot = npm(['root', '--global'], { cwd: runtime.root });
    const linked = join(globalRoot, NAME);
    report.linkedRoot = existsSync(linked) ? realpathSync(linked) : null;
    report.linked = !!report.linkedRoot && samePath(report.linkedRoot, realpathSync(runtime.root));
    if (!report.linked) report.errors.push('npm link points elsewhere or is missing; rerun beeps-setup');
    const prefix = npm(['prefix', '--global'], { cwd: runtime.root });
    report.pathDirectory = process.platform === 'win32' ? prefix : join(prefix, 'bin');
    report.pathConfigured = (process.env.PATH || '').split(delimiter).filter(Boolean).some(path => samePath(resolve(path), resolve(report.pathDirectory)));
    if (!report.pathConfigured) report.pathHint = `Add ${report.pathDirectory} to your user PATH for the optional bare beeps command. Skills use the checked launcher regardless of PATH.`;
  } catch (error) { report.errors.push(error.message); }
  report.ok = report.dependencies && report.linked && report.errors.length === 0;
  return report;
}
