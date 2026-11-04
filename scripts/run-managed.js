#!/usr/bin/env node
// Skill launcher: run the managed agent-beeps CLI that matches this plugin, never a PATH or checkout CLI.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveRuntime } from './managed-runtime.js';
import { selectLockedRuntime } from './locked-runtime.js';

try {
  const source = join(dirname(fileURLToPath(import.meta.url)), '..');
  let args = process.argv.slice(2), runtime;
  if (args[0] === '--locked-build-check') {
    const { values } = parseArgs({ args, options: { 'locked-build-check': { type: 'string' }, 'runtime-source': { type: 'string' } } });
    runtime = selectLockedRuntime(source, values['locked-build-check'], { runtimeSource: values['runtime-source'] });
    console.error(`Locked-toolchain check: ${runtime.version} ${runtime.fingerprint} at ${runtime.root}`);
    args = ['build', '--config', runtime.config, '--check'];
  } else runtime = resolveRuntime(source);
  const child = spawnSync(process.execPath, [runtime.cli, ...args], { stdio: 'inherit', windowsHide: true });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} catch (error) {
  console.error(`${error.code ? `${error.code}: ` : ''}${error.message}`);
  process.exitCode = 1;
}
