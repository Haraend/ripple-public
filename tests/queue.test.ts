import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueTrack,
  getQueueSnapshot,
  handlePlayerIdle,
  initQueueBridge,
  onSessionDestroyed,
  removeUpcoming,
  clearUpcoming,
  resetQueueBridgeForTests,
  setLoopMode,
  skipTrack,
  stopQueue,
  type QueuedTrack,
} from '../src/modules/music/queue.js';
import { UserFacingError } from '../src/core/errors.js';
import { parseEnv, resetEnvCache } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';

const playing = new Set<string>();
let playImpl: (
  guildId: string,
  track: { title: string },
) => Promise<{ mode: 'copy' | 'transcode' }> = async (guildId, track) => {
  playing.add(guildId);
  void track;
  return { mode: 'copy' };
};

vi.mock('../src/modules/music/session-manager.js', () => ({
  getSession: (guildId: string) => (playing.has(guildId) ? { guildId } : undefined),
  isPlaybackActive: (guildId: string) => playing.has(guildId),
  playDirectUrl: async (guildId: string, track: { title: string }) => playImpl(guildId, track),
  stopPlayback: (guildId: string) => {
    playing.delete(guildId);
  },
  setPlayerIdleHandler: () => undefined,
  setSessionDestroyedHandler: () => undefined,
}));

function track(title: string, requestedBy = 'user'): QueuedTrack {
  return {
    title,
    url: `https://cdn.example.com/${title}.webm`,
    codec: 'opus',
    durationMs: 60_000,
    webpageUrl: `https://www.youtube.com/watch?v=${title}`,
    requestedBy,
  };
}

function deps() {
  const env = parseEnv({
    DISCORD_TOKEN: 'test-token',
    DISCORD_CLIENT_ID: '123456789012345678',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  });
  return { env, logger: createLogger(env) };
}

describe('music queue', () => {
  beforeEach(() => {
    playing.clear();
    playImpl = async (guildId, t) => {
      playing.add(guildId);
      void t;
      return { mode: 'copy' };
    };
    resetEnvCache();
    resetQueueBridgeForTests();
    initQueueBridge();
  });

  afterEach(() => {
    playing.clear();
    resetEnvCache();
    resetQueueBridgeForTests();
    vi.clearAllMocks();
  });

  it('starts first track and queues the second', async () => {
    const { env, logger } = deps();
    const first = await enqueueTrack('g1', track('a'), env, logger, 100);
    expect(first.started).toBe(true);
    const second = await enqueueTrack('g1', track('b'), env, logger, 100);
    expect(second.started).toBe(false);
    expect(second.position).toBe(1);
    const snap = getQueueSnapshot('g1');
    expect(snap.current?.title).toBe('a');
    expect(snap.upcoming.map((t) => t.title)).toEqual(['b']);
  });

  it('advances on idle when loop is off', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    await handlePlayerIdle('g1');
    expect(getQueueSnapshot('g1').current?.title).toBe('b');
    expect(getQueueSnapshot('g1').upcoming).toHaveLength(0);
  });

  it('restarts current on loop track', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    setLoopMode('g1', 'track');
    await handlePlayerIdle('g1');
    expect(getQueueSnapshot('g1').current?.title).toBe('a');
  });

  it('rotates finished track to end on loop queue', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    setLoopMode('g1', 'queue');
    await handlePlayerIdle('g1');
    const snap = getQueueSnapshot('g1');
    expect(snap.current?.title).toBe('b');
    expect(snap.upcoming.map((t) => t.title)).toEqual(['a']);
  });

  it('skip advances and clear/remove work', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    await enqueueTrack('g1', track('c'), env, logger, 100);
    const skipped = await skipTrack('g1');
    expect(skipped.skipped.title).toBe('a');
    expect(skipped.next?.title).toBe('b');
    const removed = removeUpcoming('g1', 1);
    expect(removed.title).toBe('c');
    expect(clearUpcoming('g1')).toBe(0);
    await stopQueue('g1');
    expect(getQueueSnapshot('g1').current).toBeNull();
  });

  it('rejects remove with invalid position', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    expect(() => removeUpcoming('g1', 9)).toThrow(UserFacingError);
  });

  it('concurrent enqueue starts one and queues the other', async () => {
    const { env, logger } = deps();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enteredPlay = false;
    playImpl = async (guildId, t) => {
      playing.add(guildId);
      enteredPlay = true;
      void t;
      await gate;
      return { mode: 'copy' };
    };

    const firstPromise = enqueueTrack('g1', track('a'), env, logger, 100);
    await vi.waitFor(() => {
      expect(enteredPlay).toBe(true);
      expect(getQueueSnapshot('g1').current?.title).toBe('a');
    });
    const secondPromise = enqueueTrack('g1', track('b'), env, logger, 100);
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.position).toBe(1);
    expect(getQueueSnapshot('g1').upcoming.map((t) => t.title)).toEqual(['b']);
  });

  it('does not skip ahead on UserFacingError capacity during auto-advance', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    await enqueueTrack('g1', track('c'), env, logger, 100);

    playImpl = async () => {
      throw new UserFacingError('The host is at capacity (2 concurrent streams). Try again later.');
    };

    await handlePlayerIdle('g1');
    const snap = getQueueSnapshot('g1');
    expect(snap.current).toBeNull();
    expect(snap.upcoming.map((t) => t.title)).toEqual(['b', 'c']);
  });

  it('overlapping idle and skip does not drop or duplicate tracks', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    await enqueueTrack('g1', track('c'), env, logger, 100);

    const idlePromise = handlePlayerIdle('g1');
    const skipPromise = skipTrack('g1');
    await Promise.all([idlePromise, skipPromise]);

    const snap = getQueueSnapshot('g1');
    const titles = [
      snap.current?.title,
      ...snap.upcoming.map((t) => t.title),
    ].filter((t): t is string => t !== undefined);

    // Serialized: either skip-then-suppressed-idle => [b,c], or idle-then-skip => [c].
    expect([['b', 'c'], ['c']]).toContainEqual(titles);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('preserves queue when session destroyed without clearQueue', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    onSessionDestroyed('g1', false);
    const snap = getQueueSnapshot('g1');
    expect(snap.current?.title).toBe('a');
    expect(snap.upcoming.map((t) => t.title)).toEqual(['b']);

    // Idle from player.stop during remount must not advance the preserved queue.
    await handlePlayerIdle('g1');
    const afterIdle = getQueueSnapshot('g1');
    expect(afterIdle.current?.title).toBe('a');
    expect(afterIdle.upcoming.map((t) => t.title)).toEqual(['b']);

    onSessionDestroyed('g1', true);
    expect(getQueueSnapshot('g1').current).toBeNull();
    expect(getQueueSnapshot('g1').upcoming).toHaveLength(0);
  });

  it('skip reports upcomingCount when next start fails', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    await enqueueTrack('g1', track('c'), env, logger, 100);

    playImpl = async () => {
      throw new UserFacingError('The host is at capacity (2 concurrent streams). Try again later.');
    };

    const result = await skipTrack('g1');
    expect(result.skipped.title).toBe('a');
    expect(result.next).toBeNull();
    expect(result.upcomingCount).toBe(2);
    expect(getQueueSnapshot('g1').upcoming.map((t) => t.title)).toEqual(['b', 'c']);
  });
});
