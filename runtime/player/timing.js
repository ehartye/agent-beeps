// runtime/player/timing.js
/**
 * The next bar line at or after `now` for music that started at `startTime`. When `loopSec` is
 * given and is not a whole number of bars, the grid restarts at every loop point.
 * @param {number} startTime
 * @param {number} now
 * @param {number} bpm
 * @param {number} meter beats per bar
 * @param {number} [loopSec]
 */
export function nextBarTime(startTime, now, bpm, meter, loopSec = Infinity) {
  if (now <= startTime) return startTime;
  const bar = (60 / bpm) * meter;
  const looped = Number.isFinite(loopSec) && loopSec > 0;
  const loopStart = looped ? startTime + Math.floor((now - startTime) / loopSec) * loopSec : startTime;
  const next = Math.ceil((now - loopStart) / bar - 1e-9) * bar;
  return looped && next > loopSec - 1e-9 ? loopStart + loopSec : loopStart + next;
}
