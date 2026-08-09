import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const guildSettings = sqliteTable('guild_settings', {
  guildId: text('guild_id').primaryKey(),
  apexChannelId: text('apex_channel_id'),
  djRoleId: text('dj_role_id'),
  djModeEnabled: integer('dj_mode_enabled', { mode: 'boolean' }).notNull().default(false),
  musicEnabled: integer('music_enabled', { mode: 'boolean' }).notNull().default(true),
  defaultVolume: integer('default_volume').notNull().default(100),
  maxQueueSize: integer('max_queue_size').notNull().default(100),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
});

export type GuildSettingsRow = typeof guildSettings.$inferSelect;
export type GuildSettingsInsert = typeof guildSettings.$inferInsert;

/** Metadata + stream URL cache only — never stores media bytes. */
export const trackCache = sqliteTable('track_cache', {
  sourceKey: text('source_key').primaryKey(),
  webpageUrl: text('webpage_url').notNull(),
  title: text('title').notNull(),
  durationMs: integer('duration_ms'),
  streamUrl: text('stream_url').notNull(),
  codec: text('codec').notNull(),
  streamFetchedAt: integer('stream_fetched_at', { mode: 'timestamp_ms' }).notNull(),
  metadataFetchedAt: integer('metadata_fetched_at', { mode: 'timestamp_ms' }).notNull(),
  lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp_ms' }).notNull(),
});

export type TrackCacheRow = typeof trackCache.$inferSelect;
export type TrackCacheInsert = typeof trackCache.$inferInsert;
