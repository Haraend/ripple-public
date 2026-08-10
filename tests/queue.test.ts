import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  enqueueTrack,
  getQueueSnapshot,
  handlePlayerIdle,
  initQueueBridge,
  onSessionDestroyed,
  previousTrack,
  removeUpcoming,
  clearUpcoming,
  resetQueueBridgeForTests,
  restartCurrentAt,
  setFreshUrlResolverForTests,
  setLoopMode,
  skipTrack,
  stopQueue,
  type QueuedTrack,
} from '../src/modules/music/queue.js';
import { CapacityError, UserFacingError } from '../src/core/errors.js';
import { parseEnv, resetEnvCache } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';

const playing = new Set<string>();
const joined = new Set<string>();
let remountHandler: ((guildId: string, resumeMs: number) => void | Promise<void>) | null =
  null;
let playImpl: (
  guildId: string,
  track: { title: string },
) => Promise<{ mode: 'copy' | 'transcode' }> = async (guildId, track) => {
  playing.add(guildId);
  void track;
  return { mode: 'copy' };
};

vi.mock('../src/modules/music/session-manager.js', () => ({
  getSession: (guildId: string) => (joined.has(guildId) ? { guildId } : undefined),
  isPlaybackActive: (guildId: string) => playing.has(guildId),
  playDirectUrl: async (guildId: string, track: { title: string }) => {
    joined.add(guildId);
    return playImpl(guildId, track);
  },
  stopPlayback: (guildId: string) => {
    playing.delete(guildId);
  },
  setPlayerIdleHandler: () => undefined,
  setSessionDestroyedHandler: () => undefined,
  setSessionRemountedHandler: (
    handler: (guildId: string, resumeMs: number) => void | Promise<void>,
  ) => {
    remountHandler = handler;
  },
}));

function track(title: string, requestedBy = 'user'): QueuedTrack {
  return {
    title,
    url: `https://cdn.example.com/${title}.webm`,
    codec: 'opus',
    durationMs: 60_000,
    webpageUrl: `https://www.youtube.com/watch?v=${title}`,
    sourceKey: `https://www.youtube.com/watch?v=${title}`,
    streamFetchedAtMs: Date.now(),
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
    joined.clear();
    remountHandler = null;
    playImpl = async (guildId, t) => {
      playing.add(guildId);
      void t;
      return { mode: 'copy' };
    };
    resetEnvCache();
    resetQueueBridgeForTests();
    setFreshUrlResolverForTests(async (t) => t);
    initQueueBridge();
  });

  afterEach(() => {
    playing.clear();
    joined.clear();
    resetEnvCache();
    resetQueueBridgeForTests();
    vi.clearAllMocks();
    vi.useRealTimers();
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
    playing.delete('g1');
    await handlePlayerIdle('g1');
    expect(getQueueSnapshot('g1').current?.title).toBe('b');
    expect(getQueueSnapshot('g1').upcoming).toHaveLength(0);
  });

  it('restarts current on loop track', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    setLoopMode('g1', 'track');
    playing.delete('g1');
    await handlePlayerIdle('g1');
    expect(getQueueSnapshot('g1').current?.title).toBe('a');
  });

  it('rotates finished track to end on loop queue', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    setLoopMode('g1', 'queue');
    playing.delete('g1');
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
    expect(skipped.skipped?.title).toBe('a');
    expect(skipped.next?.title).toBe('b');
    const removed = await removeUpcoming('g1', 1);
    expect(removed.title).toBe('c');
    expect(await clearUpcoming('g1')).toBe(0);
    await stopQueue('g1');
    expect(getQueueSnapshot('g1').current).toBeNull();
  });

  it('rejects remove with invalid position', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    await expect(removeUpcoming('g1', 9)).rejects.toBeInstanceOf(UserFacingError);
  });

  it('remount handler restarts current track after playback dropped', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    expect(remountHandler).not.toBeNull();
    playing.delete('g1');
    onSessionDestroyed('g1', false);
    await remountHandler?.('g1', 4_000);
    expect(playing.has('g1')).toBe(true);
    expect(getQueueSnapshot('g1').current?.title).toBe('a');
    expect(getQueueSnapshot('g1').upcoming.map((t) => t.title)).toEqual(['b']);
  });

  it('button-style skip with panel upsert still advances', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    const result = await skipTrack('g1', { panel: 'upsert' });
    expect(result.skipped?.title).toBe('a');
    expect(result.next?.title).toBe('b');
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

  it('preserves queued tracks on CapacityError and retries after backoff', async () => {
    vi.useFakeTimers();
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    await enqueueTrack('g1', track('c'), env, logger, 100);

    playImpl = async () => {
      throw new CapacityError(
        'The host is at capacity (2 concurrent streams). Queued tracks will start when a slot frees.',
      );
    };

    playing.delete('g1');
    await handlePlayerIdle('g1');
    let snap = getQueueSnapshot('g1');
    expect(snap.current?.title).toBe('b');
    expect(snap.upcoming.map((t) => t.title)).toEqual(['c']);

    playImpl = async (guildId, t) => {
      playing.add(guildId);
      void t;
      return { mode: 'copy' };
    };

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => {
      expect(playing.has('g1')).toBe(true);
    });
    snap = getQueueSnapshot('g1');
    expect(snap.current?.title).toBe('b');
    expect(snap.upcoming.map((t) => t.title)).toEqual(['c']);
  });

  it('restartCurrentAt no-ops when expected track no longer current', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    await skipTrack('g1');
    expect(getQueueSnapshot('g1').current?.title).toBe('b');

    const result = await restartCurrentAt('g1', 5_000, {
      title: 'a',
      url: 'https://cdn.example.com/a.webm',
    });
    expect(result.applied).toBe(false);
    expect(getQueueSnapshot('g1').current?.title).toBe('b');
  });

  it('overlapping idle and skip does not drop or duplicate tracks', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    await enqueueTrack('g1', track('c'), env, logger, 100);

    playing.delete('g1');
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
    playing.delete('g1');
    await handlePlayerIdle('g1');
    const afterIdle = getQueueSnapshot('g1');
    expect(afterIdle.current?.title).toBe('a');
    expect(afterIdle.upcoming.map((t) => t.title)).toEqual(['b']);

    onSessionDestroyed('g1', true);
    expect(getQueueSnapshot('g1').current).toBeNull();
    expect(getQueueSnapshot('g1').upcoming).toHaveLength(0);
  });

  it('skip drops failed next tracks and continues when possible', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    await enqueueTrack('g1', track('c'), env, logger, 100);

    playImpl = async () => {
      throw new UserFacingError('Could not start audio stream — the URL may be invalid or unreachable.');
    };

    const result = await skipTrack('g1');
    expect(result.skipped?.title).toBe('a');
    expect(result.next).toBeNull();
    expect(result.upcomingCount).toBe(0);
    expect(getQueueSnapshot('g1').upcoming).toHaveLength(0);
  });

  it('idle advance skips unplayable next and starts the following track', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    await enqueueTrack('g1', track('c'), env, logger, 100);

    let attempts = 0;
    playImpl = async (guildId, t) => {
      attempts += 1;
      if (t.title === 'b') {
        throw new UserFacingError('Could not start audio stream — the URL may be invalid or unreachable.');
      }
      playing.add(guildId);
      return { mode: 'copy' };
    };

    playing.delete('g1');
    await handlePlayerIdle('g1');
    expect(getQueueSnapshot('g1').current?.title).toBe('c');
    expect(getQueueSnapshot('g1').upcoming).toHaveLength(0);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it('skip resumes stalled queue when current is null but upcoming remains', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    await enqueueTrack('g1', track('c'), env, logger, 100);
    await enqueueTrack('g1', track('d'), env, logger, 100);
    await enqueueTrack('g1', track('e'), env, logger, 100);
    await enqueueTrack('g1', track('f'), env, logger, 100);

    // Fail every start: skip-ahead budget 3 drops b,c,d then stops with e remaining after
    // attempting e with budget 0 — wait: after d (budget 1→0) next is e with budget 0.
    playImpl = async () => {
      throw new UserFacingError('Could not start audio stream — the URL may be invalid or unreachable.');
    };
    playing.delete('g1');
    await handlePlayerIdle('g1');
    expect(getQueueSnapshot('g1').current).toBeNull();
    // Attempted b,c,d,e (4 tries: initial + 3 skips); f left unattempted.
    expect(getQueueSnapshot('g1').upcoming.map((t) => t.title)).toEqual(['f']);

    playImpl = async (guildId, t) => {
      playing.add(guildId);
      void t;
      return { mode: 'copy' };
    };
    playing.add('g1');

    const result = await skipTrack('g1');
    expect(result.skipped).toBeNull();
    expect(result.next?.title).toBe('f');
    expect(getQueueSnapshot('g1').upcoming).toHaveLength(0);
  });

  it('concurrent first plays claim one starter and queue the other', async () => {
    const { env, logger } = deps();
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let startedCount = 0;
    playImpl = async (guildId, t) => {
      startedCount += 1;
      playing.add(guildId);
      void t;
      await gateA;
      return { mode: 'copy' };
    };

    const firstPromise = enqueueTrack('g1', track('a'), env, logger, 100);
    await vi.waitFor(() => {
      expect(getQueueSnapshot('g1').current?.title).toBe('a');
    });
    const secondPromise = enqueueTrack('g1', track('b'), env, logger, 100);
    releaseA();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.position).toBe(1);
    expect(startedCount).toBe(1);
    expect(getQueueSnapshot('g1').upcoming.map((t) => t.title)).toEqual(['b']);
  });

  it('previousTrack restores history and pushes current onto upcoming', async () => {
    const { env, logger } = deps();
    await enqueueTrack('g1', track('a'), env, logger, 100);
    await enqueueTrack('g1', track('b'), env, logger, 100);
    await skipTrack('g1');
    expect(getQueueSnapshot('g1').current?.title).toBe('b');
    expect(getQueueSnapshot('g1').historyLength).toBe(1);

    const prev = await previousTrack('g1');
    expect(prev.current.title).toBe('a');
    const snap = getQueueSnapshot('g1');
    expect(snap.current?.title).toBe('a');
    expect(snap.upcoming.map((t) => t.title)).toEqual(['b']);
    expect(snap.historyLength).toBe(0);

    await expect(previousTrack('g1')).rejects.toBeInstanceOf(UserFacingError);
  });
});
