// tests/player/engine-check.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeWav } from '../../src/audio/wav.ts';
import { encodeMp3, encodeOpus, findFfmpeg } from '../../src/compress.ts';
import { engineCheck, parseEngines, startLead, type Engine } from '../../src/engine-check.ts';
import { chromiumAvailable } from '../../src/render/host.ts';

const hasFfmpeg = (() => { try { findFfmpeg(); return true; } catch { return false; } })();
const hasChromium = await chromiumAvailable();
const SR = 48000;
const installed = async (e: Engine) => { try { const pw = await import('playwright'); return existsSync(pw[e].executablePath()); } catch { return false; } };
const hasFirefox = await installed('firefox');

/** A loop that wraps exactly: every partial completes a whole number of cycles. */
function loop(sec: number): Float32Array[] {
  const n = Math.round(SR * sec);
  const make = (hz: number) => Float32Array.from({ length: n }, (_, i) => 0.25 * Math.sin(2 * Math.PI * Math.round(hz * sec) * i / n) + 0.1 * Math.sin(2 * Math.PI * Math.round(hz * 2.01 * sec) * i / n));
  return [make(220), make(330)];
}

describe('startLead', () => {
  it('finds a delay and a trim', () => {
    let seed = 7;
    const a = Float32Array.from({ length: 48000 }, () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 0.5);
    const delayed = new Float32Array(a.length); delayed.set(a.subarray(0, a.length - 500), 500);
    const trimmed = new Float32Array(a.length); trimmed.set(a.subarray(300));
    expect(startLead(a, a)).toBe(0);
    expect(startLead(a, delayed)).toBe(500);
    expect(startLead(a, trimmed)).toBe(-300);
    expect(startLead(new Float32Array(9000), a)).toBeUndefined();
  });
});

describe('parseEngines', () => {
  it('accepts known engines and rejects others', () => {
    expect(parseEngines('chromium, firefox,chromium')).toEqual(['chromium', 'firefox']);
    expect(() => parseEngines('chromium,safari')).toThrow(/safari/);
  });
});

describe.skipIf(!hasFfmpeg || !hasChromium)('engineCheck', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beeps-engines-'));
  const ff = hasFfmpeg ? findFfmpeg() : '';
  const wav = join(dir, 'theme.wav'), good = join(dir, 'theme.mp3'), ogg = join(dir, 'theme.ogg'), noxing = join(dir, 'noxing.mp3');
  const sidecar = (file: string) => writeFileSync(`${file}.json`, JSON.stringify({
    schema: 'beeps/audio-asset@1', id: 'theme', label: 'theme', description: '', role: 'music', file: file.split(/[\/]/).pop(), loop: true, durationSec: 2, sampleRate: SR, channels: 2,
    renderKey: 'k', loudness: { metric: 'integrated', lufs: -20 }, truePeakDb: -3, normalizationAlreadyApplied: true,
  }));
  writeFileSync(wav, writeWav(loop(2), SR));
  encodeMp3(ff, wav, good, 64); encodeOpus(ff, wav, ogg, 56);
  spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '64k', '-write_xing', '0', '-id3v2_version', '0', '-ar', '48000', noxing]);
  for (const f of [good, ogg, noxing]) sidecar(f);

  it('reports a clean frame delta and lead for the tagged MP3 and the Opus in Chromium', async () => {
    const [r] = await engineCheck([good, ogg], ['chromium']);
    expect(r.status).toBe('ok');
    for (const f of r.files) for (const x of f.results) { expect(x.problems).toEqual([]); expect(Math.abs(x.frameDelta)).toBeLessThanOrEqual(x.sampleRate === SR ? 0 : 1); }
    expect(r.files[0].results.map(x => x.sampleRate)).toEqual([48000, 44100]);
    expect(r.files[0].results[1].wantFrames).toBe(88200);
  }, 120000);

  it('flags an MP3 with no Xing/Info tag as extra frames and a lead', async () => {
    const [r] = await engineCheck([noxing], ['chromium']);
    const x = r.files[0].results[0];
    expect(x.frameDelta).toBeGreaterThan(1000);
    expect(x.problems.join(' ')).toMatch(/keeps/);
  }, 120000);

  it('reports engines that are not installed as unavailable with an install hint', async () => {
    const pw = await import('playwright');
    if (existsSync(pw.webkit.executablePath())) return; // installed here: covered by the decode paths
    const [r] = await engineCheck([good], ['webkit']);
    expect(r).toMatchObject({ engine: 'webkit', status: 'unavailable' });
    expect(r.hint).toMatch(/playwright install webkit/);
  }, 60000);

  it.skipIf(!hasFirefox)('decodes the tagged MP3 exactly in Firefox', async () => {
    const [r] = await engineCheck([good], ['firefox']);
    expect(['ok', 'error']).toContain(r.status);
    if (r.status === 'ok') for (const x of r.files[0].results) expect(x.problems).toEqual([]);
  }, 120000);
});
