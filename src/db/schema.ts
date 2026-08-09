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
