#!/usr/bin/env node
// Install or check the managed agent-beeps runtime outside the plugin cache. Usage: node scripts/setup.js [--check] [--json] [--browsers firefox,webkit]
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectInstallation, installExtraBrowsers, installRuntime } from './managed-runtime.js';

const source = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const args = process.argv.slice(2);
  // --browsers firefox,webkit also installs those Playwright engines, for `beeps loopcheck --engines`.
  const at = args.indexOf('--browsers');
  const browsers = at >= 0 ? (args[at + 1] ?? '').split(',').filter(Boolean) : [];
  const flags = at >= 0 ? args.filter((_, i) => i !== at && i !== at + 1) : args;
  if (flags.some(arg => !['--check', '--json'].includes(arg)) || (at >= 0 && !browsers.length)) throw new Error('Usage: node scripts/setup.js [--check] [--json] [--browsers firefox,webkit]');
  if (!args.includes('--check')) installRuntime(source);
  const report = inspectInstallation(source);
  if (browsers.length && !args.includes('--check') && report.ok) { installExtraBrowsers(report.runtimeRoot, browsers); report.browsers = browsers; }
  report.node = process.versions.node;
  console.log(JSON.stringify(report, null, args.includes('--json') ? undefined : 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, errors: [error.message] }));
  process.exitCode = 1;
}
