// tests/player/timing.test.ts
import { describe, expect, it } from 'vitest';
import { nextBarTime } from '../../runtime/player/timing.js';

describe('next bar time', () => {
  // 120 bpm in 4/4: one bar is 2 s.
  it('is the start before the music starts and on a bar line', () => {
    expect(nextBarTime(1, 0.5, 120, 4)).toBe(1);
    expect(nextBarTime(1, 1, 120, 4)).toBe(1);
    expect(nextBarTime(1, 3, 120, 4)).toBe(3);
  });

  it('rounds up to the next bar line', () => {
    expect(nextBarTime(1, 1.2, 120, 4)).toBe(3);
    expect(nextBarTime(1, 3.0001, 120, 4)).toBe(5);
  });

  it('restarts the bar grid at each loop when the loop is not whole bars', () => {
    // 5 s loop: bars at 0, 2, 4 then the loop restarts at 5.
    expect(nextBarTime(0, 4.5, 120, 4, 5)).toBe(5);
    expect(nextBarTime(0, 5.5, 120, 4, 5)).toBe(7);
  });
});
