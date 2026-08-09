import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { UserFacingError } from '../src/core/errors.js';
import type { SpawnCapturedOptions, SpawnResult } from '../src/lib/spawn.js';
import {
  buildYtDlpArgsForTest,
  resolveWithYtDlp,
  shouldUseYtDlp,
  YTDLP_AUDIO_FORMAT,
  type YtDlpSpawnFn,
} from '../src/modules/music/resolvers/ytdlp.js';

function testEnv(overrides: Record<string, string | undefined> = {}) {
  return parseEnv({
    DISCORD_TOKEN: 'test-token',
    DISCORD_CLIENT_ID: '123456789012345678',
    NODE_ENV: 'test',
    ...overrides,
  });
}

function mockSpawn(result: SpawnResult | Error): YtDlpSpawnFn {
  return async (_command, _args, _options) => {
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
}

function capturingSpawn(
  result: SpawnResult,
  captured: { command?: string; args?: readonly string[]; options?: SpawnCapturedOptions },
): YtDlpSpawnFn {
  return async (command, args, options) => {
    captured.command = command;
    captured.args = args;
    captured.options = options;
    return result;
  };
}

describe('shouldUseYtDlp', () => {
  it('accepts YouTube and SoundCloud hosts', () => {
    expect(shouldUseYtDlp('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(shouldUseYtDlp('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(shouldUseYtDlp('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(shouldUseYtDlp('https://soundcloud.com/artist/track')).toBe(true);
    expect(shouldUseYtDlp('https://m.soundcloud.com/artist/track')).toBe(true);
  });

  it('rejects direct media URLs and non-URLs', () => {
    expect(shouldUseYtDlp('https://cdn.example.com/audio.opus')).toBe(false);
    expect(shouldUseYtDlp('not a url')).toBe(false);
    expect(shouldUseYtDlp('ftp://youtube.com/watch?v=x')).toBe(false);
  });
});

describe('buildYtDlpArgsForTest', () => {
  it('includes no-download flags and the audio format selector', () => {
    const env = testEnv();
    const args = buildYtDlpArgsForTest('https://youtu.be/abc', env);
    expect(args).toContain('--dump-single-json');
    expect(args).toContain('--no-download');
    expect(args).toContain('--no-cache-dir');
    expect(args).toContain('--no-part');
    expect(args).toContain('-f');
    expect(args).toContain(YTDLP_AUDIO_FORMAT);
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('https://youtu.be/abc');
    expect(args).not.toContain('--cookies');
  });

  it('adds cookies when YTDLP_COOKIES_PATH is set', () => {
    const env = testEnv({ YTDLP_COOKIES_PATH: '/tmp/cookies.txt' });
    const args = buildYtDlpArgsForTest('https://youtu.be/abc', env);
    expect(args).toContain('--cookies');
    expect(args).toContain('/tmp/cookies.txt');
  });
});

describe('resolveWithYtDlp', () => {
  it('parses dump-single-json into a ResolvedTrack', async () => {
    const env = testEnv({ YTDLP_PATH: '/usr/bin/yt-dlp' });
    const captured: {
      command?: string;
      args?: readonly string[];
      options?: SpawnCapturedOptions;
    } = {};
    const dump = {
      title: 'Test Track',
      duration: 125.4,
      webpage_url: 'https://www.youtube.com/watch?v=abc',
      url: 'https://cdn.example.com/stream.webm',
      acodec: 'opus',
      ext: 'webm',
    };

    const track = await resolveWithYtDlp('https://youtu.be/abc', env, {
      spawnFn: capturingSpawn(
        { code: 0, stdout: JSON.stringify(dump), stderr: '' },
        captured,
      ),
    });

    expect(captured.command).toBe('/usr/bin/yt-dlp');
    expect(captured.args).toContain('--no-download');
    expect(captured.args).toContain('--no-cache-dir');
    expect(captured.args).toContain(YTDLP_AUDIO_FORMAT);
    expect(captured.options?.timeoutMs).toBe(30_000);

    expect(track.title).toBe('Test Track');
    expect(track.url).toBe('https://cdn.example.com/stream.webm');
    expect(track.webpageUrl).toBe('https://www.youtube.com/watch?v=abc');
    expect(track.durationMs).toBe(125_400);
    expect(track.codec).toBe('opus');
  });

  it('maps non-zero exit to UserFacingError', async () => {
    const env = testEnv();
    await expect(
      resolveWithYtDlp('https://youtu.be/missing', env, {
        spawnFn: mockSpawn({ code: 1, stdout: '', stderr: 'ERROR: Video unavailable' }),
      }),
    ).rejects.toBeInstanceOf(UserFacingError);
  });

  it('maps timeout to UserFacingError without leaking internals', async () => {
    const env = testEnv();
    await expect(
      resolveWithYtDlp('https://youtu.be/slow', env, {
        spawnFn: mockSpawn(new Error('Command timed out after 30000ms: yt-dlp')),
      }),
    ).rejects.toMatchObject({
      name: 'UserFacingError',
      message: 'Timed out while resolving that URL.',
    });
  });

  it('rejects empty query', async () => {
    const env = testEnv();
    await expect(
      resolveWithYtDlp('   ', env, {
        spawnFn: mockSpawn({ code: 0, stdout: '{}', stderr: '' }),
      }),
    ).rejects.toBeInstanceOf(UserFacingError);
  });

  it('derives other codec when acodec is not opus', async () => {
    const env = testEnv();
    const dump = {
      title: 'Mp3 Track',
      duration: 60,
      url: 'https://cdn.example.com/a.mp3',
      acodec: 'mp3',
      ext: 'mp3',
    };
    const track = await resolveWithYtDlp('https://soundcloud.com/a/b', env, {
      spawnFn: mockSpawn({ code: 0, stdout: JSON.stringify(dump), stderr: '' }),
    });
    expect(track.codec).toBe('other');
  });
});
