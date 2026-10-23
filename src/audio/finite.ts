// A render that produced NaN or infinite samples is broken, not quiet: the WAV writer turns them into silence or full scale, and the
// measurements around them read as numbers. Every render path counts them first and fails with the count.

/** How many samples across `channels` are NaN or infinite. */
export function countNonFinite(channels: readonly Float32Array[]): number {
  let n = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) n++;
  return n;
}

/** The message for a render with `n` such samples: names the likely cause so the author knows where to look. */
export const nonFiniteMessage = (what: string, n: number): string =>
  `${what} rendered ${n} sample${n === 1 ? '' : 's'} that are not finite numbers (NaN or infinity), so the WAV would carry silence or clicks there: a filter, feedback or drive stage is unstable`;
