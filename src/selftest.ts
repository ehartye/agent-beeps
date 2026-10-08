// `beeps player selftest`: a tiny static page that decodes a known loop in each delivered format through the vendored player's own
// loader and prints, per audio context rate, the frame delta and the start lead against the loop the page synthesises itself.
// Open it on a real iPhone or Mac Safari (nobody can measure those from a Windows or Linux box) and paste the copyable result.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BeepsError } from './errors.ts';
import { writeWav } from './audio/wav.ts';
import { encodeMp3, encodeOpus, findFfmpeg } from './compress.ts';
import { exportPlayer } from './commands/player.ts';

/** Integer frequencies (so the loop is exactly periodic at any rate), prime-ish so the sum never looks tonal to a correlator. */
export const SELFTEST_SIGNAL = {
  seconds: 2, baseRate: 48000, amplitude: 0.07,
  freqs: [220, 277, 331, 443, 587, 709, 953, 1201, 1597, 2003],
  phases: [[0.3, 1.1, 2.0, 0.7, 1.9, 2.6, 0.2, 1.4, 2.2, 0.9], [1.7, 0.4, 2.9, 1.3, 0.6, 2.1, 1.0, 2.7, 0.1, 1.5]],
} as const;

/** The known loop for one channel at `rate`; the page computes the same formula. */
export function selftestChannel(channel: 0 | 1, rate: number): Float32Array {
  const s = SELFTEST_SIGNAL, n = Math.round(rate * s.seconds), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < s.freqs.length; k++) v += Math.sin(2 * Math.PI * s.freqs[k] * i / rate + s.phases[channel][k]);
    out[i] = s.amplitude * v;
  }
  return out;
}

export const SELFTEST_FORMATS = ['opus', 'mp3', 'wav'] as const;
export type SelftestFormat = typeof SELFTEST_FORMATS[number];
const FILES: Record<SelftestFormat, string> = { opus: 'selftest.ogg', mp3: 'selftest.mp3', wav: 'selftest.wav' };

/** Write <dir>/beeps-selftest/: index.html, the vendored player, and the known loop as WAV (the control) plus each requested encode. */
export function writeSelftest(dir: string, formats: SelftestFormat[] = ['opus', 'mp3']): { root: string; index: string; files: string[]; frames: number } {
  const root = join(resolve(dir), 'beeps-selftest');
  mkdirSync(root, { recursive: true });
  exportPlayer(root);
  const rate = SELFTEST_SIGNAL.baseRate, frames = rate * SELFTEST_SIGNAL.seconds;
  const wav = join(root, FILES.wav);
  writeFileSync(wav, writeWav([selftestChannel(0, rate), selftestChannel(1, rate)], rate));
  const files = [FILES.wav];
  const want = [...new Set<SelftestFormat>(['wav', ...formats])];
  if (want.some(f => f !== 'wav')) {
    const ffmpeg = findFfmpeg();
    if (want.includes('opus')) { encodeOpus(ffmpeg, wav, join(root, FILES.opus), 56); files.push(FILES.opus); }
    if (want.includes('mp3')) { encodeMp3(ffmpeg, wav, join(root, FILES.mp3), 80); files.push(FILES.mp3); }
  }
  const index = join(root, 'index.html');
  writeFileSync(index, selftestPage(files));
  return { root, index, files, frames };
}

export function parseSelftestFormats(list: string): SelftestFormat[] {
  const names = list.split(',').map(s => s.trim()).filter(Boolean);
  const bad = names.filter(n => !(SELFTEST_FORMATS as readonly string[]).includes(n));
  if (bad.length || !names.length) throw new BeepsError('E_USAGE', `--formats takes ${SELFTEST_FORMATS.join(', ')} separated by commas, not ${bad.join(',') || list}`);
  return names as SelftestFormat[];
}

export function selftestPage(files: string[]): string {
  const s = SELFTEST_SIGNAL;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>beeps player selftest</title>
<style>
  :root { color-scheme: light dark; font: 16px/1.4 system-ui, sans-serif; }
  body { margin: 0 auto; padding: 16px; max-width: 46rem; }
  button { font: inherit; padding: .6rem 1.2rem; margin: .5rem .5rem .5rem 0; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { text-align: left; padding: .25rem .4rem; border-bottom: 1px solid #8884; }
  .ok { color: #0a7a2f; } .bad { color: #c0261c; font-weight: 600; }
  textarea { width: 100%; height: 11rem; font: .75rem/1.3 ui-monospace, monospace; box-sizing: border-box; }
</style></head><body>
<h1>beeps player selftest</h1>
<p>Decodes a known 2 s stereo loop in each delivered format through the vendored player's loader, in a realtime AudioContext (the device rate, as the player uses) and in OfflineAudioContexts at 48000 and 44100 Hz. A gapless decode has <b>delta 0</b> and <b>lead 0</b>. Tap Run, then Copy and paste the result.</p>
<button id="run">Run</button><button id="copy" disabled>Copy result</button>
<table id="rows"><thead><tr><th>context</th><th>file</th><th>frames</th><th>want</th><th>delta</th><th>lead</th><th></th></tr></thead><tbody></tbody></table>
<textarea id="out" readonly placeholder="result appears here"></textarea>
<script type="module">
import { createLoader } from './beeps-player/player/loader.js';
const FILES = ${JSON.stringify(files)};
const SIG = ${JSON.stringify({ seconds: s.seconds, baseRate: s.baseRate, amplitude: s.amplitude, freqs: s.freqs, phases: s.phases })};
const MAX_LEAD = 3000, WINDOW = 4096;
const Ctx = window.AudioContext || window.webkitAudioContext;
const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;

function reference(channel, rate) {
  const n = Math.round(rate * SIG.seconds), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < SIG.freqs.length; k++) v += Math.sin(2 * Math.PI * SIG.freqs[k] * i / rate + SIG.phases[channel][k]);
    out[i] = SIG.amplitude * v;
  }
  return out;
}
/** Frames the decode leads the source (negative: trimmed from the start); undefined when the data is too short. */
function lead(want, got) {
  const from = MAX_LEAD, to = Math.min(from + WINDOW, want.length, got.length);
  if (to - from < 256) return undefined;
  let best = -Infinity, bestK = 0;
  for (let k = -MAX_LEAD; k <= MAX_LEAD; k++) {
    let s = 0;
    for (let i = from; i < to; i++) s += got[i] * want[i - k];
    if (s > best) { best = s; bestK = k; }
  }
  return bestK;
}
const decodeWith = ctx => data => new Promise((res, rej) => { const p = ctx.decodeAudioData(data, res, rej); if (p && p.then) p.then(res, rej); });

async function run() {
  const rows = document.querySelector('#rows tbody'), out = document.querySelector('#out');
  rows.textContent = ''; out.value = 'running...';
  const results = [];
  const contexts = [];
  if (Ctx) contexts.push({ label: 'AudioContext', make: () => new Ctx() });
  else results.push({ context: 'AudioContext', error: 'no AudioContext' });
  if (Offline) for (const r of [48000, 44100]) contexts.push({ label: 'Offline ' + r, make: () => new Offline(2, r, r) });
  else results.push({ context: 'OfflineAudioContext', error: 'no OfflineAudioContext (no Web Audio decode path)' });
  for (const c of contexts) {
    let ctx;
    try { ctx = c.make(); } catch (e) { results.push({ context: c.label, error: 'could not create: ' + e }); continue; }
    const rate = ctx.sampleRate;
    for (const file of FILES) {
      const errors = [];
      const loader = createLoader({ catalog: { assets: {} }, base: '', fetcher: url => fetch(url), report: (code, msg) => errors.push(code + ': ' + msg), now: () => performance.now() / 1000, decode: decodeWith(ctx) });
      const row = { context: c.label + ' @' + rate, file };
      try {
        const buf = await loader.load(file);
        if (!buf) row.error = errors.join('; ') || 'decode failed';
        else {
          const want = Math.round(SIG.baseRate * SIG.seconds * rate / SIG.baseRate);
          row.channels = buf.numberOfChannels; row.frames = buf.length; row.want = want; row.delta = buf.length - want;
          row.lead = lead(reference(0, buf.sampleRate), buf.getChannelData(0));
          // Converting to another rate rounds: one frame either way is not a defect.
          const tol = rate === SIG.baseRate ? 0 : 1;
          row.pass = Math.abs(row.delta) <= tol && (row.lead === 0 || row.lead === undefined);
        }
      } catch (e) { row.error = String(e); }
      results.push(row);
      const tr = document.createElement('tr');
      const cell = t => { const td = document.createElement('td'); td.textContent = t; tr.appendChild(td); return td; };
      cell(row.context); cell(file); cell(row.frames ?? ''); cell(row.want ?? ''); cell(row.delta ?? ''); cell(row.lead ?? '');
      const v = cell(row.error ? 'FAIL: ' + row.error : row.pass ? 'pass' : 'FAIL'); v.className = row.pass ? 'ok' : 'bad';
      rows.appendChild(tr);
    }
    if (ctx.close && c.label === 'AudioContext') ctx.close();
  }
  const report = { tool: 'beeps player selftest', userAgent: navigator.userAgent, when: new Date().toISOString(), hasAudioContext: !!Ctx, hasOffline: !!Offline, passed: results.length > 0 && results.every(r => r.pass), results };
  window.__selftest = report;
  out.value = JSON.stringify(report, null, 1);
  document.querySelector('#copy').disabled = false;
}
document.querySelector('#run').addEventListener('click', run);
document.querySelector('#copy').addEventListener('click', async () => {
  const out = document.querySelector('#out');
  try { await navigator.clipboard.writeText(out.value); } catch (e) { out.select(); document.execCommand && document.execCommand('copy'); }
});
</script></body></html>
`;
}
