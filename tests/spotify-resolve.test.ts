import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv, resetEnvCache } from '../src/config/env.js';
import { UserFacingError } from '../src/core/errors.js';
import { TrackCacheRepository } from '../src/db/repositories/track-cache.js';
import { createDb } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  buildYtSearchQuery,
  fetchSpotifyTrackMeta,
  isSpotifyQuery,
  isSpotifyTrackQuery,
  parseSpotifyTrackId,
  resetSpotifyTokenCache,
  resolveSpotifyTrack,
  type FetchFn,
} from '../src/modules/music/resolvers/spotify.js';
import {
  buildTextSearchQuery,
  classifyQuery,
  MAX_SEARCH_QUERY_LENGTH,
  resolveQuery,
  sourceResolvers,
  type ResolveContext,
} from '../src/modules/music/resolvers/index.js';
import type { YtDlpSpawnFn } from '../src/modules/music/resolvers/ytdlp.js';
import { createLogger } from '../src/lib/logger.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function testEnv(overrides: Record<string, string | undefined> = {}) {
  return parseEnv({
    DISCORD_TOKEN: 'test-token',
    DISCORD_CLIENT_ID: '123456789012345678',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

const mockYoutubeSpawn: YtDlpSpawnFn = async () => ({
  code: 0,
  stdout: JSON.stringify({
    title: 'Zoo',
    duration: 19,
    webpage_url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    url: 'https://cdn.example.com/z.webm',
    acodec: 'opus',
    ext: 'webm',
  }),
  stderr: '',
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('spotify URL parsing', () => {
  it('parses open.spotify.com track URLs and URIs', () => {
    expect(parseSpotifyTrackId('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl')).toBe(
      '11dFghVXANMlKmJXsNCbNl',
    );
    expect(
      parseSpotifyTrackId('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl?si=abc'),
    ).toBe('11dFghVXANMlKmJXsNCbNl');
    expect(parseSpotifyTrackId('spotify:track:11dFghVXANMlKmJXsNCbNl')).toBe(
      '11dFghVXANMlKmJXsNCbNl',
    );
  });

  it('rejects albums/playlists and non-spotify', () => {
    expect(parseSpotifyTrackId('https://open.spotify.com/album/abc')).toBeNull();
    expect(parseSpotifyTrackId('https://open.spotify.com/playlist/abc')).toBeNull();
    expect(parseSpotifyTrackId('https://youtu.be/abc')).toBeNull();
    expect(isSpotifyTrackQuery('https://open.spotify.com/album/abc')).toBe(false);
    expect(isSpotifyQuery('https://open.spotify.com/album/abc')).toBe(true);
  });
});

describe('buildYtSearchQuery', () => {
  it('builds ytsearch1 query from artists and title', () => {
    expect(
      buildYtSearchQuery({ title: 'Song', artists: ['Artist A', 'Artist B'] }),
    ).toBe('ytsearch1:"Artist A, Artist B Song"');
  });
});

describe('fetchSpotifyTrackMeta', () => {
  afterEach(() => {
    resetEnvCache();
    resetSpotifyTokenCache();
  });

  it('fetches token then track metadata', async () => {
    const env = testEnv({
      SPOTIFY_CLIENT_ID: 'cid',
      SPOTIFY_CLIENT_SECRET: 'secret',
    });
    const calls: string[] = [];
    const fetchFn: FetchFn = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('accounts.spotify.com')) {
        return jsonResponse({
          access_token: 'tok',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      return jsonResponse({
        name: 'Me at the zoo',
        artists: [{ name: 'jawed' }],
      });
    };

    const meta = await fetchSpotifyTrackMeta('11dFghVXANMlKmJXsNCbNl', env, { fetchFn });
    expect(meta.title).toBe('Me at the zoo');
    expect(meta.artists).toEqual(['jawed']);
    expect(calls[0]).toContain('accounts.spotify.com/api/token');
    expect(calls[1]).toContain('/v1/tracks/11dFghVXANMlKmJXsNCbNl');
  });

  it('surfaces Spotify 429 when Retry-After is too long', async () => {
    const env = testEnv({
      SPOTIFY_CLIENT_ID: 'cid',
      SPOTIFY_CLIENT_SECRET: 'secret',
    });
    const fetchFn: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('accounts.spotify.com')) {
        return jsonResponse({
          access_token: 'tok',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      return new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '30' },
      });
    };

    await expect(
      fetchSpotifyTrackMeta('4cOdK2wGLETKBW3PvgPWqT', env, { fetchFn }),
    ).rejects.toMatchObject({
      name: 'UserFacingError',
      message: expect.stringContaining('rate-limiting'),
    });
  });

  it('reuses cached token on second call', async () => {
    const env = testEnv({
      SPOTIFY_CLIENT_ID: 'cid',
      SPOTIFY_CLIENT_SECRET: 'secret',
    });
    let tokenCalls = 0;
    const fetchFn: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('accounts.spotify.com')) {
        tokenCalls += 1;
        return jsonResponse({
          access_token: 'tok',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      return jsonResponse({ name: 'T', artists: [{ name: 'A' }] });
    };

    await fetchSpotifyTrackMeta('aaa', env, { fetchFn });
    await fetchSpotifyTrackMeta('bbb', env, { fetchFn });
    expect(tokenCalls).toBe(1);
  });
});

describe('resolveSpotifyTrack', () => {
  afterEach(() => {
    resetEnvCache();
    resetSpotifyTokenCache();
  });

  it('errors when Spotify is not configured', async () => {
    const env = testEnv();
    await expect(
      resolveSpotifyTrack('https://open.spotify.com/track/abc123abc12', env),
    ).rejects.toBeInstanceOf(UserFacingError);
  });

  it('bridges metadata to yt-dlp ytsearch1', async () => {
    const env = testEnv({
      SPOTIFY_CLIENT_ID: 'cid',
      SPOTIFY_CLIENT_SECRET: 'secret',
    });
    const fetchFn: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('accounts.spotify.com')) {
        return jsonResponse({
          access_token: 'tok',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      return jsonResponse({
        name: 'Never Gonna Give You Up',
        artists: [{ name: 'Rick Astley' }],
      });
    };

    let ytdlpQuery = '';
    const spawnFn: YtDlpSpawnFn = async (_cmd, args) => {
      ytdlpQuery = String(args.at(-1) ?? '');
      return {
        code: 0,
        stdout: JSON.stringify({
          title: 'Rick Astley - Never Gonna Give You Up',
          duration: 213,
          webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          url: 'https://cdn.example.com/stream.webm',
          acodec: 'opus',
          ext: 'webm',
        }),
        stderr: '',
      };
    };

    const track = await resolveSpotifyTrack(
      'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
      env,
      { fetchFn, spawnFn },
    );

    expect(ytdlpQuery).toBe('ytsearch1:"Rick Astley Never Gonna Give You Up"');
    expect(track.url).toBe('https://cdn.example.com/stream.webm');
    expect(track.codec).toBe('opus');
  });
});

describe('resolveQuery classification', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetEnvCache();
    resetSpotifyTokenCache();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function ctx(overrides: Record<string, string | undefined> = {}): ResolveContext & {
    close: () => void;
  } {
    const env = testEnv(overrides);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-spotify-'));
    tempDirs.push(dir);
    const logger = createLogger(env);
    const { db, sqlite } = createDb({ DATABASE_PATH: path.join(dir, 't.db') }, logger);
    runMigrations(db, logger);
    return {
      env,
      trackCache: new TrackCacheRepository(db, 0),
      logger,
      close: () => sqlite.close(),
    };
  }

  it('lists expected resolver order', () => {
    expect(sourceResolvers.map((r) => r.id)).toEqual(['spotify', 'ytdlp', 'direct', 'search']);
  });

  it('classifies queries without spawning', () => {
    const context = ctx({
      SPOTIFY_CLIENT_ID: 'cid',
      SPOTIFY_CLIENT_SECRET: 'secret',
    });
    try {
      expect(classifyQuery('https://www.youtube.com/watch?v=jNQXAC9IVRw', context)).toBe(
        'ytdlp',
      );
      expect(classifyQuery('https://soundcloud.com/artist/track', context)).toBe('ytdlp');
      expect(classifyQuery('https://cdn.example.com/a.opus', context)).toBe('direct');
      expect(classifyQuery('Never gonna give you up', context)).toBe('search');
      expect(
        classifyQuery('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', context),
      ).toBe('spotify');
      expect(classifyQuery('https://open.spotify.com/album/abc', context)).toBeNull();
      expect(classifyQuery('   ', context)).toBeNull();
    } finally {
      context.close();
    }
  });

  it('routes YouTube via ytdlp and free text via search', async () => {
    const context = ctx();
    try {
      const track = await resolveQuery('https://www.youtube.com/watch?v=jNQXAC9IVRw', {
        ...context,
        spawnFn: mockYoutubeSpawn,
      });
      expect(track.title).toBe('Zoo');

      let searchArg: string | undefined;
      const searchSpawn: YtDlpSpawnFn = async (_cmd, args) => {
        searchArg = args[args.length - 1];
        return mockYoutubeSpawn(_cmd, args);
      };
      const searched = await resolveQuery('Never gonna give you up', {
        ...context,
        spawnFn: searchSpawn,
      });
      expect(searched.title).toBe('Zoo');
      expect(searchArg).toBe(buildTextSearchQuery('Never gonna give you up'));
      expect(searchArg).toContain('ytsearch1:');

      await expect(resolveQuery('   ', context)).rejects.toBeInstanceOf(UserFacingError);
      await expect(
        resolveQuery('x'.repeat(MAX_SEARCH_QUERY_LENGTH + 1), context),
      ).rejects.toMatchObject({
        name: 'UserFacingError',
        message: expect.stringContaining('too long'),
      });
    } finally {
      context.close();
    }
  });

  it('rejects Spotify track when credentials absent', async () => {
    const context = ctx();
    try {
      await expect(
        resolveQuery('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', context),
      ).rejects.toMatchObject({
        name: 'UserFacingError',
        message: expect.stringContaining('Spotify is not configured'),
      });
    } finally {
      context.close();
    }
  });

  it('rejects Spotify album links', async () => {
    const context = ctx({
      SPOTIFY_CLIENT_ID: 'cid',
      SPOTIFY_CLIENT_SECRET: 'secret',
    });
    try {
      await expect(
        resolveQuery('https://open.spotify.com/album/abc', context),
      ).rejects.toMatchObject({
        name: 'UserFacingError',
        message: expect.stringContaining('track links'),
      });
    } finally {
      context.close();
    }
  });
});
