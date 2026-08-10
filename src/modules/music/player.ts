/**
 * Per-guild music player: owns queue state + exclusive playback lane.
 *
 * Invariants:
 * - All mutations of current / FFmpeg start-stop go through the exclusive lane.
 * - Capacity errors wait/retry — never skip-ahead drop queued tracks.
 * - Stream URLs are refreshed at play time when a sourceKey is present.
 * - Session teardown (leave) destroys player state; remount suppresses one Idle.
 */
import type { Env } from '../../config/env.js';
import { CapacityError, UserFacingError } from '../../core/errors.js';
import {
  TRACK_CACHE_STREAM_TTL_MS,
  type TrackCacheRepository,
} from '../../db/repositories/track-cache.js';
import type { Logger } from '../../lib/logger.js';
import { Mutex } from '../../lib/mutex.js';
import {
  cancelIdleQueueAutoleave,
  clearAllAutoleave,
  isBotAloneInVoice,
  scheduleIdleQueueAutoleave,
} from './autoleave.js';
import { resolveWithYtDlp, type ResolvedTrack, type YtDlpSpawnFn } from './resolvers/ytdlp.js';
import {
  getSession,
  isPlaybackActive,
  playDirectUrl,
  setPlayerIdleHandler,
  setSessionDestroyedHandler,
  stopPlayback,
} from './session-manager.js';

export type LoopMode = 'off' | 'track' | 'queue';

const HISTORY_MAX = 20;
const LOOP_CYCLE: readonly LoopMode[] = ['off', 'track', 'queue'];
const SKIP_AHEAD_BUDGET = 3;
const CAPACITY_RETRY_MS = 3_000;
/** Refresh a bit before the cache TTL so playback rarely hits a dead CDN URL. */
const STREAM_FRESH_MARGIN_MS = Math.floor(TRACK_CACHE_STREAM_TTL_MS * 0.1);

export interface QueuedTrack extends ResolvedTrack {
  readonly requestedBy: string;
}

export interface QueueSnapshot {
  readonly current: QueuedTrack | null;
  readonly upcoming: readonly QueuedTrack[];
  readonly loop: LoopMode;
  readonly historyLength: number;
}

type PanelEvent = 'upsert' | 'clear' | 'forget';
type PanelNotify = (guildId: string, event: PanelEvent) => void;

export interface FreshResolveContext {
  readonly env: Env;
  readonly trackCache: TrackCacheRepository;
  readonly logger: Logger;
  readonly spawnFn?: YtDlpSpawnFn;
}

type FreshUrlResolver = (
  track: QueuedTrack,
  ctx: FreshResolveContext,
) => Promise<QueuedTrack>;

interface GuildPlayerState {
  current: QueuedTrack | null;
  upcoming: QueuedTrack[];
  history: QueuedTrack[];
  loop: LoopMode;
  /** Suppress the next Idle (intentional stop / remount). */
  ignoreNextIdle: boolean;
  readonly lane: Mutex;
  env: Env | null;
  logger: Logger | null;
  trackCache: TrackCacheRepository | null;
  capacityRetryTimer: ReturnType<typeof setTimeout> | null;
  destroyed: boolean;
}

const players = new Map<string, GuildPlayerState>();

let bridgeInstalled = false;
let panelNotify: PanelNotify = () => undefined;
let freshUrlResolver: FreshUrlResolver = defaultEnsureFreshStreamUrl;

/** Wire now-playing panel updates without importing the panel module (avoids cycles). */
export function setPanelNotifyHandler(handler: PanelNotify): void {
  panelNotify = handler;
}

/** Override stream freshness (tests). */
export function setFreshUrlResolverForTests(resolver: FreshUrlResolver | null): void {
  freshUrlResolver = resolver ?? defaultEnsureFreshStreamUrl;
}

function notifyPanel(guildId: string, event: PanelEvent): void {
  try {
    panelNotify(guildId, event);
  } catch {
    // panel failures must not break playback
  }
}

function pushHistory(state: GuildPlayerState, track: QueuedTrack): void {
  state.history.push(track);
  while (state.history.length > HISTORY_MAX) {
    state.history.shift();
  }
}

function syncIdleAutoleave(guildId: string, state: GuildPlayerState): void {
  if (state.current === null && state.upcoming.length === 0) {
    const env = state.env;
    if (env && isBotAloneInVoice(guildId)) {
      scheduleIdleQueueAutoleave(guildId, env.MUSIC_IDLE_TIMEOUT_MS);
    } else {
      cancelIdleQueueAutoleave(guildId);
    }
    return;
  }
  cancelIdleQueueAutoleave(guildId);
}

function cancelCapacityRetry(state: GuildPlayerState): void {
  if (state.capacityRetryTimer !== null) {
    clearTimeout(state.capacityRetryTimer);
    state.capacityRetryTimer = null;
  }
}

function scheduleCapacityRetry(guildId: string, state: GuildPlayerState): void {
  cancelCapacityRetry(state);
  const timer = setTimeout(() => {
    state.capacityRetryTimer = null;
    if (state.destroyed) {
      return;
    }
    void runInLane(guildId, async () => {
      await processQueueUnlocked(guildId, state, SKIP_AHEAD_BUDGET);
    }).catch((error: unknown) => {
      state.logger?.warn({ err: error, guildId }, 'capacity retry failed');
    });
  }, CAPACITY_RETRY_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  state.capacityRetryTimer = timer;
  state.logger?.info({ guildId }, 'waiting for stream capacity slot');
}

function getOrCreate(guildId: string): GuildPlayerState {
  const existing = players.get(guildId);
  if (existing && !existing.destroyed) {
    return existing;
  }
  const created: GuildPlayerState = {
    current: null,
    upcoming: [],
    history: [],
    loop: 'off',
    ignoreNextIdle: false,
    lane: new Mutex(),
    env: null,
    logger: null,
    trackCache: null,
    capacityRetryTimer: null,
    destroyed: false,
  };
  players.set(guildId, created);
  return created;
}

function runInLane<T>(guildId: string, fn: () => Promise<T>): Promise<T> {
  const state = getOrCreate(guildId);
  return state.lane.runExclusive(fn);
}

/**
 * Re-resolve stream URL when stale. Direct URLs (no sourceKey) pass through.
 */
export async function defaultEnsureFreshStreamUrl(
  track: QueuedTrack,
  ctx: FreshResolveContext,
): Promise<QueuedTrack> {
  if (track.sourceKey === null) {
    return track;
  }

  const nowMs = Date.now();
  if (
    track.streamFetchedAtMs !== null &&
    nowMs - track.streamFetchedAtMs < TRACK_CACHE_STREAM_TTL_MS - STREAM_FRESH_MARGIN_MS
  ) {
    return track;
  }

  const cached = ctx.trackCache.getFresh(track.sourceKey, nowMs);
  if (cached !== null) {
    return {
      ...track,
      url: cached.streamUrl,
      codec: cached.codec,
      durationMs: cached.durationMs ?? track.durationMs,
      webpageUrl: cached.webpageUrl || track.webpageUrl,
      sourceKey: track.sourceKey,
      streamFetchedAtMs: cached.streamFetchedAt.getTime(),
    };
  }

  const resolved = await resolveWithYtDlp(track.sourceKey, ctx.env, {
    trackCache: ctx.trackCache,
    logger: ctx.logger,
    spawnFn: ctx.spawnFn,
  });

  return {
    ...track,
    url: resolved.url,
    codec: resolved.codec,
    title: resolved.title || track.title,
    durationMs: resolved.durationMs ?? track.durationMs,
    webpageUrl: resolved.webpageUrl || track.webpageUrl,
    sourceKey: resolved.sourceKey ?? track.sourceKey,
    streamFetchedAtMs: resolved.streamFetchedAtMs ?? Date.now(),
  };
}

async function startCurrentUnlocked(
  guildId: string,
  state: GuildPlayerState,
  track: QueuedTrack,
  seekMs = 0,
): Promise<{ mode: 'copy' | 'transcode' }> {
  const env = state.env;
  const logger = state.logger;
  if (env === null || logger === null) {
    throw new UserFacingError('Nothing is playing.');
  }

  state.current = track;
  cancelIdleQueueAutoleave(guildId);
  cancelCapacityRetry(state);

  let playable = track;
  if (state.trackCache !== null) {
    playable = await freshUrlResolver(track, {
      env,
      trackCache: state.trackCache,
      logger,
    });
    if (state.current === track) {
      state.current = playable;
    }
  }

  try {
    const result = await playDirectUrl(guildId, playable, env, logger, {
      seekMs,
      durationMs: playable.durationMs,
    });
    notifyPanel(guildId, 'upsert');
    return result;
  } catch (error) {
    if (error instanceof CapacityError) {
      // Keep as current; retry when a slot frees.
      state.current = playable;
      scheduleCapacityRetry(guildId, state);
      notifyPanel(guildId, 'upsert');
      throw error;
    }
    if (state.current === playable || state.current === track) {
      state.current = null;
    }
    syncIdleAutoleave(guildId, state);
    if (state.current === null && state.upcoming.length === 0) {
      notifyPanel(guildId, 'clear');
    }
    throw error;
  }
}

/**
 * Advance / start next from upcoming. Capacity waits; other failures skip-ahead.
 */
async function processQueueUnlocked(
  guildId: string,
  state: GuildPlayerState,
  skipAheadBudget: number,
): Promise<void> {
  if (state.destroyed) {
    return;
  }

// Already streaming — nothing to do (Idle clears this before advance).
  if (isPlaybackActive(guildId)) {
    return;
  }

  const env = state.env;
  const logger = state.logger;
  if (env === null || logger === null) {
    state.current = null;
    syncIdleAutoleave(guildId, state);
    notifyPanel(guildId, 'clear');
    return;
  }

  // Retry current that is waiting on capacity.
  if (state.current !== null && !isPlaybackActive(guildId)) {
    try {
      await startCurrentUnlocked(guildId, state, state.current);
      return;
    } catch (error) {
      if (error instanceof CapacityError) {
        return;
      }
      logger.warn(
        { err: error, guildId, title: state.current.title },
        'failed to start waiting track',
      );
      state.current = null;
      // fall through to upcoming
    }
  }

  const next = state.upcoming.shift();
  if (!next) {
    state.current = null;
    syncIdleAutoleave(guildId, state);
    notifyPanel(guildId, 'clear');
    return;
  }

  try {
    await startCurrentUnlocked(guildId, state, next);
  } catch (error) {
    if (error instanceof CapacityError) {
      // startCurrentUnlocked already kept current + scheduled retry
      return;
    }
    logger.warn({ err: error, guildId, title: next.title }, 'failed to start next queued track');
    if (skipAheadBudget > 0 && state.upcoming.length > 0) {
      await processQueueUnlocked(guildId, state, skipAheadBudget - 1);
      return;
    }
    state.current = null;
    syncIdleAutoleave(guildId, state);
    if (state.upcoming.length > 0) {
      return;
    }
    notifyPanel(guildId, 'clear');
  }
}

/** Wire session Idle/destroy into the player (call once from music module init). */
export function initQueueBridge(): void {
  if (bridgeInstalled) {
    return;
  }
  bridgeInstalled = true;
  setPlayerIdleHandler((guildId) => {
    void handlePlayerIdle(guildId);
  });
  setSessionDestroyedHandler((guildId, clearQueue) => {
    onSessionDestroyed(guildId, clearQueue);
  });
}

/**
 * Voice session teardown hook.
 * - clearQueue true (leave / disconnect): drop guild player state.
 * - clearQueue false (channel move remount): keep queue but suppress the Idle
 *   that player.stop() emits so we do not advance/clear mid-move.
 */
export function onSessionDestroyed(guildId: string, clearQueue = true): void {
  clearAllAutoleave(guildId);
  const state = players.get(guildId);
  if (!state) {
    if (clearQueue) {
      notifyPanel(guildId, 'forget');
    }
    return;
  }

  if (clearQueue) {
    cancelCapacityRetry(state);
    state.destroyed = true;
    players.delete(guildId);
    notifyPanel(guildId, 'forget');
    return;
  }

  state.ignoreNextIdle = true;
}

/** Test helper */
export function resetQueueBridgeForTests(): void {
  for (const state of players.values()) {
    cancelCapacityRetry(state);
  }
  bridgeInstalled = false;
  players.clear();
  panelNotify = () => undefined;
  freshUrlResolver = defaultEnsureFreshStreamUrl;
}

export function getQueueSnapshot(guildId: string): QueueSnapshot {
  const state = players.get(guildId);
  if (!state || state.destroyed) {
    return { current: null, upcoming: [], loop: 'off', historyLength: 0 };
  }
  return {
    current: state.current,
    upcoming: [...state.upcoming],
    loop: state.loop,
    historyLength: state.history.length,
  };
}

export function setLoopMode(guildId: string, loop: LoopMode): LoopMode {
  const state = getOrCreate(guildId);
  state.loop = loop;
  notifyPanel(guildId, state.current !== null ? 'upsert' : 'clear');
  return state.loop;
}

/** Cycle loop mode off → track → queue → off. */
export function cycleLoopMode(guildId: string): LoopMode {
  const state = getOrCreate(guildId);
  const index = LOOP_CYCLE.indexOf(state.loop);
  const next = LOOP_CYCLE[(index + 1) % LOOP_CYCLE.length] ?? 'off';
  state.loop = next;
  notifyPanel(guildId, state.current !== null ? 'upsert' : 'clear');
  return state.loop;
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
  trackCache: TrackCacheRepository | null = null,
): Promise<{
  started: boolean;
  mode?: 'copy' | 'transcode';
  position: number;
  waitingForCapacity?: boolean;
}> {
  return runInLane(guildId, async () => {
    const state = getOrCreate(guildId);
    state.env = env;
    state.logger = logger;
    if (trackCache !== null) {
      state.trackCache = trackCache;
    }

    const playing = isPlaybackActive(guildId) || state.current !== null;
    if (!playing) {
      // Claim current synchronously before any await so concurrent /play enqueues serialize.
      state.current = track;
      try {
        const { mode } = await startCurrentUnlocked(guildId, state, track);
        return { started: true, mode, position: 0 };
      } catch (error) {
        if (error instanceof CapacityError) {
          return { started: false, position: 0, waitingForCapacity: true };
        }
        if (state.current === track) {
          state.current = null;
        }
        // Failed first start — drain siblings already queued by concurrent enqueues.
        await processQueueUnlocked(guildId, state, SKIP_AHEAD_BUDGET);
        if (state.current !== null && isPlaybackActive(guildId)) {
          return { started: true, position: 0 };
        }
        syncIdleAutoleave(guildId, state);
        throw error;
      }
    }

    if (state.upcoming.length >= maxQueueSize) {
      throw new UserFacingError(
        `The queue is full (max ${maxQueueSize} tracks). Remove something with \`/remove\` or \`/clear\`.`,
      );
    }

    state.upcoming.push(track);
    cancelIdleQueueAutoleave(guildId);
    notifyPanel(guildId, 'upsert');
    return { started: false, position: state.upcoming.length };
  });
}

/**
 * Called when the audio player becomes Idle (track finished or failed).
 */
export async function handlePlayerIdle(guildId: string): Promise<void> {
  await runInLane(guildId, async () => {
    const state = players.get(guildId);
    if (!state || state.destroyed) {
      return;
    }

    if (state.ignoreNextIdle) {
      state.ignoreNextIdle = false;
      return;
    }

    if (!getSession(guildId)) {
      return;
    }

    if (state.loop === 'track' && state.current !== null) {
      try {
        await startCurrentUnlocked(guildId, state, state.current);
        return;
      } catch (error) {
        if (error instanceof CapacityError) {
          return;
        }
        state.logger?.warn({ err: error, guildId }, 'loop track restart failed');
      }
    }

    if (state.current !== null) {
      pushHistory(state, state.current);
    }

    if (state.loop === 'queue' && state.current !== null) {
      state.upcoming.push(state.current);
    }

    state.current = null;
    await processQueueUnlocked(guildId, state, SKIP_AHEAD_BUDGET);
  });
}

export async function skipTrack(
  guildId: string,
): Promise<{ skipped: QueuedTrack | null; next: QueuedTrack | null; upcomingCount: number }> {
  return runInLane(guildId, async () => {
    const state = getOrCreate(guildId);
    if (state.current === null && state.upcoming.length === 0) {
      throw new UserFacingError('Nothing is playing.');
    }

    const skipped = state.current;
    if (skipped !== null) {
      pushHistory(state, skipped);
    }

    state.current = null;
    state.ignoreNextIdle = true;
    cancelCapacityRetry(state);
    stopPlayback(guildId);
    await processQueueUnlocked(guildId, state, SKIP_AHEAD_BUDGET);
    return {
      skipped,
      next: state.current,
      upcomingCount: state.upcoming.length,
    };
  });
}

/**
 * Replay the previous track from history; current is pushed back onto upcoming.
 */
export async function previousTrack(
  guildId: string,
): Promise<{ current: QueuedTrack; upcomingCount: number }> {
  return runInLane(guildId, async () => {
    const state = getOrCreate(guildId);
    if (state.env === null || state.logger === null) {
      throw new UserFacingError('Nothing is playing.');
    }

    const prev = state.history.pop();
    if (!prev) {
      throw new UserFacingError('No previous track.');
    }

    if (state.current !== null) {
      state.upcoming.unshift(state.current);
    }

    state.ignoreNextIdle = true;
    cancelCapacityRetry(state);
    stopPlayback(guildId);
    await startCurrentUnlocked(guildId, state, prev);
    return {
      current: prev,
      upcomingCount: state.upcoming.length,
    };
  });
}

export async function stopQueue(guildId: string): Promise<void> {
  await runInLane(guildId, async () => {
    const state = getOrCreate(guildId);
    state.ignoreNextIdle = true;
    cancelCapacityRetry(state);
    state.current = null;
    state.upcoming = [];
    state.history = [];
    stopPlayback(guildId);
    syncIdleAutoleave(guildId, state);
    notifyPanel(guildId, 'clear');
  });
}

export function clearUpcoming(guildId: string): number {
  const state = getOrCreate(guildId);
  const removed = state.upcoming.length;
  state.upcoming = [];
  if (state.current !== null) {
    notifyPanel(guildId, 'upsert');
  }
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
  if (state.current !== null) {
    notifyPanel(guildId, 'upsert');
  }
  return removed;
}

/**
 * Restart the current track at an offset (volume / seek).
 * Identity-guarded: if skip/idle already advanced past `expected`, no-ops.
 */
export async function restartCurrentAt(
  guildId: string,
  seekMs: number,
  expected: { readonly title: string; readonly url: string } | null = null,
): Promise<{ mode: 'copy' | 'transcode'; applied: boolean }> {
  return runInLane(guildId, async () => {
    const state = getOrCreate(guildId);
    const track = state.current;
    if (track === null || state.env === null || state.logger === null) {
      throw new UserFacingError('Nothing is playing.');
    }

    if (expected !== null && (track.title !== expected.title || track.url !== expected.url)) {
      // Skip/idle won the race — do not clobber the new current track.
      return { mode: 'copy', applied: false };
    }

    const { mode } = await startCurrentUnlocked(guildId, state, track, Math.max(0, seekMs));
    return { mode, applied: true };
  });
}

/** Drop all guild players (process shutdown). */
export function destroyAllPlayers(): void {
  for (const [guildId, state] of players) {
    cancelCapacityRetry(state);
    state.destroyed = true;
    players.delete(guildId);
  }
}
