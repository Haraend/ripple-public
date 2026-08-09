import type { ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { Env } from '../../../config/env.js';
import { UserFacingError } from '../../../core/errors.js';
import { Mutex } from '../../../lib/mutex.js';
import { spawnCaptured, type SpawnCapturedOptions, type SpawnResult } from '../../../lib/spawn.js';
import type { SourceCodec, TrackLike } from '../stream.js';

export const YTDLP_AUDIO_FORMAT =
  'bestaudio[acodec=opus][abr<=100]/bestaudio[ext=webm]/bestaudio';

const YTDLP_TIMEOUT_MS = 30_000;

const ytdlpDumpSchema = z.object({
  title: z.string().optional(),
  duration: z.number().nullable().optional(),
  webpage_url: z.string().optional(),
  original_url: z.string().optional(),
  url: z.string().min(1),
  acodec: z.string().nullable().optional(),
  ext: z.string().optional(),
});

export interface ResolvedTrack extends TrackLike {
  readonly durationMs: number | null;
  readonly webpageUrl: string;
}

export type YtDlpSpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnCapturedOptions,
) => Promise<SpawnResult>;

const resolveMutex = new Mutex();
const trackedChildren = new Set<ChildProcess>();

function killChild(child: ChildProcess): void {
  if (child.killed) {
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already dead
  }
}

export function killYtDlpChildren(): void {
  for (const child of trackedChildren) {
    killChild(child);
  }
  trackedChildren.clear();
}

function isYoutubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'youtu.be' ||
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube-nocookie.com')
  );
}

function isSoundcloudHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'soundcloud.com' || host.endsWith('.soundcloud.com');
}

/** True when the query is a YouTube or SoundCloud URL that should go through yt-dlp. */
export function shouldUseYtDlp(query: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(query.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  return isYoutubeHost(parsed.hostname) || isSoundcloudHost(parsed.hostname);
}

function deriveCodec(acodec: string | null | undefined, ext: string | undefined): SourceCodec {
  const codec = (acodec ?? '').toLowerCase();
  if (codec.includes('opus')) {
    return 'opus';
  }
  const extension = (ext ?? '').toLowerCase();
  if (extension === 'opus' || extension === 'ogg') {
    return 'opus';
  }
  // YouTube bestaudio webm is almost always Opus
  if (extension === 'webm' && (codec === '' || codec === 'none')) {
    return 'opus';
  }
  return 'other';
}

function buildArgs(query: string, env: Env): string[] {
  const args = [
    '--dump-single-json',
    '--no-download',
    '--no-cache-dir',
    '--no-part',
    '-f',
    YTDLP_AUDIO_FORMAT,
  ];
  if (env.YTDLP_COOKIES_PATH !== undefined) {
    args.push('--cookies', env.YTDLP_COOKIES_PATH);
  }
  args.push('--', query);
  return args;
}

function parseDump(stdout: string): ResolvedTrack {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new UserFacingError('Could not parse media metadata.', { cause: error });
  }

  const parsed = ytdlpDumpSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UserFacingError('Could not resolve that media URL.');
  }

  const data = parsed.data;
  const title = data.title?.trim() || 'Unknown title';
  const webpageUrl = data.webpage_url ?? data.original_url ?? data.url;
  const durationMs =
    data.duration !== undefined && data.duration !== null && Number.isFinite(data.duration)
      ? Math.max(0, Math.round(data.duration * 1000))
      : null;

  return {
    url: data.url,
    title,
    codec: deriveCodec(data.acodec, data.ext),
    durationMs,
    webpageUrl,
  };
}

export interface ResolveWithYtDlpOptions {
  readonly spawnFn?: YtDlpSpawnFn;
}

/**
 * Resolve a YouTube/SoundCloud URL (or yt-dlp-compatible query) to a stream URL.
 * Never writes media to disk. Global concurrency is capped at 1.
 */
export async function resolveWithYtDlp(
  queryOrUrl: string,
  env: Env,
  options: ResolveWithYtDlpOptions = {},
): Promise<ResolvedTrack> {
  const query = queryOrUrl.trim();
  if (query.length === 0) {
    throw new UserFacingError('Provide a YouTube or SoundCloud URL.');
  }

  const spawnFn = options.spawnFn ?? spawnCaptured;
  const args = buildArgs(query, env);

  return resolveMutex.runExclusive(async () => {
    let childRef: ChildProcess | null = null;
    try {
      const result = await spawnFn(env.YTDLP_PATH, args, {
        timeoutMs: YTDLP_TIMEOUT_MS,
        onSpawn: (child) => {
          childRef = child;
          trackedChildren.add(child);
          child.once('close', () => {
            trackedChildren.delete(child);
          });
          child.once('error', () => {
            trackedChildren.delete(child);
          });
        },
      });

      if (result.code !== 0) {
        throw new UserFacingError('Could not resolve that media URL.');
      }

      return parseDump(result.stdout);
    } catch (error) {
      if (childRef !== null) {
        killChild(childRef);
        trackedChildren.delete(childRef);
      }
      if (error instanceof UserFacingError) {
        throw error;
      }
      if (error instanceof Error && error.message.includes('timed out')) {
        throw new UserFacingError('Timed out while resolving that URL.', { cause: error });
      }
      throw new UserFacingError('Could not resolve that media URL.', { cause: error });
    }
  });
}

/** @internal Exported for tests — builds the argv that would be passed to yt-dlp. */
export function buildYtDlpArgsForTest(query: string, env: Env): readonly string[] {
  return buildArgs(query, env);
}
