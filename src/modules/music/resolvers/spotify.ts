import { z } from 'zod';
import type { Env } from '../../../config/env.js';
import { isSpotifyEnabled } from '../../../config/env.js';
import { UserFacingError } from '../../../core/errors.js';
import type { TrackCacheRepository } from '../../../db/repositories/track-cache.js';
import type { Logger } from '../../../lib/logger.js';
import { resolveWithYtDlp, type ResolvedTrack, type YtDlpSpawnFn } from './ytdlp.js';

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().positive(),
});

const trackResponseSchema = z.object({
  name: z.string().min(1),
  artists: z
    .array(z.object({ name: z.string().min(1) }))
    .min(1),
});

const SPOTIFY_TRACK_PATH = /^\/track\/([a-zA-Z0-9]+)\/?/u;
const SPOTIFY_URI = /^spotify:track:([a-zA-Z0-9]+)$/u;

export type FetchFn = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SpotifyTrackMeta {
  readonly id: string;
  readonly title: string;
  readonly artists: readonly string[];
}

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

let cachedToken: CachedToken | null = null;

/** Reset in-memory token cache (tests). */
export function resetSpotifyTokenCache(): void {
  cachedToken = null;
}

function isSpotifyHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'open.spotify.com' || host.endsWith('.spotify.com');
}

/** Extract track id from open.spotify.com/track/... or spotify:track:... */
export function parseSpotifyTrackId(query: string): string | null {
  const trimmed = query.trim();
  const uriMatch = SPOTIFY_URI.exec(trimmed);
  if (uriMatch?.[1]) {
    return uriMatch[1];
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (!isSpotifyHost(parsed.hostname)) {
    return null;
  }

  const pathMatch = SPOTIFY_TRACK_PATH.exec(parsed.pathname);
  return pathMatch?.[1] ?? null;
}

/** True for Spotify track URLs/URIs (albums/playlists are not handled). */
export function isSpotifyTrackQuery(query: string): boolean {
  return parseSpotifyTrackId(query) !== null;
}

/** True for any open.spotify.com / spotify: link we recognize as Spotify-shaped. */
export function isSpotifyQuery(query: string): boolean {
  const trimmed = query.trim();
  if (SPOTIFY_URI.test(trimmed) || trimmed.startsWith('spotify:')) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      isSpotifyHost(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Build yt-dlp search query from Spotify metadata.
 * Example: ytsearch1:"Artist1, Artist2 Song Title"
 */
export function buildYtSearchQuery(meta: Pick<SpotifyTrackMeta, 'title' | 'artists'>): string {
  const artists = meta.artists.join(', ').trim();
  const title = meta.title.trim();
  const phrase = artists.length > 0 ? `${artists} ${title}` : title;
  // Escape embedded double-quotes so the yt-dlp search string stays one token.
  const safe = phrase.replaceAll('"', "'");
  return `ytsearch1:"${safe}"`;
}

async function fetchAccessToken(env: Env, fetchFn: FetchFn): Promise<string> {
  const now = Date.now();
  if (cachedToken !== null && cachedToken.expiresAtMs > now + 30_000) {
    return cachedToken.accessToken;
  }

  const clientId = env.SPOTIFY_CLIENT_ID;
  const clientSecret = env.SPOTIFY_CLIENT_SECRET;
  if (clientId === undefined || clientSecret === undefined) {
    throw new UserFacingError(
      'Spotify is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET, or paste a YouTube link instead.',
    );
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  let response: Response;
  try {
    response = await fetchFn('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new UserFacingError('Could not reach Spotify. Try again later.', { cause: error });
  }

  if (!response.ok) {
    throw new UserFacingError('Could not authenticate with Spotify.');
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new UserFacingError('Could not authenticate with Spotify.', { cause: error });
  }

  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new UserFacingError('Could not authenticate with Spotify.');
  }

  cachedToken = {
    accessToken: parsed.data.access_token,
    expiresAtMs: now + parsed.data.expires_in * 1000,
  };
  return cachedToken.accessToken;
}

export async function fetchSpotifyTrackMeta(
  trackId: string,
  env: Env,
  options: { fetchFn?: FetchFn } = {},
): Promise<SpotifyTrackMeta> {
  const fetchFn = options.fetchFn ?? fetch;
  const token = await fetchAccessToken(env, fetchFn);

  let response: Response;
  try {
    response = await fetchFn(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw new UserFacingError('Could not reach Spotify. Try again later.', { cause: error });
  }

  if (response.status === 404) {
    throw new UserFacingError('That Spotify track was not found.');
  }
  if (!response.ok) {
    throw new UserFacingError('Could not look up that Spotify track.');
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new UserFacingError('Could not look up that Spotify track.', { cause: error });
  }

  const parsed = trackResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new UserFacingError('Could not look up that Spotify track.');
  }

  return {
    id: trackId,
    title: parsed.data.name,
    artists: parsed.data.artists.map((artist) => artist.name),
  };
}

export interface ResolveSpotifyOptions {
  readonly fetchFn?: FetchFn;
  readonly spawnFn?: YtDlpSpawnFn;
  readonly trackCache?: TrackCacheRepository;
  readonly logger?: Logger;
}

/**
 * Resolve a Spotify track URL to a playable stream via yt-dlp YouTube search.
 * Metadata only from Spotify — audio always from yt-dlp.
 */
export async function resolveSpotifyTrack(
  query: string,
  env: Env,
  options: ResolveSpotifyOptions = {},
): Promise<ResolvedTrack> {
  if (!isSpotifyEnabled(env)) {
    throw new UserFacingError(
      'Spotify is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET, or paste a YouTube link instead.',
    );
  }

  const trackId = parseSpotifyTrackId(query);
  if (trackId === null) {
    if (isSpotifyQuery(query)) {
      throw new UserFacingError(
        'Only Spotify track links are supported right now (not albums or playlists).',
      );
    }
    throw new UserFacingError('That does not look like a Spotify track link.');
  }

  const meta = await fetchSpotifyTrackMeta(trackId, env, { fetchFn: options.fetchFn });
  const searchQuery = buildYtSearchQuery(meta);
  options.logger?.debug(
    { trackId, title: meta.title, searchQuery },
    'spotify metadata resolved; searching via yt-dlp',
  );

  return resolveWithYtDlp(searchQuery, env, {
    spawnFn: options.spawnFn,
    trackCache: options.trackCache,
    logger: options.logger,
  });
}
