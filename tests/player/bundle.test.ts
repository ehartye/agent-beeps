// tests/player/bundle.test.ts
import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleDir } from '../../src/bundle.ts';

const sidecar = (id: string, file: string, extra: Record<string, unknown> = {}) => ({
  schema: 'beeps/audio-asset@1', id, label: id, description: '', role: 'sfx', file, loop: false, durationSec: 0.3,
  sampleRate: 48000, channels: 2, renderKey: 'k', loudness: { metric: 'momentary-max', lufs: -18 }, truePeakDb: -3,
  normalizationAlreadyApplied: true, ...extra,
});

/** Runs `fn`, returning what it threw (or undefined) without letting the throw escape. */
function catches(fn: () => unknown): (Error & { code?: string }) | undefined {
  try { fn(); return undefined; } catch (e) { return e as Error & { code?: string }; }
}

describe('beeps bundle', () => {
  it('collects sidecars into one catalog with paths relative to the bundle directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-'));
    mkdirSync(join(dir, 'sfx'));
    writeFileSync(join(dir, 'sfx', 'coin.wav.json'), JSON.stringify(sidecar('coin', 'coin.0.wav', { variants: [{ file: 'coin.0.wav' }, { file: 'coin.1.wav' }] })));
    writeFileSync(join(dir, 'sfx', 'coin.0.wav'), '');
    writeFileSync(join(dir, 'sfx', 'coin.1.wav'), '');
    writeFileSync(join(dir, 'theme.wav.json'), JSON.stringify(sidecar('theme', 'theme.wav', { role: 'music', loop: true, layers: [{ name: 'bed', file: 'theme.bed.wav' }] })));
    writeFileSync(join(dir, 'theme.wav'), '');
    writeFileSync(join(dir, 'theme.bed.wav'), '');
    const r = bundleDir(dir);
    expect(r.assets.sort()).toEqual(['coin', 'theme']);
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    expect(index.schema).toBe('beeps/audio-bundle@1');
    expect(index.assets.coin).toMatchObject({ file: 'sfx/coin.0.wav', variants: [{ file: 'sfx/coin.0.wav' }, { file: 'sfx/coin.1.wav' }] });
    expect(index.assets.theme.layers).toEqual([{ name: 'bed', file: 'theme.bed.wav' }]);
  });

  it('refuses duplicate ids and names both files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-dup-'));
    writeFileSync(join(dir, 'a.wav.json'), JSON.stringify(sidecar('coin', 'a.wav')));
    writeFileSync(join(dir, 'a.wav'), '');
    writeFileSync(join(dir, 'b.wav.json'), JSON.stringify(sidecar('coin', 'b.wav')));
    writeFileSync(join(dir, 'b.wav'), '');
    expect(() => bundleDir(dir)).toThrow(/"coin" is in both a\.wav\.json and b\.wav\.json/);
  });

  it('refuses a file that is not a sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-bad-'));
    writeFileSync(join(dir, 'x.wav.json'), JSON.stringify({ hello: 1 }));
    expect(() => bundleDir(dir)).toThrow(/x\.wav\.json: not a beeps\/audio-asset@1 sidecar/);
  });

  it('does not treat "constructor" as an inherited duplicate id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-proto-'));
    writeFileSync(join(dir, 'a.wav.json'), JSON.stringify(sidecar('constructor', 'a.wav')));
    writeFileSync(join(dir, 'a.wav'), '');
    const r = bundleDir(dir);
    expect(r.assets).toEqual(['constructor']);
  });

  it('rejects a variant path that escapes the bundle directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-escape-'));
    writeFileSync(join(dir, 'a.wav.json'), JSON.stringify(sidecar('a', 'a.wav', { variants: [{ file: '../../secret.wav' }] })));
    writeFileSync(join(dir, 'a.wav'), '');
    const err = catches(() => bundleDir(dir));
    expect(err?.code).toBe('E_SCHEMA');
    expect(err?.message).toMatch(/a\.wav\.json/);
    expect(err?.message).toMatch(/secret\.wav/);
  });

  it('rejects a layer path containing a backslash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-backslash-'));
    writeFileSync(join(dir, 'a.wav.json'), JSON.stringify(sidecar('a', 'a.wav', { role: 'music', loop: true, layers: [{ name: 'bed', file: 'sub\\bed.wav' }] })));
    writeFileSync(join(dir, 'a.wav'), '');
    const err = catches(() => bundleDir(dir));
    expect(err?.code).toBe('E_SCHEMA');
    expect(err?.message).toMatch(/a\.wav\.json/);
  });

  it('rejects a sidecar whose file does not exist on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-nofile-'));
    writeFileSync(join(dir, 'a.wav.json'), JSON.stringify(sidecar('a', 'missing.wav')));
    const err = catches(() => bundleDir(dir));
    expect(err?.code).toBe('E_NOT_FOUND');
    expect(err?.message).toMatch(/a\.wav\.json/);
    expect(err?.message).toMatch(/missing\.wav/);
  });

  it('rejects an asset path that names a directory, not a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-dirfile-'));
    mkdirSync(join(dir, 'sfx'));
    writeFileSync(join(dir, 'sfx', 'a.wav.json'), JSON.stringify(sidecar('a', '.')));
    const err = catches(() => bundleDir(dir));
    expect(err?.code).toBe('E_SCHEMA');
    expect(err?.message).toMatch(/sfx\/a\.wav\.json/);
    expect(err?.message).toMatch(/"\."/);
  });

  it('rejects an asset path that is a symlink', ctx => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-linkfile-'));
    const outside = mkdtempSync(join(tmpdir(), 'beeps-bundle-linkfile-target-'));
    writeFileSync(join(outside, 'real.wav'), '');
    writeFileSync(join(dir, 'a.wav.json'), JSON.stringify(sidecar('a', 'link.wav')));
    try {
      symlinkSync(join(outside, 'real.wav'), join(dir, 'link.wav'), 'file');
    } catch {
      // File symlinks need elevation or Developer Mode on Windows.
      return ctx.skip('file symlink creation is not available without elevation on this host');
    }
    const err = catches(() => bundleDir(dir));
    expect(err?.code).toBe('E_SCHEMA');
    expect(err?.message).toMatch(/a\.wav\.json/);
    expect(err?.message).toMatch(/link\.wav/);
  });

  it('rejects an asset path that is a junction (a link that needs no elevation on Windows)', ctx => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-linkdir-'));
    const outside = mkdtempSync(join(tmpdir(), 'beeps-bundle-linkdir-target-'));
    writeFileSync(join(dir, 'a.wav.json'), JSON.stringify(sidecar('a', 'link.wav')));
    try {
      symlinkSync(outside, join(dir, 'link.wav'), 'junction');
    } catch {
      return ctx.skip('junction creation is not available on this host');
    }
    const err = catches(() => bundleDir(dir));
    expect(err?.code).toBe('E_SCHEMA');
    expect(err?.message).toMatch(/link\.wav/);
  });

  it('reports a missing bundle directory as E_NOT_FOUND', () => {
    const parent = mkdtempSync(join(tmpdir(), 'beeps-bundle-missing-dir-'));
    const err = catches(() => bundleDir(join(parent, 'does-not-exist')));
    expect(err?.code).toBe('E_NOT_FOUND');
  });

  it('reports malformed JSON as E_SCHEMA, not E_NOT_FOUND', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-malformed-'));
    writeFileSync(join(dir, 'a.wav.json'), '{ this is not json');
    const err = catches(() => bundleDir(dir));
    expect(err?.code).toBe('E_SCHEMA');
  });

  it('reports an unreadable sidecar file as E_NOT_FOUND with the OS message', ctx => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-unreadable-'));
    const file = join(dir, 'a.wav.json');
    writeFileSync(file, JSON.stringify(sidecar('a', 'a.wav')));
    writeFileSync(join(dir, 'a.wav'), '');
    chmodSync(file, 0o000);
    let stillReadable = false;
    try { readFileSync(file, 'utf8'); stillReadable = true; } catch { /* genuinely blocked, as intended */ }
    if (stillReadable) {
      chmodSync(file, 0o644);
      // Some hosts (e.g. Windows, running as the file's own owner) do not enforce the read bit.
      return ctx.skip('this OS does not enforce read permission bits for the file owner');
    }
    try {
      const err = catches(() => bundleDir(dir));
      expect(err?.code).toBe('E_NOT_FOUND');
      expect(err?.message).toMatch(/a\.wav\.json/);
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it('skips dot-directories and node_modules when collecting sidecars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-skipdirs-'));
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'hidden.wav.json'), JSON.stringify(sidecar('hidden', 'hidden.wav')));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'dep.wav.json'), JSON.stringify(sidecar('dep', 'dep.wav')));
    writeFileSync(join(dir, 'ok.wav.json'), JSON.stringify(sidecar('ok', 'ok.wav')));
    writeFileSync(join(dir, 'ok.wav'), '');
    const r = bundleDir(dir);
    expect(r.assets).toEqual(['ok']);
  });

  it('skips a junction instead of following it into another directory', ctx => {
    const dir = mkdtempSync(join(tmpdir(), 'beeps-bundle-junction-'));
    const outside = mkdtempSync(join(tmpdir(), 'beeps-bundle-junction-target-'));
    writeFileSync(join(outside, 'z.wav.json'), JSON.stringify(sidecar('z', 'z.wav')));
    writeFileSync(join(outside, 'z.wav'), '');
    writeFileSync(join(dir, 'ok.wav.json'), JSON.stringify(sidecar('ok2', 'ok.wav')));
    writeFileSync(join(dir, 'ok.wav'), '');
    try {
      symlinkSync(outside, join(dir, 'link'), 'junction');
    } catch {
      return ctx.skip('junction creation is not available without elevation on this host');
    }
    const r = bundleDir(dir);
    expect(r.assets).toEqual(['ok2']);
  });
});
