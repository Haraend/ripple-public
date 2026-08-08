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
import type { VoiceBasedChannel } from 'discord.js';
import type { Env } from '../../config/env.js';
import type { Logger } from '../../lib/logger.js';
import { UserFacingError } from '../../core/errors.js';
import { buildFfmpegArgs, type TrackLike } from './stream.js';

interface GuildSession {
  readonly guildId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  ffmpeg: ChildProcess | null;
  volume: number;
  current: TrackLike | null;
}

const sessions = new Map<string, GuildSession>();
const trackedChildren = new Set<ChildProcess>();

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

export async function joinChannel(
  channel: VoiceBasedChannel,
  logger: Logger,
): Promise<GuildSession> {
  const existing = sessions.get(channel.guild.id);
  if (existing) {
    existing.connection.destroy();
    sessions.delete(channel.guild.id);
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
    connection.destroy();
    throw new UserFacingError('Failed to join the voice channel in time.', { cause: error });
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
  };

  player.on('error', (error) => {
    logger.error({ err: error, guildId: channel.guild.id }, 'audio player error');
    killChild(session.ffmpeg);
    session.ffmpeg = null;
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    destroySession(channel.guild.id);
  });

  sessions.set(channel.guild.id, session);
  logger.info({ guildId: channel.guild.id, channelId: channel.id }, 'joined voice channel');
  return session;
}

export function leaveChannel(guildId: string): boolean {
  return destroySession(guildId);
}

function destroySession(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) {
    const orphan = getVoiceConnection(guildId);
    orphan?.destroy();
    return false;
  }
  killChild(session.ffmpeg);
  session.ffmpeg = null;
  session.player.stop(true);
  session.connection.destroy();
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
): Promise<{ mode: 'copy' | 'transcode' }> {
  const session = sessions.get(guildId);
  if (!session) {
    throw new UserFacingError('I am not in a voice channel. Use `/join` first.');
  }

  if (
    getActiveStreamCount() >= env.MUSIC_MAX_CONCURRENT_STREAMS &&
    session.player.state.status === AudioPlayerStatus.Idle &&
    !session.ffmpeg
  ) {
    // Current guild is idle and would become a new stream — check capacity excluding self.
    const others = getActiveStreamCount();
    if (others >= env.MUSIC_MAX_CONCURRENT_STREAMS) {
      throw new UserFacingError(
        `The host is at capacity (${env.MUSIC_MAX_CONCURRENT_STREAMS} concurrent streams). Try again later.`,
      );
    }
  }

  killChild(session.ffmpeg);
  session.ffmpeg = null;
  session.player.stop(true);

  const volume = session.volume;
  const args = buildFfmpegArgs(track, {
    volume,
    seekMs: 0,
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

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text.length > 0) {
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
    logger.debug({ guildId, code }, 'ffmpeg exited');
  });

  if (!child.stdout) {
    killChild(child);
    throw new UserFacingError('FFmpeg failed to open a stdout pipe.');
  }

  const resource = createAudioResource(child.stdout, {
    inputType: StreamType.OggOpus,
  });
  session.player.play(resource);

  logger.info({ guildId, title: track.title, mode, url: track.url }, 'playback started');
  return { mode };
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
