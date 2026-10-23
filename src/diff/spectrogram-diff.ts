// A signed spectrogram difference: where, and by how many dB, one sound has more energy than another. The numbers are the answer an agent
// can read; the image is the same data for anyone who can view it. Positive (red) is energy the second sound has more of.
import { stftPower } from '../measure/fft.ts';
import { LOG_BAND_EDGES } from '../measure/spectral.ts';
import { encodePng } from './png.ts';

const N = 2048, HOP = 512;
/** Rows of the log-frequency grid, and the range they cover. */
export const ROWS = 72, LO_HZ = 40, HI_HZ = 20000;
/** Columns of the time grid at most. */
export const MAX_COLS = 240;
/** The largest difference drawn or counted, dB; a cell further apart than this is clipped. */
export const CLIP_DB = 24;
/** A cell where both sounds are this far under the loudest cell of either is silence and does not count. */
const FLOOR_DB = 80;
const CELL_PX = 4;

export interface BandDiff { loHz: number; hiHz: number; db: number | null }
export interface ThirdDiff { thirdOf: 1 | 2 | 3; startSec: number; endSec: number; meanDb: number | null; bands: BandDiff[] }
export interface SpectrogramDiff {
  durationSec: number;
  cols: number;
  rows: number;
  /** Mean signed difference over every cell where either sound is audible, dB (second minus first). */
  meanDb: number | null;
  /** Fraction of the grid where either sound is audible. */
  activeFraction: number;
  bands: BandDiff[];
  thirds: ThirdDiff[];
  hints: string[];
  png: Buffer;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const fmtHz = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));
const edge = (r: number) => LO_HZ * (HI_HZ / LO_HZ) ** (r / ROWS);

/** dB per cell on the shared grid: rows are log frequency (low first), columns are equal slices of the longer sound. */
function grid(x: Float32Array, sr: number, cols: number, totalSec: number): Float64Array {
  const frames = stftPower(x, N, HOP);
  const binHz = sr / N, bins = N / 2 + 1;
  const power = new Float64Array(ROWS * cols);
  const counts = new Float64Array(cols);
  for (let f = 0; f < frames.length; f++) {
    const c = Math.min(cols - 1, Math.floor(((f * HOP + N / 2) / sr / totalSec) * cols));
    counts[c]++;
    for (let r = 0; r < ROWS; r++) {
      const lo = edge(r), hi = edge(r + 1);
      const k0 = Math.max(1, Math.ceil(lo / binHz)), k1 = Math.min(bins - 1, Math.ceil(hi / binHz) - 1);
      let p = 0;
      if (k1 >= k0) { for (let k = k0; k <= k1; k++) p += frames[f][k]; p /= k1 - k0 + 1; } else p = frames[f][Math.min(bins - 1, Math.max(1, Math.round(Math.sqrt(lo * hi) / binHz)))];
      power[r * cols + c] += p;
    }
  }
  const db = new Float64Array(ROWS * cols);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < cols; c++) db[r * cols + c] = 10 * Math.log10((counts[c] ? power[r * cols + c] / counts[c] : 0) + 1e-18);
  return db;
}

/** blue (second quieter) - white - red (second louder). */
function colour(d: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, d / CLIP_DB));
  const a = Math.abs(t);
  const lerp = (from: number, to: number) => Math.round(from + (to - from) * a);
  return t >= 0 ? [lerp(255, 180), lerp(255, 4), lerp(255, 38)] : [lerp(255, 59), lerp(255, 76), lerp(255, 192)];
}

export function spectrogramDiff(a: Float32Array, b: Float32Array, sr: number): SpectrogramDiff {
  const totalSec = Math.max(a.length, b.length) / sr;
  const cols = Math.max(3, Math.min(MAX_COLS, Math.ceil((totalSec * sr) / HOP)));
  const ga = grid(a, sr, cols, totalSec), gb = grid(b, sr, cols, totalSec);
  let top = -Infinity;
  for (let i = 0; i < ga.length; i++) top = Math.max(top, ga[i], gb[i]);
  const floor = top - FLOOR_DB;
  const diff = new Float64Array(ga.length), active = new Uint8Array(ga.length);
  let sum = 0, n = 0;
  for (let i = 0; i < ga.length; i++) {
    if (Math.max(ga[i], gb[i]) <= floor) continue;
    active[i] = 1;
    diff[i] = Math.max(-CLIP_DB, Math.min(CLIP_DB, gb[i] - ga[i]));
    sum += diff[i]; n++;
  }
  const mean = (rows: [number, number], colRange: [number, number]) => {
    let s = 0, k = 0;
    for (let r = rows[0]; r < rows[1]; r++) for (let c = colRange[0]; c < colRange[1]; c++) if (active[r * cols + c]) { s += diff[r * cols + c]; k++; }
    return k ? r1(s / k) : null;
  };
  const rowOf = (hz: number) => Math.round(ROWS * Math.log(hz / LO_HZ) / Math.log(HI_HZ / LO_HZ));
  const bandRows = LOG_BAND_EDGES.slice(0, -1).map((lo, i) => ({ loHz: lo, hiHz: LOG_BAND_EDGES[i + 1], rows: [Math.max(0, rowOf(lo)), Math.min(ROWS, rowOf(LOG_BAND_EDGES[i + 1]))] as [number, number] }));
  const bandsFor = (colRange: [number, number]): BandDiff[] => bandRows.map(b => ({ loHz: b.loHz, hiHz: b.hiHz, db: mean(b.rows, colRange) }));
  const bands = bandsFor([0, cols]);
  const thirds: ThirdDiff[] = ([1, 2, 3] as const).map(t => {
    const range: [number, number] = [Math.floor(((t - 1) * cols) / 3), Math.floor((t * cols) / 3)];
    return { thirdOf: t, startSec: r1(((t - 1) * totalSec) / 3), endSec: r1((t * totalSec) / 3), meanDb: mean([0, ROWS], range), bands: bandsFor(range) };
  });

  const hints: string[] = [];
  for (const bd of bands) if (bd.db !== null && Math.abs(bd.db) >= 3) hints.push(`${fmtHz(bd.loHz)}-${fmtHz(bd.hiHz)} Hz: the second sound has ${Math.abs(bd.db)} dB ${bd.db > 0 ? 'more' : 'less'} energy over the whole sound`);
  for (const t of thirds) {
    const worst = t.bands.filter(x => x.db !== null).sort((p, q) => Math.abs(q.db!) - Math.abs(p.db!))[0];
    if (worst && Math.abs(worst.db!) >= 6) hints.push(`${t.startSec}-${t.endSec} s: ${fmtHz(worst.loHz)}-${fmtHz(worst.hiHz)} Hz differs most, ${worst.db! > 0 ? '+' : ''}${worst.db} dB`);
  }
  if (!n) hints.push('both sounds are silent on this grid, so there is nothing to compare');

  // The image: frequency up, time right, a legend strip under it.
  const w = cols * CELL_PX, plotH = ROWS * CELL_PX, legendH = 12, gap = 6, h = plotH + gap + legendH;
  const rgb = new Uint8Array(w * h * 3).fill(255);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < cols; c++) {
      const [R, G, B] = active[r * cols + c] ? colour(diff[r * cols + c]) : [255, 255, 255];
      for (let py = 0; py < CELL_PX; py++) for (let px = 0; px < CELL_PX; px++) {
        const o = (((ROWS - 1 - r) * CELL_PX + py) * w + c * CELL_PX + px) * 3;
        rgb[o] = R; rgb[o + 1] = G; rgb[o + 2] = B;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    const [R, G, B] = colour(((x / (w - 1)) * 2 - 1) * CLIP_DB);
    for (let y = plotH + gap; y < h; y++) { const o = (y * w + x) * 3; rgb[o] = R; rgb[o + 1] = G; rgb[o + 2] = B; }
  }
  return { durationSec: r1(totalSec), cols, rows: ROWS, meanDb: n ? r1(sum / n) : null, activeFraction: Math.round((n / ga.length) * 1000) / 1000, bands, thirds, hints, png: encodePng(w, h, rgb) };
}
