// Which track sets the mix's peaks. A song whose loudness trim stops at the true-peak ceiling sits under its target, and the cure is to
// lower whichever part makes the peaks: stems alone say how loud each part is overall, not which one is on top at the moments that count.

export interface PeakMoment {
  /** Seconds from the start of the mix. */
  at: number;
  /** The mix's level there, dBFS. */
  mixDb: number;
  /** The track whose own stem is loudest at that moment, and that stem's level, dBFS. */
  track: string;
  stemDb: number;
}

export interface PeakAttribution {
  /** The loudest moments the mix has, one per `gapSec`, loudest first. */
  moments: PeakMoment[];
  /** How many of those moments each track is loudest at, most first. */
  setBy: { track: string; peaks: number; share: number }[];
  /** The same count over only the moments within `limitDb` of the loudest: the peaks that stop the loudness trim, so the parts to lower first. */
  limiting: { track: string; peaks: number }[];
}

const db = (x: number) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -Infinity);

/** The `count` highest sample peaks of the mix, at least `gapSec` apart, as frame indexes. */
export function loudestFrames(mix: readonly Float32Array[], sampleRate: number, count: number, gapSec: number): number[] {
  const n = mix[0]?.length ?? 0, gap = Math.max(1, Math.round(gapSec * sampleRate));
  const frames: { i: number; v: number }[] = [];
  // One candidate per gap-sized window keeps this linear in the length and never lets one long peak crowd out the rest.
  for (let start = 0; start < n; start += gap) {
    let best = 0, at = start;
    for (let i = start; i < Math.min(n, start + gap); i++) {
      let v = 0;
      for (const ch of mix) v = Math.max(v, Math.abs(ch[i]));
      if (v > best) { best = v; at = i; }
    }
    if (best > 0) frames.push({ i: at, v: best });
  }
  return frames.sort((a, b) => b.v - a.v).slice(0, count).map(f => f.i);
}

/**
 * `loadStem` is called once per track, in order, so only one stem is in memory at a time. Stems and mix are sample-aligned (stems are the
 * song rendered with one track's notes), so the same frame index is the same instant in both. The clipper makes the stems not sum to the
 * mix exactly near the ceiling, which is why this ranks stems against each other rather than adding them up.
 */
export function attributePeaks(mix: readonly Float32Array[], sampleRate: number, tracks: readonly string[], loadStem: (track: string) => readonly Float32Array[], { count = 24, gapSec = 0.1, limitDb = 1 } = {}): PeakAttribution {
  const frames = loudestFrames(mix, sampleRate, count, gapSec);
  if (!frames.length) return { moments: [], setBy: [], limiting: [] };
  // A short window around each frame, so a stem whose own peak lands a sample or two away is still counted.
  const window = 2;
  const level = (chs: readonly Float32Array[], i: number) => {
    let v = 0;
    for (const ch of chs) for (let k = Math.max(0, i - window); k <= Math.min(ch.length - 1, i + window); k++) v = Math.max(v, Math.abs(ch[k]));
    return v;
  };
  const best = frames.map(() => ({ track: '', v: 0 }));
  for (const track of tracks) {
    const chs = loadStem(track);
    frames.forEach((i, f) => { const v = level(chs, i); if (v > best[f].v) best[f] = { track, v }; });
  }
  const moments = frames.map((i, f) => ({ at: Math.round(i / sampleRate * 100) / 100, mixDb: db(level(mix, i)), track: best[f].track, stemDb: db(best[f].v) }));
  const tally = new Map<string, number>();
  for (const m of moments) if (m.track) tally.set(m.track, (tally.get(m.track) ?? 0) + 1);
  const setBy = [...tally].map(([track, peaks]) => ({ track, peaks, share: Math.round(peaks / moments.length * 100) / 100 })).sort((a, b) => b.peaks - a.peaks);
  const top = moments[0].mixDb;
  const near = new Map<string, number>();
  for (const m of moments) if (m.track && m.mixDb >= top - limitDb) near.set(m.track, (near.get(m.track) ?? 0) + 1);
  const limiting = [...near].map(([track, peaks]) => ({ track, peaks })).sort((a, b) => b.peaks - a.peaks);
  return { moments, setBy, limiting };
}
