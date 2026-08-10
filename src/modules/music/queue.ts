import type { Env } from '../../config/env.js';
import { UserFacingError } from '../../core/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { ResolvedTrack } from './resolvers/ytdlp.js';
import {
  getSession,
  isPlaybackActive,
  playDirectUrl,
  setPlayerIdleHandler,
  setSessionDestroyedHandler,
  stopPlayback,
} from './session-manager.js';

export type LoopMode = 'off' | 'track' | 'queue';

export interface QueuedTrack extends ResolvedTrack {
  readonly requestedBy: string;
}

export interface QueueSnapshot {
  readonly current: QueuedTrack | null;
  readonly upcoming: readonly QueuedTrack[];
  readonly loop: LoopMode;
}

interface GuildMusicQueue {
  current: QueuedTrack | null;
  upcoming: QueuedTrack[];
  loop: LoopMode;
  suppressIdle: boolean;
  advanceChain: Promise<void>;
  env: Env | null;
  logger: Logger | null;
}

const queues = new Map<string, GuildMusicQueue>();

let bridgeInstalled = false;

/** Wire session Idle/destroy into the queue (call once from music module init). */
export function initQueueBridge(): void {
  if (bridgeInstalled) {
    return;
  }
  bridgeInstalled = true;
  setPlayerIdleHandler((guildId) => handlePlayerIdle(guildId));
  setSessionDestroyedHandler((guildId, clearQueue) => {
    onSessionDestroyed(guildId, clearQueue);
  });
}

/**
 * Voice session teardown hook.
 * - clearQueue true (leave / disconnect): drop guild queue state.
 * - clearQueue false (channel move remount): keep queue but suppress the Idle
 *   that player.stop() emits so we do not advance/clear mid-move.
 */
export function onSessionDestroyed(guildId: string, clearQueue = true): void {
  if (clearQueue) {
    queues.delete(guildId);
    return;
  }
  const state = queues.get(guildId);
  if (state) {
    state.suppressIdle = true;
  }
}

/** Test helper */
export function resetQueueBridgeForTests(): void {
  bridgeInstalled = false;
  queues.clear();
}

function getOrCreate(guildId: string): GuildMusicQueue {
  const existing = queues.get(guildId);
  if (existing) {
    return existing;
  }
  const created: GuildMusicQueue = {
    current: null,
    upcoming: [],
    loop: 'off',
    suppressIdle: false,
    advanceChain: Promise.resolve(),
    env: null,
    logger: null,
  };
  queues.set(guildId, created);
  return created;
}

/** Serialize idle / skip / stop advances so upcoming is never double-shifted. */
function runExclusiveAdvance<T>(guildId: string, fn: () => Promise<T>): Promise<T> {
  const state = getOrCreate(guildId);
  const run = state.advanceChain.then(fn, fn);
  state.advanceChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function clearGuildQueue(guildId: string): void {
  queues.delete(guildId);
}

export function getQueueSnapshot(guildId: string): QueueSnapshot {
  const state = queues.get(guildId);
  if (!state) {
    return { current: null, upcoming: [], loop: 'off' };
  }
  return {
    current: state.current,
    upcoming: [...state.upcoming],
    loop: state.loop,
  };
}

export function setLoopMode(guildId: string, loop: LoopMode): LoopMode {
  const state = getOrCreate(guildId);
  state.loop = loop;
  return state.loop;
}

async function startCurrent(
  guildId: string,
  track: QueuedTrack,
  env: Env,
  logger: Logger,
): Promise<{ mode: 'copy' | 'transcode' }> {
  const state = getOrCreate(guildId);
  state.env = env;
  state.logger = logger;
  state.current = track;
  try {
    return await playDirectUrl(guildId, track, env, logger);
  } catch (error) {
    if (state.current === track) {
      state.current = null;
    }
    throw error;
  }
}

/**
 * Enqueue a resolved track. Starts playback immediately if nothing is playing.
 * Returns whether playback started now, and 1-based queue position when queued.
 */
export async function enqueueTrack(
  guildId: string,
  track: QueuedTrack,
  env: Env,
  logger: Logger,
  maxQueueSize: number,
): Promise<{ started: boolean; mode?: 'copy' | 'transcode'; position: number }> {
  const state = getOrCreate(guildId);
  state.env = env;
  state.logger = logger;

  // Claim current synchronously (before any await) so concurrent /play enqueues.
  const playing = isPlaybackActive(guildId) || state.current !== null;
  if (!playing) {
    try {
      const { mode } = await startCurrent(guildId, track, env, logger);
      return { started: true, mode, position: 0 };
    } catch (error) {
      if (state.current === track) {
        state.current = null;
      }
      throw error;
    }
  }

  if (state.upcoming.length >= maxQueueSize) {
    throw new UserFacingError(
      `The queue is full (max ${maxQueueSize} tracks). Remove something with \`/remove\` or \`/clear\`.`,
    );
  }

  state.upcoming.push(track);
  return { started: false, position: state.upcoming.length };
}

async function playNextFromQueue(
  guildId: string,
  state: GuildMusicQueue,
  skipAheadBudget = 1,
): Promise<void> {
  const env = state.env;
  const logger = state.logger;
  if (env === null || logger === null) {
    state.current = null;
    return;
  }

  const next = state.upcoming.shift();
  if (!next) {
    state.current = null;
    return;
  }

  try {
    await startCurrent(guildId, next, env, logger);
  } catch (error) {
    logger.warn({ err: error, guildId, title: next.title }, 'failed to start next queued track');
    if (error instanceof UserFacingError) {
      state.upcoming.unshift(next);
      state.current = null;
      return;
    }
    // Unexpected failure: try one following track, then give up.
    if (skipAheadBudget > 0 && state.upcoming.length > 0) {
      await playNextFromQueue(guildId, state, skipAheadBudget - 1);
      return;
    }
    state.current = null;
  }
}

/**
 * Called when the audio player becomes Idle (track finished or failed).
 */
export async function handlePlayerIdle(guildId: string): Promise<void> {
  await runExclusiveAdvance(guildId, async () => {
    const state = queues.get(guildId);
    if (!state) {
      return;
    }

    if (state.suppressIdle) {
      state.suppressIdle = false;
      return;
    }

    if (!getSession(guildId)) {
      return;
    }

    if (state.loop === 'track' && state.current !== null) {
      const env = state.env;
      const logger = state.logger;
      if (env && logger) {
        try {
          await startCurrent(guildId, state.current, env, logger);
          return;
        } catch (error) {
          logger.warn({ err: error, guildId }, 'loop track restart failed');
        }
      }
    }

    if (state.loop === 'queue' && state.current !== null) {
      state.upcoming.push(state.current);
    }

    await playNextFromQueue(guildId, state);
  });
}

export async function skipTrack(
  guildId: string,
): Promise<{ skipped: QueuedTrack; next: QueuedTrack | null; upcomingCount: number }> {
  return runExclusiveAdvance(guildId, async () => {
    const state = getOrCreate(guildId);
    if (state.current === null && state.upcoming.length === 0) {
      throw new UserFacingError('Nothing is playing.');
    }

    const skipped = state.current;
    if (skipped === null) {
      throw new UserFacingError('Nothing is playing.');
    }

    state.suppressIdle = true;
    stopPlayback(guildId);
    await playNextFromQueue(guildId, state);
    return {
      skipped,
      next: state.current,
      upcomingCount: state.upcoming.length,
    };
  });
}

export async function stopQueue(guildId: string): Promise<void> {
  await runExclusiveAdvance(guildId, async () => {
    const state = getOrCreate(guildId);
    state.suppressIdle = true;
    state.current = null;
    state.upcoming = [];
    stopPlayback(guildId);
  });
}

export function clearUpcoming(guildId: string): number {
  const state = getOrCreate(guildId);
  const removed = state.upcoming.length;
  state.upcoming = [];
  return removed;
}

/** Remove 1-based upcoming index. */
export function removeUpcoming(guildId: string, position: number): QueuedTrack {
  const state = getOrCreate(guildId);
  if (!Number.isInteger(position) || position < 1 || position > state.upcoming.length) {
    throw new UserFacingError(
      `Invalid position. Use a number from 1 to ${Math.max(state.upcoming.length, 0)}.`,
    );
  }
  const [removed] = state.upcoming.splice(position - 1, 1);
  if (!removed) {
    throw new UserFacingError('Could not remove that track.');
  }
  return removed;
}
