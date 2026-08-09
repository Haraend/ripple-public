import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  isMetadataFresh,
  isStreamFresh,
  TRACK_CACHE_METADATA_TTL_MS,
  TRACK_CACHE_STREAM_TTL_MS,
  TrackCacheRepository,
} from '../src/db/repositories/track-cache.js';
import { createLogger } from '../src/lib/logger.js';
import { parseEnv, resetEnvCache } from '../src/config/env.js';

function testLogger() {
  return createLogger(
    parseEnv({
      DISCORD_TOKEN: 'test-token',
      DISCORD_CLIENT_ID: '123456789012345678',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    }),
  );
}

describe('track cache TTL helpers', () => {
  afterEach(() => {
    resetEnvCache();
  });

  it('treats stream as fresh within 5 hours', () => {
    const now = 1_000_000;
    expect(isStreamFresh(new Date(now - TRACK_CACHE_STREAM_TTL_MS + 1), now)).toBe(true);
    expect(isStreamFresh(new Date(now - TRACK_CACHE_STREAM_TTL_MS), now)).toBe(false);
  });

  it('treats metadata as fresh within 30 days', () => {
    const now = 10_000_000_000;
    expect(isMetadataFresh(new Date(now - TRACK_CACHE_METADATA_TTL_MS + 1), now)).toBe(true);
    expect(isMetadataFresh(new Date(now - TRACK_CACHE_METADATA_TTL_MS), now)).toBe(false);
  });
});

describe('TrackCacheRepository', () => {
  const dirs: string[] = [];

  afterEach(() => {
    resetEnvCache();
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function openRepo(maxRows: number): { repo: TrackCacheRepository; close: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-track-cache-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'test.db');
    const logger = testLogger();
    const { db, sqlite } = createDb({ DATABASE_PATH: dbPath }, logger);
    runMigrations(db, logger);
    return {
      repo: new TrackCacheRepository(db, maxRows),
      close: () => sqlite.close(),
    };
  }

  it('returns fresh hits and skips expired streams', () => {
    const { repo, close } = openRepo(100);
    try {
      const now = Date.now();
      repo.upsert(
        {
          sourceKey: 'https://youtu.be/abc',
          webpageUrl: 'https://www.youtube.com/watch?v=abc',
          title: 'Cached',
          durationMs: 12_000,
          streamUrl: 'https://cdn.example.com/a.webm',
          codec: 'opus',
        },
        now,
      );

      const hit = repo.getFresh('https://youtu.be/abc', now + 1_000);
      expect(hit?.title).toBe('Cached');
      expect(hit?.streamUrl).toBe('https://cdn.example.com/a.webm');

      const stale = repo.getFresh(
        'https://youtu.be/abc',
        now + TRACK_CACHE_STREAM_TTL_MS + 1,
      );
      expect(stale).toBeNull();

      const meta = repo.getMetadata(
        'https://youtu.be/abc',
        now + TRACK_CACHE_STREAM_TTL_MS + 1,
      );
      expect(meta?.title).toBe('Cached');
    } finally {
      close();
    }
  });

  it('prunes oldest last_accessed rows down to max', () => {
    const { repo, close } = openRepo(2);
    try {
      const base = Date.now();
      repo.upsert(
        {
          sourceKey: 'a',
          webpageUrl: 'https://example.com/a',
          title: 'A',
          durationMs: 1,
          streamUrl: 'https://cdn.example.com/a',
          codec: 'opus',
        },
        base,
      );
      repo.upsert(
        {
          sourceKey: 'b',
          webpageUrl: 'https://example.com/b',
          title: 'B',
          durationMs: 1,
          streamUrl: 'https://cdn.example.com/b',
          codec: 'opus',
        },
        base + 1,
      );
      // Touch A so B becomes the older last_accessed when we add C after touching A
      expect(repo.getFresh('a', base + 2)?.title).toBe('A');

      repo.upsert(
        {
          sourceKey: 'c',
          webpageUrl: 'https://example.com/c',
          title: 'C',
          durationMs: 1,
          streamUrl: 'https://cdn.example.com/c',
          codec: 'other',
        },
        base + 3,
      );

      expect(repo.countRows()).toBe(2);
      expect(repo.getFresh('b', base + 4)).toBeNull();
      expect(repo.getFresh('a', base + 4)?.title).toBe('A');
      expect(repo.getFresh('c', base + 4)?.title).toBe('C');
    } finally {
      close();
    }
  });

  it('disables reads and writes when maxRows is 0', () => {
    const { repo, close } = openRepo(0);
    try {
      expect(repo.enabled).toBe(false);
      repo.upsert({
        sourceKey: 'x',
        webpageUrl: 'https://example.com/x',
        title: 'X',
        durationMs: null,
        streamUrl: 'https://cdn.example.com/x',
        codec: 'opus',
      });
      expect(repo.countRows()).toBe(0);
      expect(repo.getFresh('x')).toBeNull();
    } finally {
      close();
    }
  });
});

describe('parseEnv track cache', () => {
  afterEach(() => {
    resetEnvCache();
  });

  it('defaults MUSIC_TRACK_CACHE_MAX_ROWS to 5000', () => {
    const env = parseEnv({
      DISCORD_TOKEN: 'test-token',
      DISCORD_CLIENT_ID: '123456789012345678',
      NODE_ENV: 'test',
    });
    expect(env.MUSIC_TRACK_CACHE_MAX_ROWS).toBe(5000);
  });

  it('allows 0 to disable cache', () => {
    const env = parseEnv({
      DISCORD_TOKEN: 'test-token',
      DISCORD_CLIENT_ID: '123456789012345678',
      NODE_ENV: 'test',
      MUSIC_TRACK_CACHE_MAX_ROWS: '0',
    });
    expect(env.MUSIC_TRACK_CACHE_MAX_ROWS).toBe(0);
  });
});
