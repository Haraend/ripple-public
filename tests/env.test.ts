import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv, resetEnvCache } from '../src/config/env.js';

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: 'test-token',
    DISCORD_CLIENT_ID: '123456789012345678',
    NODE_ENV: 'test',
    ...overrides,
  };
}

describe('parseEnv', () => {
  afterEach(() => {
    resetEnvCache();
  });

  it('parses required fields and applies defaults', () => {
    const env = parseEnv(baseEnv());
    expect(env.DISCORD_TOKEN).toBe('test-token');
    expect(env.FFMPEG_PATH).toBe('ffmpeg');
    expect(env.YTDLP_PATH).toBe('yt-dlp');
    expect(env.MUSIC_MAX_CONCURRENT_STREAMS).toBe(2);
    expect(env.ENABLE_PREFIX_COMMANDS).toBe(false);
    expect(env.OWNER_IDS).toEqual([]);
  });

  it('parses OWNER_IDS as a comma-separated snowflake list', () => {
    const env = parseEnv(
      baseEnv({ OWNER_IDS: '123456789012345678, 234567890123456789' }),
    );
    expect(env.OWNER_IDS).toEqual(['123456789012345678', '234567890123456789']);
  });

  it('rejects missing DISCORD_TOKEN with a readable error', () => {
    expect(() => parseEnv(baseEnv({ DISCORD_TOKEN: undefined }))).toThrow(
      /DISCORD_TOKEN/,
    );
  });

  it('rejects partial Spotify credentials', () => {
    expect(() => parseEnv(baseEnv({ SPOTIFY_CLIENT_ID: 'abc' }))).toThrow(/SPOTIFY/);
  });

  it('accepts paired Spotify credentials', () => {
    const env = parseEnv(
      baseEnv({ SPOTIFY_CLIENT_ID: 'abc', SPOTIFY_CLIENT_SECRET: 'secret' }),
    );
    expect(env.SPOTIFY_CLIENT_ID).toBe('abc');
    expect(env.SPOTIFY_CLIENT_SECRET).toBe('secret');
  });
});
