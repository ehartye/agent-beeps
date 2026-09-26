import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSource, installRuntime, resolveRuntime } from '../scripts/managed-runtime.js';

const root = join(import.meta.dirname, '..');

describe('managed runtime', () => {
  it('describes the agent-beeps source with a fingerprinted release key', () => {
    const d = describeSource(root);
    expect(d.name).toBe('agent-beeps');
    expect(d.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(d.key).toMatch(/^0\.1\.0-[0-9a-f]{16}-/);
    expect(d.files).toContain('runtime/engine/notes.js');
  });

  it('points a missing release at the beeps-setup skill', () => {
    const home = mkdtempSync(join(tmpdir(), 'beeps-home-'));
    expect(() => resolveRuntime(root, { home })).toThrow(/beeps-setup/);
  });

  it('refuses to install inside the checkout', () => {
    expect(() => installRuntime(root, { home: join(root, '.managed') })).toThrow(/outside the plugin/);
  });
});
