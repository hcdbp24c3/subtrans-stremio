import { describe, it, expect } from 'vitest';
import { durationOverrunOffset } from '../src/routes/subtitle.js';

describe('durationOverrunOffset', () => {
  it('returns negative offset when sub overruns video end beyond slack', () => {
    // sub ends at 5900s, video is 5839.6s → overrun 60.4s → offset -60.4
    expect(durationOverrunOffset(5839.6, 5900)).toBeCloseTo(5839.6 - 5900, 5);
  });

  it('returns 0 within slack window', () => {
    expect(durationOverrunOffset(5839.6, 5841)).toBe(0); // overrun 1.4s < 3s
  });

  it('returns 0 when videoDuration is null', () => {
    expect(durationOverrunOffset(null, 9999)).toBe(0);
  });

  it('returns 0 when videoDuration is NaN', () => {
    expect(durationOverrunOffset(NaN, 9999)).toBe(0);
  });

  it('clamps huge overrun to -600', () => {
    expect(durationOverrunOffset(100, 2000)).toBe(-600);
  });
});
