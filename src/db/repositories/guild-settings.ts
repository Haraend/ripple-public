import { eq } from 'drizzle-orm';
import type { RippleDb } from '../index.js';
import { guildSettings, type GuildSettingsRow } from '../schema.js';

export type GuildSettings = GuildSettingsRow;

export interface GuildSettingsDefaults {
  readonly apexChannelId: string | null;
  readonly musicChannelId: string | null;
  readonly djRoleId: string | null;
  readonly djModeEnabled: boolean;
  readonly musicEnabled: boolean;
  readonly defaultVolume: number;
  readonly maxQueueSize: number;
}

const FALLBACK_DEFAULTS: GuildSettingsDefaults = {
  apexChannelId: null,
  musicChannelId: null,
  djRoleId: null,
  djModeEnabled: false,
  musicEnabled: true,
  defaultVolume: 100,
  maxQueueSize: 100,
};

export class GuildSettingsRepository {
  private readonly cache = new Map<string, GuildSettings>();
  private readonly defaults: GuildSettingsDefaults;

  constructor(private readonly db: RippleDb, defaults: Partial<GuildSettingsDefaults> = {}) {
    this.defaults = { ...FALLBACK_DEFAULTS, ...defaults };
  }

  get(guildId: string): GuildSettings {
    const cached = this.cache.get(guildId);
    if (cached) {
      return cached;
    }

    const existing = this.db
      .select()
      .from(guildSettings)
      .where(eq(guildSettings.guildId, guildId))
      .get();

    if (existing) {
      this.cache.set(guildId, existing);
      return existing;
    }

    this.db
      .insert(guildSettings)
      .values({
        guildId,
        apexChannelId: this.defaults.apexChannelId,
        musicChannelId: this.defaults.musicChannelId,
        djRoleId: this.defaults.djRoleId,
        djModeEnabled: this.defaults.djModeEnabled,
        musicEnabled: this.defaults.musicEnabled,
        defaultVolume: this.defaults.defaultVolume,
        maxQueueSize: this.defaults.maxQueueSize,
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .run();

    const row = this.db
      .select()
      .from(guildSettings)
      .where(eq(guildSettings.guildId, guildId))
      .get();

    if (!row) {
      throw new Error(`Failed to create guild_settings for ${guildId}`);
    }

    this.cache.set(guildId, row);
    return row;
  }

  update(
    guildId: string,
    patch: Partial<
      Pick<
        GuildSettings,
        | 'apexChannelId'
        | 'musicChannelId'
        | 'djRoleId'
        | 'djModeEnabled'
        | 'musicEnabled'
        | 'defaultVolume'
        | 'maxQueueSize'
      >
    >,
  ): GuildSettings {
    this.get(guildId);
    const updated = this.db
      .update(guildSettings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(guildSettings.guildId, guildId))
      .returning()
      .get();

    this.cache.set(guildId, updated);
    return updated;
  }

  delete(guildId: string): void {
    this.db.delete(guildSettings).where(eq(guildSettings.guildId, guildId)).run();
    this.cache.delete(guildId);
  }

  invalidate(guildId: string): void {
    this.cache.delete(guildId);
  }
}
