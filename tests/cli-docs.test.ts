import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('docs/cli.md matches the commands the CLI registers', () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'gen-cli-docs.mjs'), '--check'], { encoding: 'utf8', windowsHide: true });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
});
