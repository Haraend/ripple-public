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
import { UserFacingError } from '../../core/errors.js';
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

type GuildIdHandler = (guildId: string) => void | Promise<void>;
type SessionDestroyedHandler = (
  guildId: string,
  clearQueue: boolean,
) => void | Promise<void>;

let playerIdleHandler: GuildIdHandler | null = null;
let sessionDestroyedHandler: SessionDestroyedHandler | null = null;

/** Avoid circular imports: queue registers Idle / destroy hooks at module init. */
export function setPlayerIdleHandler(handler: GuildIdHandler): void {
  playerIdleHandler = handler;
}

export function setSessionDestroyedHandler(handler: SessionDestroyedHandler): void {
  sessionDestroyedHandler = handler;
}

const sessions = new Map<string, GuildSession>();
const trackedChildren = new Set<ChildProcess>();
const playMutex = new Mutex();

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
 */
export async function ensureVoiceForMember(
  member: GuildMember,
  logger: Logger,
): Promise<GuildSession> {
  const userChannel = member.voice.channel;
  if (!userChannel) {
    throw new UserFacingError('Join a voice channel first.');
  }

  const existing = sessions.get(member.guild.id);
  if (!existing) {
    return joinChannel(userChannel, logger);
  }

  if (existing.channelId === userChannel.id) {
    return existing;
  }

  const botChannel = member.guild.channels.cache.get(existing.channelId);
  const botVoice =
    botChannel && botChannel.isVoiceBased()
      ? botChannel
      : undefined;

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

  // Idle and alone in the other channel — safe to move.
  return joinChannel(userChannel, logger);
}

export async function joinChannel(
  channel: VoiceBasedChannel,
  logger: Logger,
): Promise<GuildSession> {
  if (sessions.has(channel.guild.id)) {
    // Channel move remount — keep the guild music queue.
    destroySession(channel.guild.id, { clearQueue: false });
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  connection.on('error', (error) => {
    logger.error({ err: error, guildId: channel.guild.id }, 'voice connection error');
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
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

  const player = createAudioPlayer();
  connection.subscribe(player);

  const session: GuildSession = {
    guildId: channel.guild.id,
    connection,
    player,
    ffmpeg: null,
    volume: 100,
    current: null,
    channelId: channel.id,
    seekOffsetMs: 0,
    startedAtMs: null,
    pausedAtMs: null,
    accumulatedPauseMs: 0,
    durationMs: null,
    ignoreNextIdle: false,
  };

  player.on('error', (error) => {
    logger.error({ err: error, guildId: channel.guild.id }, 'audio player error');
    killChild(session.ffmpeg);
    session.ffmpeg = null;
  });

  player.on(AudioPlayerStatus.Idle, () => {
    if (session.ignoreNextIdle) {
      session.ignoreNextIdle = false;
      return;
    }
    void Promise.resolve(playerIdleHandler?.(channel.guild.id)).catch((error: unknown) => {
      logger.warn({ err: error, guildId: channel.guild.id }, 'queue idle handler failed');
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
        destroySession(channel.guild.id);
      }
    })();
  });

  sessions.set(channel.guild.id, session);
  logger.info({ guildId: channel.guild.id, channelId: channel.id }, 'joined voice channel');
  return session;
}

export function leaveChannel(guildId: string): boolean {
  return destroySession(guildId);
}

function destroySession(
  guildId: string,
  options: { readonly clearQueue?: boolean } = {},
): boolean {
  const clearQueue = options.clearQueue ?? true;
  const session = sessions.get(guildId);
  if (!session) {
    const orphan = getVoiceConnection(guildId);
    orphan?.destroy();
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

export async function playDirectUrl(
  guildId: string,
  track: TrackLike,
  env: Env,
  logger: Logger,
  options: PlayDirectOptions = {},
): Promise<{ mode: 'copy' | 'transcode' }> {
  return playMutex.runExclusive(async () => {
    // Re-check on every playback (loop / queue / cache) to close DNS-rebinding SSRF.
    await assertSafeMediaUrl(track.url);

    const session = sessions.get(guildId);
    if (!session) {
      throw new UserFacingError('I am not in a voice channel. Use `/join` first.');
    }

    const thisGuildBusy = isSessionBusy(session);
    if (!thisGuildBusy && getActiveStreamCount() >= env.MUSIC_MAX_CONCURRENT_STREAMS) {
      throw new UserFacingError(
        `The host is at capacity (${env.MUSIC_MAX_CONCURRENT_STREAMS} concurrent streams). Try again later.`,
      );
    }

    const seekMs = Math.max(0, options.seekMs ?? 0);
    // Avoid queue auto-advance when replacing an active stream (volume/seek restart).
    if (isSessionBusy(session)) {
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

    if (!child.stdout) {
      killChild(child);
      session.ffmpeg = null;
      throw new UserFacingError('FFmpeg failed to open a stdout pipe.');
    }

    try {
      await waitForStreamData(child.stdout, 8_000);
    } catch (error) {
      killChild(child);
      session.ffmpeg = null;
      logger.warn(
        { guildId, stderr: stderrBuf.slice(-500), err: error },
        'ffmpeg produced no audio',
      );
      throw new UserFacingError(
        'Could not start audio stream — the URL may be invalid or unreachable.',
        { cause: error },
      );
    }

    const resource = createAudioResource(child.stdout, {
      inputType: StreamType.OggOpus,
    });
    session.player.play(resource);
    // Ensure a lingering ignore flag cannot swallow the real track-end Idle.
    session.ignoreNextIdle = false;

    logger.info({ guildId, title: track.title, mode, url: track.url }, 'playback started');
    return { mode };
  });
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
  for (const guildId of sessions.keys()) {
    destroySession(guildId);
  }
  killAllFfmpegChildren();
}
