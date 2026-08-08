import { eq } from 'drizzle-orm';
import type { RippleDb } from '../index.js';
import { guildSettings, type GuildSettingsRow } from '../schema.js';

export type GuildSettings = GuildSettingsRow;

const DEFAULTS = {
  apexChannelId: null as string | null,
  djRoleId: null as string | null,
  djModeEnabled: false,
  musicEnabled: true,
  defaultVolume: 100,
  maxQueueSize: 100,
} as const;

export class GuildSettingsRepository {
  private readonly cache = new Map<string, GuildSettings>();

  constructor(private readonly db: RippleDb) {}

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

    const created = this.db
      .insert(guildSettings)
      .values({
        guildId,
        ...DEFAULTS,
        updatedAt: new Date(),
      })
      .returning()
      .get();

    this.cache.set(guildId, created);
    return created;
  }

  update(
    guildId: string,
    patch: Partial<
      Pick<
        GuildSettings,
        | 'apexChannelId'
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
