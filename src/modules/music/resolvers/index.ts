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

/** Cap free-text search length so yt-dlp argv stays sane. */
export const MAX_SEARCH_QUERY_LENGTH = 150;

export type QueryKind = 'spotify' | 'ytdlp' | 'direct' | 'search';

export interface ResolveContext {
  readonly env: Env;
  readonly trackCache: TrackCacheRepository;
  readonly logger: Logger;
  readonly fetchFn?: FetchFn;
  readonly spawnFn?: YtDlpSpawnFn;
}

export interface SourceResolver {
  readonly id: QueryKind;
  canHandle(query: string, ctx: ResolveContext): boolean;
  resolve(query: string, ctx: ResolveContext): Promise<ResolvedTrack>;
}

/**
 * Build yt-dlp top-hit search input from free text.
 * Example: Never gonna give you up → ytsearch1:"Never gonna give you up"
 */
export function buildTextSearchQuery(query: string): string {
  const safe = query.trim().replaceAll('"', "'");
  return `ytsearch1:"${safe}"`;
}

function looksLikeHttpUrl(query: string): boolean {
  try {
    const parsed = new URL(query.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
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
    // Spotify links are never direct streams (albums/playlists fail in resolveQuery).
    if (isSpotifyQuery(query)) {
      return false;
    }
    return looksLikeHttpUrl(query);
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
      sourceKey: null,
      streamFetchedAtMs: Date.now(),
    };
  },
};

const searchResolver: SourceResolver = {
  id: 'search',
  canHandle(query) {
    const trimmed = query.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_SEARCH_QUERY_LENGTH) {
      return false;
    }
    if (isSpotifyQuery(trimmed) || looksLikeHttpUrl(trimmed)) {
      return false;
    }
    return true;
  },
  resolve(query, ctx) {
    return resolveWithYtDlp(buildTextSearchQuery(query), ctx.env, {
      spawnFn: ctx.spawnFn,
      trackCache: ctx.trackCache,
      logger: ctx.logger,
    });
  },
};

/** Ordered resolvers: Spotify → yt-dlp hosts → direct HTTP(S) → free-text search. */
export const sourceResolvers: readonly SourceResolver[] = [
  spotifyResolver,
  ytdlpResolver,
  directResolver,
  searchResolver,
];

/**
 * Pure routing helper for tests and /play reply copy.
 * Returns null when no resolver claims the query (after Spotify album/disabled checks in resolveQuery).
 */
export function classifyQuery(query: string, ctx: ResolveContext): QueryKind | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return null;
  }
  for (const resolver of sourceResolvers) {
    if (resolver.canHandle(trimmed, ctx)) {
      return resolver.id;
    }
  }
  return null;
}

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
      'Provide a song name, or a YouTube, SoundCloud, Spotify track, or direct audio URL.',
    );
  }

  if (trimmed.length > MAX_SEARCH_QUERY_LENGTH && !looksLikeHttpUrl(trimmed)) {
    throw new UserFacingError(
      `Search query is too long (max ${MAX_SEARCH_QUERY_LENGTH} characters).`,
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

  const kind = classifyQuery(trimmed, ctx);
  if (kind === null) {
    throw new UserFacingError(
      'Provide a song name, or a YouTube, SoundCloud, Spotify track, or direct audio URL.',
    );
  }

  for (const resolver of sourceResolvers) {
    if (resolver.id === kind) {
      return resolver.resolve(trimmed, ctx);
    }
  }

  throw new UserFacingError(
    'Provide a song name, or a YouTube, SoundCloud, Spotify track, or direct audio URL.',
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
