import type { Env } from '../../../config/env.js';
import { isSpotifyEnabled } from '../../../config/env.js';
import { UserFacingError } from '../../../core/errors.js';
import type { TrackCacheRepository } from '../../../db/repositories/track-cache.js';
import type { Logger } from '../../../lib/logger.js';
import { assertSafeMediaUrl } from '../url-safety.js';
import {
  isSpotifyQuery,
  isSpotifyTrackQuery,
  resolveSpotifyTrack,
  type FetchFn,
} from './spotify.js';
import {
  resolveWithYtDlp,
  shouldUseYtDlp,
  type ResolvedTrack,
  type YtDlpSpawnFn,
} from './ytdlp.js';

export interface ResolveContext {
  readonly env: Env;
  readonly trackCache: TrackCacheRepository;
  readonly logger: Logger;
  readonly fetchFn?: FetchFn;
  readonly spawnFn?: YtDlpSpawnFn;
}

export interface SourceResolver {
  readonly id: string;
  canHandle(query: string, ctx: ResolveContext): boolean;
  resolve(query: string, ctx: ResolveContext): Promise<ResolvedTrack>;
}

const spotifyResolver: SourceResolver = {
  id: 'spotify',
  canHandle(query, ctx) {
    return isSpotifyEnabled(ctx.env) && isSpotifyTrackQuery(query);
  },
  resolve(query, ctx) {
    return resolveSpotifyTrack(query, ctx.env, {
      fetchFn: ctx.fetchFn,
      spawnFn: ctx.spawnFn,
      trackCache: ctx.trackCache,
      logger: ctx.logger,
    });
  },
};

const ytdlpResolver: SourceResolver = {
  id: 'ytdlp',
  canHandle(query) {
    return shouldUseYtDlp(query);
  },
  resolve(query, ctx) {
    return resolveWithYtDlp(query, ctx.env, {
      spawnFn: ctx.spawnFn,
      trackCache: ctx.trackCache,
      logger: ctx.logger,
    });
  },
};

const directResolver: SourceResolver = {
  id: 'direct',
  canHandle(query) {
    try {
      const parsed = new URL(query.trim());
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },
  async resolve(query) {
    const url = query.trim();
    await assertSafeMediaUrl(url);
    const lower = url.toLowerCase();
    const codec = lower.endsWith('.opus') || lower.endsWith('.ogg') ? 'opus' : 'other';
    return {
      url,
      title: url.split('/').pop() ?? 'direct-url',
      codec,
      durationMs: null,
      webpageUrl: url,
    };
  },
};

/** Ordered resolvers: Spotify (when enabled) → yt-dlp hosts → direct HTTP(S). */
export const sourceResolvers: readonly SourceResolver[] = [
  spotifyResolver,
  ytdlpResolver,
  directResolver,
];

/**
 * Classify and resolve a /play query to a streamable track.
 * Spotify albums/playlists and non-URL garbage get clear UserFacingErrors.
 */
export async function resolveQuery(
  query: string,
  ctx: ResolveContext,
): Promise<ResolvedTrack> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new UserFacingError(
      'Provide a YouTube, SoundCloud, Spotify track, or direct audio URL.',
    );
  }

  // Spotify-shaped but not a track (or Spotify disabled) — fail before SSRF/direct.
  if (isSpotifyQuery(trimmed) && !isSpotifyTrackQuery(trimmed)) {
    throw new UserFacingError(
      'Only Spotify track links are supported right now (not albums or playlists).',
    );
  }
  if (isSpotifyTrackQuery(trimmed) && !isSpotifyEnabled(ctx.env)) {
    throw new UserFacingError(
      'Spotify is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET, or paste a YouTube link instead.',
    );
  }

  for (const resolver of sourceResolvers) {
    if (resolver.canHandle(trimmed, ctx)) {
      return resolver.resolve(trimmed, ctx);
    }
  }

  throw new UserFacingError(
    'Provide a YouTube, SoundCloud, Spotify track, or direct audio URL.',
  );
}

export {
  isSpotifyQuery,
  isSpotifyTrackQuery,
  parseSpotifyTrackId,
  buildYtSearchQuery,
} from './spotify.js';
export { shouldUseYtDlp } from './ytdlp.js';
export type { ResolvedTrack } from './ytdlp.js';
