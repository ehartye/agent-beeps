#!/usr/bin/env node
// Skill launcher: run the managed agent-beeps CLI that matches this plugin, never a PATH or checkout CLI.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntime } from './managed-runtime.js';

try {
  const runtime = resolveRuntime(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const child = spawnSync(process.execPath, [runtime.cli, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
