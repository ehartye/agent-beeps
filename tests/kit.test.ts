import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addToKit, emptyKit, kitPath, readKit, removeFromKit, writeKit } from '../src/kit.ts';
import { BeepsError } from '../src/errors.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'beeps-kit-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('kit', () => {
  it('reads an empty kit when the project has none', () => {
    expect(readKit(tmp())).toEqual({ schema: 'beeps/kit@1', sounds: [] });
  });

  it('round-trips through .agent-beeps/kit.json', () => {
    const dir = tmp();
    const kit = addToKit(addToKit(emptyKit(), { name: 'coin', family: 'coin', priority: 2 }), { name: 'no', family: 'no', priority: 1 });
    const path = writeKit(dir, kit);
    expect(path).toBe(kitPath(dir));
    expect(JSON.parse(readFileSync(path, 'utf8')).schema).toBe('beeps/kit@1');
    expect(readKit(dir)).toEqual(kit);
  });

  it('replaces an entry with the same name in place', () => {
    let kit = addToKit(emptyKit(), { name: 'coin', family: 'coin', priority: 2 });
    kit = addToKit(kit, { name: 'jump', family: 'jump', priority: 3 });
    kit = addToKit(kit, { name: 'coin', family: 'pickup', priority: 1 });
    expect(kit.sounds).toEqual([{ name: 'coin', family: 'pickup', priority: 1 }, { name: 'jump', family: 'jump', priority: 3 }]);
  });

  it('removes by name and refuses unknown names', () => {
    const kit = addToKit(emptyKit(), { name: 'coin', family: 'coin', priority: 2 });
    expect(removeFromKit(kit, 'coin').sounds).toEqual([]);
    expect(() => removeFromKit(kit, 'nope')).toThrow(BeepsError);
  });

  it('rejects invalid entries and files with E_SCHEMA and a pointer', () => {
    expect(() => addToKit(emptyKit(), { name: 'Coin!', family: 'coin', priority: 2 })).toThrow(/invalid/);
    const dir = tmp();
    mkdirSync(join(dir, '.agent-beeps'));
    writeFileSync(kitPath(dir), JSON.stringify({ schema: 'beeps/kit@1', sounds: [{ name: 'coin', family: 'coin', priority: 0 }] }));
    try { readKit(dir); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(BeepsError);
      expect((e as BeepsError).code).toBe('E_SCHEMA');
      expect((e as BeepsError).pointer).toBe('/sounds/0/priority');
    }
  });
});
