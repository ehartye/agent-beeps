import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { NOTICE_CODES } from '../src/notices.ts';
import { ERROR_CODES } from '../src/errors.ts';

it('docs/notices.md matches the notice and error registries', () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'gen-notice-docs.mjs'), '--check'], { encoding: 'utf8', windowsHide: true });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
});

it('documents every notice and error code', () => {
  const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'notices.md'), 'utf8');
  for (const code of [...NOTICE_CODES, ...ERROR_CODES]) expect(doc, code).toContain(`\`${code}\``);
});
