import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelEmptyChannelAutoleave,
  cancelIdleQueueAutoleave,
  hasEmptyChannelTimerForTest,
  hasIdleQueueTimerForTest,
  initAutoleave,
  resetAutoleaveForTests,
  scheduleEmptyChannelAutoleave,
  scheduleIdleQueueAutoleave,
} from '../src/modules/music/autoleave.js';

describe('autoleave timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAutoleaveForTests();
  });

  afterEach(() => {
    resetAutoleaveForTests();
    vi.useRealTimers();
  });

  it('fires empty-channel leave after timeout', () => {
    const leaves: string[] = [];
    initAutoleave((guildId) => {
      leaves.push(guildId);
    });
    scheduleEmptyChannelAutoleave('g1', 60_000);
    expect(hasEmptyChannelTimerForTest('g1')).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(leaves).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(leaves).toEqual(['g1']);
    expect(hasEmptyChannelTimerForTest('g1')).toBe(false);
  });

  it('cancels empty-channel timer when humans return', () => {
    const leaves: string[] = [];
    initAutoleave((guildId) => {
      leaves.push(guildId);
    });
    scheduleEmptyChannelAutoleave('g1', 60_000);
    cancelEmptyChannelAutoleave('g1');
    vi.advanceTimersByTime(120_000);
    expect(leaves).toEqual([]);
  });

  it('fires idle-queue leave and can be cancelled by activity', () => {
    const leaves: string[] = [];
    initAutoleave((guildId) => {
      leaves.push(guildId);
    });
    scheduleIdleQueueAutoleave('g1', 120_000);
    expect(hasIdleQueueTimerForTest('g1')).toBe(true);
    cancelIdleQueueAutoleave('g1');
    vi.advanceTimersByTime(200_000);
    expect(leaves).toEqual([]);

    scheduleIdleQueueAutoleave('g1', 120_000);
    vi.advanceTimersByTime(120_000);
    expect(leaves).toEqual(['g1']);
  });

  it('does not arm or fire idle-queue leave while humans are in VC', () => {
    const leaves: string[] = [];
    let alone = false;
    initAutoleave(
      (guildId) => {
        leaves.push(guildId);
      },
      () => alone,
    );

    scheduleIdleQueueAutoleave('g1', 120_000);
    expect(hasIdleQueueTimerForTest('g1')).toBe(false);
    vi.advanceTimersByTime(200_000);
    expect(leaves).toEqual([]);

    alone = true;
    scheduleIdleQueueAutoleave('g1', 120_000);
    expect(hasIdleQueueTimerForTest('g1')).toBe(true);
    alone = false;
    vi.advanceTimersByTime(120_000);
    expect(leaves).toEqual([]);
  });
});
