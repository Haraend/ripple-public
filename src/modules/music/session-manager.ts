/**
 * Guild music voice session manager.
 *
 * Invariants (per guildId):
 * - At most one GuildSession / voice connection.
 * - sessionToken is stable for the listening session; rotates only on full teardown (leave/autoleave/hard disconnect).
 * - Same-channel ensureVoice / joinChannel is a no-op (never leave/rejoin).
 */
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
  type VoiceConnection,
} from '@discordjs/voice';
import type { GuildMember, VoiceBasedChannel } from 'discord.js';
import type { Env } from '../../config/env.js';
import { CapacityError, UserFacingError } from '../../core/errors.js';
import type { Logger } from '../../lib/logger.js';
import { Mutex } from '../../lib/mutex.js';
import { buildFfmpegArgs, type TrackLike } from './stream.js';
import { assertSafeMediaUrl } from './url-safety.js';

export interface PlayDirectOptions {
  readonly seekMs?: number;
  readonly durationMs?: number | null;
}

interface GuildSession {
  readonly guildId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  ffmpeg: ChildProcess | null;
  volume: number;
  current: TrackLike | null;
  channelId: string;
  /** Opaque token embedded in now-playing button customIds. */
  sessionToken: string;
  /** Base offset passed to FFmpeg `-ss` for this spawn. */
  seekOffsetMs: number;
  /** Wall clock when the current FFmpeg resource started playing. */
  startedAtMs: number | null;
  /** When non-null, playback is paused at this wall time. */
  pausedAtMs: number | null;
  accumulatedPauseMs: number;
  durationMs: number | null;
  /** Skip one Idle callback (mid-track restart for volume/seek). */
  ignoreNextIdle: boolean;
}

function newSessionToken(): string {
  return randomBytes(8).toString('hex');
}

type GuildIdHandler = (guildId: string) => void | Promise<void>;
type SessionDestroyedHandler = (
  guildId: string,
  clearQueue: boolean,
) => void | Promise<void>;
type SessionRemountedHandler = (
  guildId: string,
  resumeMs: number,
) => void | Promise<void>;

let playerIdleHandler: GuildIdHandler | null = null;
let sessionDestroyedHandler: SessionDestroyedHandler | null = null;
let sessionRemountedHandler: SessionRemountedHandler | null = null;

/** Avoid circular imports: queue registers Idle / destroy hooks at module init. */
export function setPlayerIdleHandler(handler: GuildIdHandler): void {
  playerIdleHandler = handler;
}

export function setSessionDestroyedHandler(handler: SessionDestroyedHandler): void {
  sessionDestroyedHandler = handler;
}

/** Fired after a full remount kept the queue — restart current track at resumeMs. */
export function setSessionRemountedHandler(handler: SessionRemountedHandler): void {
  sessionRemountedHandler = handler;
}

/** @internal */
export async function fireSessionRemountedForTests(
  guildId: string,
  resumeMs: number,
): Promise<void> {
  await sessionRemountedHandler?.(guildId, resumeMs);
}

const sessions = new Map<string, GuildSession>();
const trackedChildren = new Set<ChildProcess>();
const playMutex = new Mutex();
/** Serialize join/remount per guild so concurrent /play cannot double joinVoiceChannel. */
const joinMutexes = new Map<string, Mutex>();
/** In-flight joinVoiceChannel → Ready (sessions empty until Ready). */
const joiningByGuild = new Map<string, VoiceConnection>();

function getJoinMutex(guildId: string): Mutex {
  const existing = joinMutexes.get(guildId);
  if (existing) {
    return existing;
  }
  const created = new Mutex();
  joinMutexes.set(guildId, created);
  return created;
}

/** @internal Test helper — run under the same per-guild join lock as ensureVoice/join. */
export function withGuildJoinLock<T>(guildId: string, fn: () => Promise<T> | T): Promise<T> {
  return getJoinMutex(guildId).runExclusive(fn);
}

/** @internal Test helper — whether a Disconnected callback may tear this guild down. */
export function mayTeardownAfterDisconnect(
  guildId: string,
  connection: VoiceConnection,
): boolean {
  const session = sessions.get(guildId);
  if (session) {
    return session.connection === connection;
  }
  // Join in flight: never destroy the guild's live socket from a stale Disconnected.
  if (joiningByGuild.has(guildId)) {
    return false;
  }
  return true;
}

function killChild(child: ChildProcess | null): void {
  if (!child || child.killed) {
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }
  trackedChildren.delete(child);
}

export function killAllFfmpegChildren(): void {
  for (const child of trackedChildren) {
    killChild(child);
  }
}

/**
 * Kill FFmpeg children that are tracked but not owned by any live session,
 * and drop already-exited handles from the tracked set.
 */
export function reapOrphanFfmpegChildren(): { killed: number; pruned: number } {
  const live = new Set<ChildProcess>();
  for (const session of sessions.values()) {
    if (session.ffmpeg !== null) {
      live.add(session.ffmpeg);
    }
  }

  let killed = 0;
  let pruned = 0;
  for (const child of Array.from(trackedChildren)) {
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (exited) {
      trackedChildren.delete(child);
      pruned += 1;
      continue;
    }
    if (!live.has(child)) {
      killChild(child);
      killed += 1;
    }
  }
  return { killed, pruned };
}

/** @internal Test helper — register a fake child without spawning FFmpeg. */
export function trackFfmpegChildForTests(child: ChildProcess): void {
  trackedChildren.add(child);
}

/** @internal Test helper */
export function clearTrackedFfmpegChildrenForTests(): void {
  trackedChildren.clear();
}

export function getActiveStreamCount(): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.player.state.status !== AudioPlayerStatus.Idle || session.ffmpeg) {
      count += 1;
    }
  }
  return count;
}

function isSessionBusy(session: GuildSession): boolean {
  return session.ffmpeg !== null || session.player.state.status !== AudioPlayerStatus.Idle;
}

export function isPlaybackActive(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) {
    return false;
  }
  return isSessionBusy(session);
}

function resetPosition(session: GuildSession): void {
  session.seekOffsetMs = 0;
  session.startedAtMs = null;
  session.pausedAtMs = null;
  session.accumulatedPauseMs = 0;
  session.durationMs = null;
}

/** Estimate current playback position in ms (includes seek offset, excludes pause time). */
export function getPlaybackPositionMs(guildId: string, nowMs: number = Date.now()): number {
  const session = sessions.get(guildId);
  if (!session || session.startedAtMs === null) {
    return session?.seekOffsetMs ?? 0;
  }
  const endMs = session.pausedAtMs ?? nowMs;
  const elapsed = Math.max(0, endMs - session.startedAtMs - session.accumulatedPauseMs);
  const position = session.seekOffsetMs + elapsed;
  if (session.durationMs !== null && session.durationMs > 0) {
    return Math.min(position, session.durationMs);
  }
  return position;
}

export function isPaused(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) {
    return false;
  }
  return session.player.state.status === AudioPlayerStatus.Paused;
}

export function pausePlayback(guildId: string): void {
  const session = sessions.get(guildId);
  if (!session || !session.current) {
    throw new UserFacingError('Nothing is playing.');
  }
  if (session.player.state.status === AudioPlayerStatus.Paused) {
    throw new UserFacingError('Playback is already paused.');
  }
  if (session.player.state.status !== AudioPlayerStatus.Playing) {
    throw new UserFacingError('Nothing is playing.');
  }
  session.player.pause(true);
  session.pausedAtMs = Date.now();
}

export function resumePlayback(guildId: string): void {
  const session = sessions.get(guildId);
  if (!session || !session.current) {
    throw new UserFacingError('Nothing is playing.');
  }
  if (session.player.state.status !== AudioPlayerStatus.Paused) {
    throw new UserFacingError('Playback is not paused.');
  }
  if (session.pausedAtMs !== null) {
    session.accumulatedPauseMs += Date.now() - session.pausedAtMs;
    session.pausedAtMs = null;
  }
  session.player.unpause();
}

/** Stop current FFmpeg/player without destroying the voice connection. */
export function stopPlayback(guildId: string): void {
  const session = sessions.get(guildId);
  if (!session) {
    return;
  }
  session.ignoreNextIdle = true;
  killChild(session.ffmpeg);
  session.ffmpeg = null;
  session.current = null;
  resetPosition(session);
  session.player.stop(true);
}

function channelHasOtherHumans(channel: VoiceBasedChannel, botUserId: string): boolean {
  return channel.members.some((member) => !member.user.bot && member.id !== botUserId);
}

/**
 * Join / stay / move / refuse based on whether the bot is already serving someone else.
 *
 * Invariants:
 * - Same VC → never leave/rejoin.
 * - sessionToken stays stable across remounts; rotates only on full teardown.
 * - Concurrent callers are serialized per guild (join mutex).
 */
export async function ensureVoiceForMember(
  member: GuildMember,
  logger: Logger,
): Promise<GuildSession> {
  const userChannel = member.voice.channel;
  if (!userChannel) {
    throw new UserFacingError('Join a voice channel first.');
  }

  const guildId = member.guild.id;

  // Always enter the join lock — no unlocked fast-path (session may be mid-teardown).
  return getJoinMutex(guildId).runExclusive(async () => {
    const existing = sessions.get(guildId);
    const live = getVoiceConnection(guildId);
    if (
      existing &&
      existing.channelId === userChannel.id &&
      live !== undefined &&
      live === existing.connection
    ) {
      return existing;
    }

    if (!existing) {
      return joinChannelUnlocked(userChannel, logger);
    }

    const botChannel = member.guild.channels.cache.get(existing.channelId);
    const botVoice =
      botChannel && botChannel.isVoiceBased() ? botChannel : undefined;

    const busy = isSessionBusy(existing);
    const othersPresent = botVoice
      ? channelHasOtherHumans(botVoice, member.client.user.id)
      : false;

    if (busy || othersPresent) {
      const name = botVoice?.name ?? 'another channel';
      throw new UserFacingError(
        `I'm already in use in **${name}**. Join that channel, or wait until it's free.`,
      );
    }

    return joinChannelUnlocked(userChannel, logger);
  });
}

/**
 * True when this guild has a live session in a voice channel (for /play after resolve).
 */
export function assertVoiceReady(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) {
    return false;
  }
  const conn = getVoiceConnection(guildId);
  return conn !== undefined && session.channelId.length > 0;
}

/**
 * Join a voice channel, or no-op if already connected there.
 * Remounts preserve sessionToken + volume. Token rotates only via full destroySession.
 */
export async function joinChannel(
  channel: VoiceBasedChannel,
  logger: Logger,
): Promise<GuildSession> {
  return getJoinMutex(channel.guild.id).runExclusive(() =>
    joinChannelUnlocked(channel, logger),
  );
}

/**
 * Join implementation. Caller must hold the guild join mutex (or be the sole caller).
 */
async function joinChannelUnlocked(
  channel: VoiceBasedChannel,
  logger: Logger,
): Promise<GuildSession> {
  const guildId = channel.guild.id;
  const existing = sessions.get(guildId);

  // Same channel — never leave/rejoin.
  if (existing && existing.channelId === channel.id) {
    return existing;
  }

  // Live voice connection already on this channel (session lost or racing) — do not
  // call joinVoiceChannel again (that destroys the socket mid IP discovery).
  const live = getVoiceConnection(guildId);
  if (live && live.joinConfig.channelId === channel.id) {
    if (existing) {
      existing.channelId = channel.id;
      existing.connection = live;
      return existing;
    }
    // Orphan connection for the target channel: attach a fresh session to it.
    const session = createGuildSession({
      guildId,
      channelId: channel.id,
      connection: live,
      sessionToken: newSessionToken(),
      volume: 100,
      logger,
    });
    sessions.set(guildId, session);
    logger.info({ guildId, channelId: channel.id }, 'rebound orphan voice connection');
    return session;
  }

  // Prefer in-place rejoin when moving channels (keeps token/volume/player wiring).
  if (existing && existing.channelId !== channel.id) {
    const moved = await tryRejoinChannel(existing, channel, logger);
    if (moved) {
      return moved;
    }
  }

  // Orphan voice connection on a different channel — drop before a clean join,
  // but never if we already marked a join in flight for this guild.
  if (!existing && live && !joiningByGuild.has(guildId)) {
    try {
      live.destroy();
    } catch {
      // ignore
    }
  }

  const previousToken = existing?.sessionToken;
  const previousVolume = existing?.volume ?? 100;
  const remountResumeMs = existing ? getPlaybackPositionMs(guildId) : 0;
  const didRemount = Boolean(existing);

  if (existing) {
    // Full remount fallback — keep queue; preserve token below.
    destroySessionUnlocked(guildId, { clearQueue: false });
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  joiningByGuild.set(guildId, connection);

  connection.on('error', (error) => {
    logger.error({ err: error, guildId }, 'voice connection error');
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
    if (joiningByGuild.get(guildId) === connection) {
      joiningByGuild.delete(guildId);
    }
    try {
      connection.destroy();
    } catch {
      // ignore
    }
    throw new UserFacingError(
      'Failed to join the voice channel (UDP/voice handshake failed). Check firewall/VPN and try again.',
      { cause: error },
    );
  }

  if (joiningByGuild.get(guildId) === connection) {
    joiningByGuild.delete(guildId);
  }

  // Another waiter may have observed us — prefer the session we just created.
  const session = createGuildSession({
    guildId,
    channelId: channel.id,
    connection,
    sessionToken: resolveSessionTokenForJoin(previousToken),
    volume: previousVolume,
    logger,
  });

  sessions.set(guildId, session);
  logger.info({ guildId, channelId: channel.id }, 'joined voice channel');

  if (didRemount) {
    void Promise.resolve(sessionRemountedHandler?.(guildId, remountResumeMs)).catch(
      (error: unknown) => {
        logger.warn({ err: error, guildId }, 'session remount resume handler failed');
      },
    );
  }

  return session;
}

async function tryRejoinChannel(
  session: GuildSession,
  channel: VoiceBasedChannel,
  logger: Logger,
): Promise<GuildSession | null> {
  const rejoined = session.connection.rejoin({
    channelId: channel.id,
    selfDeaf: true,
    selfMute: false,
  });
  if (!rejoined) {
    return null;
  }

  try {
    await entersState(session.connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
    logger.warn(
      { err: error, guildId: session.guildId, channelId: channel.id },
      'voice rejoin Ready failed; will fall back to remount',
    );
    return null;
  }

  session.channelId = channel.id;
  logger.info(
    { guildId: session.guildId, channelId: channel.id },
    'moved voice channel via rejoin',
  );
  return session;
}

function createGuildSession(options: {
  readonly guildId: string;
  readonly channelId: string;
  readonly connection: VoiceConnection;
  readonly sessionToken: string;
  readonly volume: number;
  readonly logger: Logger;
}): GuildSession {
  const { guildId, channelId, connection, sessionToken, volume, logger } = options;
  const player = createAudioPlayer();
  connection.subscribe(player);

  const session: GuildSession = {
    guildId,
    connection,
    player,
    ffmpeg: null,
    volume,
    current: null,
    channelId,
    sessionToken,
    seekOffsetMs: 0,
    startedAtMs: null,
    pausedAtMs: null,
    accumulatedPauseMs: 0,
    durationMs: null,
    ignoreNextIdle: false,
  };

  player.on('error', (error) => {
    logger.error({ err: error, guildId }, 'audio player error');
    killChild(session.ffmpeg);
    session.ffmpeg = null;
  });

  player.on(AudioPlayerStatus.Idle, () => {
    if (session.ignoreNextIdle) {
      session.ignoreNextIdle = false;
      return;
    }
    void Promise.resolve(playerIdleHandler?.(guildId)).catch((error: unknown) => {
      logger.warn({ err: error, guildId }, 'queue idle handler failed');
    });
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    void (async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        await getJoinMutex(guildId).runExclusive(() => {
          if (!mayTeardownAfterDisconnect(guildId, connection)) {
            return;
          }
          destroySessionUnlocked(guildId, {
            clearQueue: true,
            expectedConnection: connection,
          });
        });
      }
    })();
  });

  return session;
}

/** @internal Test helper — stable token reuse rule for remounts. */
export function resolveSessionTokenForJoin(previousToken: string | undefined): string {
  return previousToken ?? newSessionToken();
}

/** @internal Test helper — mark an in-flight join for teardown-guard tests. */
export function markJoiningForTests(guildId: string, connection: VoiceConnection): void {
  joiningByGuild.set(guildId, connection);
}

/** @internal Test helper */
export function clearJoiningForTests(): void {
  joiningByGuild.clear();
}

/** @internal Test helper — install a fake session mapping for identity checks. */
export function setSessionConnectionForTests(
  guildId: string,
  connection: VoiceConnection,
): void {
  const existing = sessions.get(guildId);
  if (existing) {
    existing.connection = connection;
    return;
  }
  sessions.set(guildId, {
    guildId,
    connection,
    player: createAudioPlayer(),
    ffmpeg: null,
    volume: 100,
    current: null,
    channelId: 'test-channel',
    sessionToken: newSessionToken(),
    seekOffsetMs: 0,
    startedAtMs: null,
    pausedAtMs: null,
    accumulatedPauseMs: 0,
    durationMs: null,
    ignoreNextIdle: false,
  });
}

/** @internal Test helper */
export function clearSessionsForTests(): void {
  sessions.clear();
  joiningByGuild.clear();
}

export async function leaveChannel(guildId: string): Promise<boolean> {
  return getJoinMutex(guildId).runExclusive(() => destroySessionUnlocked(guildId));
}

/**
 * Teardown implementation. Caller must hold the guild join mutex when racing joins,
 * or be the sole caller (shutdown).
 */
function destroySessionUnlocked(
  guildId: string,
  options: {
    readonly clearQueue?: boolean;
    readonly expectedConnection?: VoiceConnection;
  } = {},
): boolean {
  const clearQueue = options.clearQueue ?? true;
  const session = sessions.get(guildId);
  if (!session) {
    if (joiningByGuild.has(guildId)) {
      return false;
    }
    const orphan = getVoiceConnection(guildId);
    orphan?.destroy();
    return false;
  }
  if (
    options.expectedConnection !== undefined &&
    session.connection !== options.expectedConnection
  ) {
    return false;
  }
  // Notify queue before player.stop so suppressIdle is set before Idle fires (channel moves).
  sessionDestroyedHandler?.(guildId, clearQueue);
  killChild(session.ffmpeg);
  session.ffmpeg = null;
  session.player.stop(true);
  try {
    session.connection.destroy();
  } catch {
    // ignore
  }
  sessions.delete(guildId);
  return true;
}

export function getSession(guildId: string): GuildSession | undefined {
  return sessions.get(guildId);
}

export function getSessionToken(guildId: string): string | null {
  const session = sessions.get(guildId);
  return session?.sessionToken ?? null;
}

export async function playDirectUrl(
  guildId: string,
  track: TrackLike,
  env: Env,
  logger: Logger,
  options: PlayDirectOptions = {},
): Promise<{ mode: 'copy' | 'transcode' }> {
  return playMutex.runExclusive(() =>
    playDirectUrlUnlocked(guildId, track, env, logger, {
      seekMs: options.seekMs,
      durationMs: options.durationMs,
      allowRestore: true,
    }),
  );
}

/**
 * Start (or replace) playback. Caller must hold playMutex.
 * When replacing a busy stream fails, optionally restore the previous track once.
 */
async function playDirectUrlUnlocked(
  guildId: string,
  track: TrackLike,
  env: Env,
  logger: Logger,
  options: {
    readonly seekMs?: number;
    readonly durationMs?: number | null;
    readonly allowRestore: boolean;
  },
): Promise<{ mode: 'copy' | 'transcode' }> {
  await assertSafeMediaUrl(track.url);

  const session = sessions.get(guildId);
  if (!session) {
    throw new UserFacingError('I am not in a voice channel. Use `/join` first.');
  }

  const thisGuildBusy = isSessionBusy(session);
  if (!thisGuildBusy && getActiveStreamCount() >= env.MUSIC_MAX_CONCURRENT_STREAMS) {
    throw new CapacityError(
      `The host is at capacity (${env.MUSIC_MAX_CONCURRENT_STREAMS} concurrent streams). Queued tracks will start when a slot frees.`,
    );
  }

  const seekMs = Math.max(0, options.seekMs ?? 0);
  const previousTrack = thisGuildBusy ? session.current : null;
  const previousResumeMs = thisGuildBusy ? getPlaybackPositionMs(guildId) : 0;
  const previousDurationMs = thisGuildBusy ? session.durationMs : null;

  // Avoid queue auto-advance when replacing an active stream (volume/seek restart).
  if (thisGuildBusy) {
    session.ignoreNextIdle = true;
  }
  killChild(session.ffmpeg);
  session.ffmpeg = null;
  session.player.stop(true);

  const volume = session.volume;
  const args = buildFfmpegArgs(track, {
    volume,
    seekMs,
    opusBitrate: env.MUSIC_OPUS_BITRATE,
  });
  const mode = args.includes('copy') ? 'copy' : 'transcode';

  const child = spawn(env.FFMPEG_PATH, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  trackedChildren.add(child);
  session.ffmpeg = child;
  session.current = track;
  session.seekOffsetMs = seekMs;
  session.startedAtMs = Date.now();
  session.pausedAtMs = null;
  session.accumulatedPauseMs = 0;
  session.durationMs = options.durationMs ?? null;

  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text.length === 0) {
      return;
    }
    stderrBuf = `${stderrBuf}\n${text}`.slice(-4_000);
    const lower = text.toLowerCase();
    if (lower.includes('error') || lower.includes('404') || lower.includes('failed')) {
      logger.warn({ guildId, ffmpeg: text }, 'ffmpeg stderr');
    } else {
      logger.debug({ guildId, ffmpeg: text }, 'ffmpeg stderr');
    }
  });

  child.on('error', (error) => {
    logger.error({ err: error, guildId }, 'ffmpeg spawn failed');
    trackedChildren.delete(child);
    if (session.ffmpeg === child) {
      session.ffmpeg = null;
    }
  });

  child.on('close', (code) => {
    trackedChildren.delete(child);
    if (session.ffmpeg === child) {
      session.ffmpeg = null;
    }
    if (code !== 0 && code !== null) {
      logger.warn({ guildId, code, stderr: stderrBuf.slice(-500) }, 'ffmpeg exited with error');
    } else {
      logger.debug({ guildId, code }, 'ffmpeg exited');
    }
  });

  const failStart = async (error: unknown, message: string): Promise<never> => {
    killChild(child);
    if (session.ffmpeg === child) {
      session.ffmpeg = null;
    }
    session.ignoreNextIdle = false;
    logger.warn({ guildId, stderr: stderrBuf.slice(-500), err: error }, 'ffmpeg produced no audio');

    if (options.allowRestore && previousTrack !== null) {
      try {
        await playDirectUrlUnlocked(guildId, previousTrack, env, logger, {
          seekMs: previousResumeMs,
          durationMs: previousDurationMs,
          allowRestore: false,
        });
        logger.info(
          { guildId, title: previousTrack.title },
          'restored previous track after failed stream start',
        );
      } catch (restoreError) {
        logger.warn(
          { guildId, err: restoreError },
          'failed to restore previous track after stream start failure',
        );
      }
    }

    throw new UserFacingError(message, { cause: error });
  };

  const stdout = child.stdout;
  if (!stdout) {
    return await failStart(new Error('no stdout'), 'FFmpeg failed to open a stdout pipe.');
  }

  try {
    await waitForStreamData(stdout, 8_000);
  } catch (error) {
    return await failStart(
      error,
      'Could not start audio stream — the URL may be invalid or unreachable.',
    );
  }

  const resource = createAudioResource(stdout, {
    inputType: StreamType.OggOpus,
  });
  session.player.play(resource);
  // Ensure a lingering ignore flag cannot swallow the real track-end Idle.
  session.ignoreNextIdle = false;

  logger.info({ guildId, title: track.title, mode, url: track.url }, 'playback started');
  return { mode };
}

function waitForStreamData(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      stream.off('readable', onReadable);
      stream.off('error', onError);
      stream.off('end', onEnded);
      stream.off('close', onEnded);
    };

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };

    const onReadable = (): void => {
      finish(() => resolve());
    };

    const onError = (error: Error): void => {
      finish(() => reject(error));
    };

    const onEnded = (): void => {
      finish(() => reject(new Error('FFmpeg stdout closed before producing audio')));
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`No audio data within ${timeoutMs}ms`)));
    }, timeoutMs);

    const readable = stream as NodeJS.ReadableStream & { readableLength?: number };
    if ((readable.readableLength ?? 0) > 0) {
      finish(() => resolve());
      return;
    }

    stream.once('readable', onReadable);
    stream.once('error', onError);
    stream.once('end', onEnded);
    stream.once('close', onEnded);
  });
}

export function setSessionVolume(guildId: string, volume: number): void {
  const session = sessions.get(guildId);
  if (session) {
    session.volume = volume;
  }
}

export async function shutdownMusicSessions(): Promise<void> {
  const guildIds = [...sessions.keys()];
  for (const guildId of guildIds) {
    await getJoinMutex(guildId).runExclusive(() => {
      destroySessionUnlocked(guildId);
    });
  }
  killAllFfmpegChildren();
}
