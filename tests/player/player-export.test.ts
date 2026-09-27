// tests/player/player-export.test.ts
import { expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportPlayer, PLAYER_FILES } from '../../src/commands/player.ts';

it('vendors the player with every module it imports and a version header', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-vendor-'));
  const r = exportPlayer(dir);
  expect(r.root).toBe(join(dir, 'beeps-player'));
  for (const f of PLAYER_FILES) {
    const file = join(r.root, f);
    const imports = [...readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/g)].map(m => resolve(dirname(file), m[1]));
    for (const i of imports) expect(existsSync(i), `${f} imports ${i}`).toBe(true);
  }
  const player = readFileSync(join(r.root, 'player/player.js'), 'utf8');
  expect(player.split('\n')[0]).toMatch(/^\/\/ Vendored by agent-beeps \d+\.\d+\.\d+ \(player 1, engine \d+\)/);
  expect(JSON.parse(readFileSync(join(r.root, 'VERSION.json'), 'utf8'))).toMatchObject({ player: '1' });
  const mod = await import(pathToFileURL(join(r.root, 'player/player.js')).href);
  expect(typeof mod.createPlayer).toBe('function');
});
