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
