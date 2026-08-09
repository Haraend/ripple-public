import { asc, count, eq } from 'drizzle-orm';
import type { SourceCodec } from '../../modules/music/stream.js';
import type { RippleDb } from '../index.js';
import { trackCache, type TrackCacheRow } from '../schema.js';

/** Signed CDN stream URLs typically expire around this window. */
export const TRACK_CACHE_STREAM_TTL_MS = 5 * 60 * 60 * 1000;
/** Keep title/duration longer than stream URLs. */
export const TRACK_CACHE_METADATA_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface TrackCacheEntry {
  readonly sourceKey: string;
  readonly webpageUrl: string;
  readonly title: string;
  readonly durationMs: number | null;
  readonly streamUrl: string;
  readonly codec: SourceCodec;
  readonly streamFetchedAt: Date;
  readonly metadataFetchedAt: Date;
  readonly lastAccessedAt: Date;
}

export function isStreamFresh(
  streamFetchedAt: Date,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - streamFetchedAt.getTime() < TRACK_CACHE_STREAM_TTL_MS;
}

export function isMetadataFresh(
  metadataFetchedAt: Date,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - metadataFetchedAt.getTime() < TRACK_CACHE_METADATA_TTL_MS;
}

function toEntry(row: TrackCacheRow): TrackCacheEntry {
  const codec: SourceCodec = row.codec === 'opus' ? 'opus' : 'other';
  return {
    sourceKey: row.sourceKey,
    webpageUrl: row.webpageUrl,
    title: row.title,
    durationMs: row.durationMs,
    streamUrl: row.streamUrl,
    codec,
    streamFetchedAt: row.streamFetchedAt,
    metadataFetchedAt: row.metadataFetchedAt,
    lastAccessedAt: row.lastAccessedAt,
  };
}

export class TrackCacheRepository {
  constructor(
    private readonly db: RippleDb,
    private readonly maxRows: number,
  ) {}

  get enabled(): boolean {
    return this.maxRows > 0;
  }

  /**
   * Fresh metadata + stream → return entry and bump last_accessed_at.
   * Otherwise null (caller should resolve via yt-dlp).
   */
  getFresh(sourceKey: string, nowMs: number = Date.now()): TrackCacheEntry | null {
    if (!this.enabled) {
      return null;
    }

    const row = this.db
      .select()
      .from(trackCache)
      .where(eq(trackCache.sourceKey, sourceKey))
      .get();

    if (!row) {
      return null;
    }

    if (!isMetadataFresh(row.metadataFetchedAt, nowMs) || !isStreamFresh(row.streamFetchedAt, nowMs)) {
      return null;
    }

    const touched = new Date(nowMs);
    if (row.lastAccessedAt.getTime() !== touched.getTime()) {
      this.db
        .update(trackCache)
        .set({ lastAccessedAt: touched })
        .where(eq(trackCache.sourceKey, sourceKey))
        .run();
    }

    return {
      ...toEntry(row),
      lastAccessedAt: touched,
    };
  }

  /**
   * Metadata still valid but stream expired (or always stale stream).
   * Useful for callers that want title hints; currently resolve path re-fetches fully.
   */
  getMetadata(sourceKey: string, nowMs: number = Date.now()): TrackCacheEntry | null {
    if (!this.enabled) {
      return null;
    }

    const row = this.db
      .select()
      .from(trackCache)
      .where(eq(trackCache.sourceKey, sourceKey))
      .get();

    if (!row || !isMetadataFresh(row.metadataFetchedAt, nowMs)) {
      return null;
    }

    return toEntry(row);
  }

  upsert(
    entry: {
      readonly sourceKey: string;
      readonly webpageUrl: string;
      readonly title: string;
      readonly durationMs: number | null;
      readonly streamUrl: string;
      readonly codec: SourceCodec;
    },
    nowMs: number = Date.now(),
  ): void {
    if (!this.enabled) {
      return;
    }

    const now = new Date(nowMs);
    this.db
      .insert(trackCache)
      .values({
        sourceKey: entry.sourceKey,
        webpageUrl: entry.webpageUrl,
        title: entry.title,
        durationMs: entry.durationMs,
        streamUrl: entry.streamUrl,
        codec: entry.codec,
        streamFetchedAt: now,
        metadataFetchedAt: now,
        lastAccessedAt: now,
      })
      .onConflictDoUpdate({
        target: trackCache.sourceKey,
        set: {
          webpageUrl: entry.webpageUrl,
          title: entry.title,
          durationMs: entry.durationMs,
          streamUrl: entry.streamUrl,
          codec: entry.codec,
          streamFetchedAt: now,
          metadataFetchedAt: now,
          lastAccessedAt: now,
        },
      })
      .run();

    this.prune();
  }

  /** Delete oldest-by-last_accessed rows until count ≤ maxRows. */
  prune(): number {
    if (!this.enabled) {
      return 0;
    }

    const totalRow = this.db.select({ value: count() }).from(trackCache).get();
    const total = totalRow?.value ?? 0;
    if (total <= this.maxRows) {
      return 0;
    }

    const overflow = total - this.maxRows;
    const oldest = this.db
      .select({ sourceKey: trackCache.sourceKey })
      .from(trackCache)
      .orderBy(asc(trackCache.lastAccessedAt), asc(trackCache.sourceKey))
      .limit(overflow)
      .all();

    if (oldest.length === 0) {
      return 0;
    }

    const keys = oldest.map((row) => row.sourceKey);
    return this.db.transaction(() => {
      let removed = 0;
      for (const key of keys) {
        this.db.delete(trackCache).where(eq(trackCache.sourceKey, key)).run();
        removed += 1;
      }
      return removed;
    });
  }

  /** @internal Test helper */
  countRows(): number {
    const totalRow = this.db.select({ value: count() }).from(trackCache).get();
    return totalRow?.value ?? 0;
  }

  /** @internal Test helper — insert without prune for TTL tests */
  insertRaw(row: TrackCacheInsertForTest): void {
    this.db.insert(trackCache).values(row).run();
  }
}

interface TrackCacheInsertForTest {
  readonly sourceKey: string;
  readonly webpageUrl: string;
  readonly title: string;
  readonly durationMs: number | null;
  readonly streamUrl: string;
  readonly codec: string;
  readonly streamFetchedAt: Date;
  readonly metadataFetchedAt: Date;
  readonly lastAccessedAt: Date;
}
