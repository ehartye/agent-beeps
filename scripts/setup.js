#!/usr/bin/env node
// Install or check the managed agent-beeps runtime outside the plugin cache. Usage: node scripts/setup.js [--check] [--json]
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectInstallation, installRuntime } from './managed-runtime.js';

const source = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--json'].includes(arg))) throw new Error('Usage: node scripts/setup.js [--check] [--json]');
  if (!args.includes('--check')) installRuntime(source);
  const report = inspectInstallation(source);
  report.node = process.versions.node;
  console.log(JSON.stringify(report, null, args.includes('--json') ? undefined : 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, errors: [error.message] }));
  process.exitCode = 1;
}
