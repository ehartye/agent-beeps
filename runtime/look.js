// "Look" images: waveform + log-frequency spectrogram + feature strip, drawn on a canvas.
// The agent cannot hear; it can look. Used by the CLI (headless page) and the audition page.

const W = 900, H = 300, WAVE_H = 90, SPEC_H = 150;

/** @param {Float64Array} re @param {Float64Array} im */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const cr = Math.cos(ang * k), ci = Math.sin(ang * k);
      const a = i + k, b = a + len / 2;
      const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}

/** Perceptual-ish colormap from black through violet and orange to pale yellow. @param {number} t 0..1 */
function heat(t) {
  t = Math.max(0, Math.min(1, t));
  const r = Math.round(255 * Math.min(1, t * 1.6));
  const g = Math.round(255 * Math.max(0, Math.min(1, (t - 0.35) * 1.6)));
  const b = Math.round(255 * Math.max(0, Math.min(1, t < 0.4 ? t * 2 : 1 - (t - 0.4) * 2.2)));
  return [r, g, b];
}

const fmt = (/** @type {number} */ x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');

/**
 * @param {CanvasRenderingContext2D} g
 * @param {Float32Array} x mono samples
 * @param {number} sr
 * @param {Record<string, any>} f features
 * @param {string} label
 * @param {number} ox @param {number} oy
 */
export function drawLook(g, x, sr, f, label, ox = 0, oy = 0) {
  g.save();
  g.translate(ox, oy);
  g.fillStyle = '#101014';
  g.fillRect(0, 0, W, H);

  // Waveform: min/max per column, time axis shared with the spectrogram
  let peak = 1e-9;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const per = x.length / W;
  g.strokeStyle = '#8fb7ff';
  g.beginPath();
  for (let c = 0; c < W; c++) {
    let lo = 0, hi = 0;
    for (let i = Math.floor(c * per); i < Math.floor((c + 1) * per); i++) { lo = Math.min(lo, x[i]); hi = Math.max(hi, x[i]); }
    g.moveTo(c + 0.5, WAVE_H / 2 - (hi / peak) * (WAVE_H / 2 - 4));
    g.lineTo(c + 0.5, WAVE_H / 2 - (lo / peak) * (WAVE_H / 2 - 4) + 0.5);
  }
  g.stroke();

  // Spectrogram: 1024-point frames, one per column, log frequency 50 Hz – 16 kHz, 70 dB range
  const n = 1024;
  const img = g.createImageData(W, SPEC_H);
  const fMin = Math.log(50), fMax = Math.log(Math.min(16000, sr / 2));
  const cols = [];
  let maxDb = -Infinity;
  for (let c = 0; c < W; c++) {
    const start = Math.floor((c / W) * Math.max(0, x.length - n));
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n && start + i < x.length; i++) re[i] = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    fft(re, im);
    const col = new Float64Array(SPEC_H);
    for (let row = 0; row < SPEC_H; row++) {
      const hz = Math.exp(fMin + ((SPEC_H - 1 - row) / (SPEC_H - 1)) * (fMax - fMin));
      const k = Math.min(n / 2, Math.round((hz / sr) * n));
      const db = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-20);
      col[row] = db;
      if (db > maxDb) maxDb = db;
    }
    cols.push(col);
  }
  for (let c = 0; c < W; c++) for (let row = 0; row < SPEC_H; row++) {
    const [r, gg, b] = heat((cols[c][row] - (maxDb - 70)) / 70);
    const p = (row * W + c) * 4;
    img.data[p] = r; img.data[p + 1] = gg; img.data[p + 2] = b; img.data[p + 3] = 255;
  }
  g.putImageData(img, ox, oy + WAVE_H);
  g.fillStyle = '#ffffff88';
  g.font = '10px monospace';
  for (const hz of [100, 1000, 10000]) {
    const y = WAVE_H + (SPEC_H - 1) * (1 - (Math.log(hz) - fMin) / (fMax - fMin));
    g.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, 3, y);
  }

  // Feature strip
  g.fillStyle = '#e8e8f0';
  g.font = 'bold 13px sans-serif';
  g.fillText(label, 8, WAVE_H + SPEC_H + 18);
  g.font = '12px monospace';
  const line1 = `render ${fmt(x.length / sr, 2)}s  energy ${fmt(f.energyLengthSec * 1000, 0)}ms  attack ${fmt(f.attackSec * 1000, 1)}ms  played at ${fmt(f.delivered?.momentaryMaxLufs)} LUFS  TP ${fmt(f.delivered?.truePeakDb)}dB`;
  const line2 = `centroid ${fmt(f.centroidHz, 0)}Hz  sharp ${fmt(f.sharpness, 2)}  rough ${fmt(f.roughness, 2)}  flat ${fmt(f.flatness, 2)}  pitch ${f.pitchStrength >= 0.7 ? fmt(f.pitchHz, 0) + 'Hz' : 'none'} ${f.pitchDirection ? (f.pitchDirection > 0 ? '↑' : '↓') + fmt(Math.abs(f.pitchDirection), 1) + 'st' : ''}`;
  g.fillText(line1, 8, WAVE_H + SPEC_H + 36);
  g.fillText(line2, 8, WAVE_H + SPEC_H + 52);
  g.restore();
}

export const LOOK_SIZE = { width: W, height: H };

/**
 * One PNG per item, or one contact sheet (2 columns) when sheet is true.
 * @param {{ pcm: string, sr: number, features: Record<string, any>, label: string }[]} items pcm = base64 Float32 mono
 * @param {boolean} sheet
 */
export function renderLooks(items, sheet) {
  const decode = (/** @type {string} */ b64) => {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  };
  const cols = sheet ? Math.min(2, items.length) : 1;
  const rows = sheet ? Math.ceil(items.length / cols) : 1;
  const out = [];
  const makeCanvas = (/** @type {number} */ w, /** @type {number} */ h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };
  if (sheet) {
    const c = makeCanvas(cols * (W + 8), rows * (H + 8));
    const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    items.forEach((it, i) => drawLook(g, decode(it.pcm), it.sr, it.features, it.label, (i % cols) * (W + 8), Math.floor(i / cols) * (H + 8)));
    out.push(c.toDataURL('image/png'));
  } else {
    for (const it of items) {
      const c = makeCanvas(W, H);
      drawLook(/** @type {CanvasRenderingContext2D} */ (c.getContext('2d')), decode(it.pcm), it.sr, it.features, it.label);
      out.push(c.toDataURL('image/png'));
    }
  }
  return out;
}

const SW = 1400, SH = 440, BAND_H = 22, SWAVE_H = 110, SSPEC_H = 200;
const SECTION_COLORS = ['#3b4a8a', '#6a3b8a', '#2f6f6a', '#8a5a2b', '#7a2f4a', '#4a6a2f'];

/**
 * A song's look: section bands, waveform with the per-second loudness arc (orange), a log-frequency
 * spectrogram of the whole piece, and the headline numbers per section.
 * @param {Float32Array[]} channels
 * @param {Record<string, any>} f song features (see src/measure/song.ts)
 * @param {string} label
 */
export function renderSongLook(channels, f, label) {
  const sr = 48000;
  const n = channels[0].length;
  const x = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) x[i] += ch[i] / channels.length;
  const c = document.createElement('canvas');
  c.width = SW; c.height = SH;
  const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  g.fillStyle = '#0c0c10'; g.fillRect(0, 0, SW, SH);
  const dur = n / sr;
  const tx = (/** @type {number} */ t) => (t / dur) * SW;

  // Sections
  g.font = '11px sans-serif';
  (f.sections ?? []).forEach((/** @type {any} */ s, /** @type {number} */ i) => {
    g.fillStyle = SECTION_COLORS[i % SECTION_COLORS.length];
    g.fillRect(tx(s.start), 0, Math.max(1, tx(s.end) - tx(s.start) - 1), BAND_H);
    g.fillStyle = '#fff';
    g.fillText(s.name, tx(s.start) + 4, 15);
  });

  // Waveform
  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  const per = n / SW, mid = BAND_H + SWAVE_H / 2;
  g.strokeStyle = '#8fb7ff';
  g.beginPath();
  for (let col = 0; col < SW; col++) {
    let lo = 0, hi = 0;
    for (let i = Math.floor(col * per); i < Math.floor((col + 1) * per); i++) { lo = Math.min(lo, x[i]); hi = Math.max(hi, x[i]); }
    g.moveTo(col + 0.5, mid - (hi / peak) * (SWAVE_H / 2 - 4));
    g.lineTo(col + 0.5, mid - (lo / peak) * (SWAVE_H / 2 - 4) + 0.5);
  }
  g.stroke();
  // Loudness arc: -50 LUFS at the bottom of the waveform band, -5 at the top
  if (f.arc?.length) {
    g.strokeStyle = '#ffae42'; g.lineWidth = 2;
    g.beginPath();
    f.arc.forEach((/** @type {number} */ v, /** @type {number} */ i) => {
      const y = BAND_H + SWAVE_H - ((Math.max(-50, Math.min(-5, v)) + 50) / 45) * SWAVE_H;
      const xx = tx(i + 0.5);
      if (i) g.lineTo(xx, y); else g.moveTo(xx, y);
    });
    g.stroke(); g.lineWidth = 1;
  }

  // Spectrogram
  const fftN = 4096;
  const img = g.createImageData(SW, SSPEC_H);
  const fMin = Math.log(30), fMax = Math.log(16000);
  const cols = [];
  let maxDb = -Infinity;
  const win = new Float64Array(fftN);
  for (let i = 0; i < fftN; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftN - 1));
  for (let col = 0; col < SW; col++) {
    const start = Math.floor((col / SW) * Math.max(0, n - fftN));
    const re = new Float64Array(fftN), im = new Float64Array(fftN);
    for (let i = 0; i < fftN && start + i < n; i++) re[i] = x[start + i] * win[i];
    fft(re, im);
    const out = new Float64Array(SSPEC_H);
    for (let row = 0; row < SSPEC_H; row++) {
      const hz = Math.exp(fMin + ((SSPEC_H - 1 - row) / (SSPEC_H - 1)) * (fMax - fMin));
      const k = Math.min(fftN / 2, Math.round((hz / sr) * fftN));
      const d = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-20);
      out[row] = d;
      if (d > maxDb) maxDb = d;
    }
    cols.push(out);
  }
  for (let col = 0; col < SW; col++) for (let row = 0; row < SSPEC_H; row++) {
    const [rr, gg, b] = heat((cols[col][row] - (maxDb - 75)) / 75);
    const p = (row * SW + col) * 4;
    img.data[p] = rr; img.data[p + 1] = gg; img.data[p + 2] = b; img.data[p + 3] = 255;
  }
  const specY = BAND_H + SWAVE_H;
  g.putImageData(img, 0, specY);
  g.fillStyle = '#ffffff99'; g.font = '10px monospace';
  for (const hz of [50, 100, 250, 1000, 4000, 10000]) {
    const y = specY + (SSPEC_H - 1) * (1 - (Math.log(hz) - fMin) / (fMax - fMin));
    g.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, 3, y);
  }
  // Section boundaries through both panes
  g.strokeStyle = '#ffffff40';
  for (const s of f.sections ?? []) { g.beginPath(); g.moveTo(tx(s.start) + 0.5, BAND_H); g.lineTo(tx(s.start) + 0.5, specY + SSPEC_H); g.stroke(); }

  // Numbers
  const ty = specY + SSPEC_H;
  const mmss = (/** @type {number} */ s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  g.fillStyle = '#e8e8f0'; g.font = 'bold 14px sans-serif';
  g.fillText(label, 8, ty + 20);
  g.font = '12px monospace';
  g.fillText(`${mmss(dur)}  played at ${fmt(f.delivered?.integratedLufs)} LUFS-I  range ${fmt(f.loudnessRangeLu)} LU  TP ${fmt(f.delivered?.truePeakDb)} dB  centroid ${fmt(f.centroidHz, 0)} Hz  low ${fmt(100 * f.lowShare, 0)}%  width ${fmt(f.stereoWidth, 2)}${f.seamDb !== undefined ? `  seam ${fmt(f.seamDb)} dB` : ''}`, 8, ty + 40);
  const secs = (f.sections ?? []).map((/** @type {any} */ s) => `${s.name} ${fmt(s.lufs)}/${fmt(s.centroidHz, 0)}Hz`).join('  ');
  g.fillText(secs.slice(0, 190), 8, ty + 58);
  if (secs.length > 190) g.fillText(secs.slice(190, 380), 8, ty + 74);
  return c.toDataURL('image/png');
}
