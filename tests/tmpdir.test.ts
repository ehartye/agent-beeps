import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { expect, it } from 'vitest';

it('runs under the per-run temp root that the global setup removes afterwards', () => {
  expect(basename(tmpdir())).toMatch(/^beeps-test-run-/);
  expect(process.env.TMPDIR).toBe(tmpdir());
});
