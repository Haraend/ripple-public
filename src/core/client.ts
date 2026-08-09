import {
  Client,
  Collection,
  GatewayIntentBits,
  Options,
  Partials,
  type ClientOptions,
} from 'discord.js';
import type { Env } from '../config/env.js';
import type { RippleDb } from '../db/index.js';
import type { GuildSettingsRepository } from '../db/repositories/guild-settings.js';
import type { Logger } from '../lib/logger.js';
import type { Command, Module } from './types.js';

export interface RippleServices {
  readonly env: Env;
  readonly logger: Logger;
  readonly db: RippleDb;
  readonly guildSettings: GuildSettingsRepository;
  readonly closeDb: () => void;
}

export class RippleClient extends Client {
  readonly commands = new Collection<string, Command>();
  readonly modules = new Collection<string, Module>();
  readonly services: RippleServices;

  constructor(services: RippleServices, options?: ClientOptions) {
    const intents: number[] = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
    if (services.env.ENABLE_PREFIX_COMMANDS) {
      intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
    }

    super({
      intents,
      partials: [Partials.Channel],
      makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 0,
        PresenceManager: 0,
        ReactionManager: 0,
        ReactionUserManager: 0,
        GuildEmojiManager: 0,
        GuildStickerManager: 0,
        StageInstanceManager: 0,
        ThreadManager: 0,
        ThreadMemberManager: 0,
        GuildBanManager: 0,
        GuildInviteManager: 0,
        GuildScheduledEventManager: 0,
        GuildMemberManager: {
          maxSize: 50,
          keepOverLimit: (member) => member.id === member.client.user.id,
        },
      }),
      sweepers: {
        ...Options.DefaultSweeperSettings,
        messages: {
          interval: 1_800,
          lifetime: 600,
        },
        users: {
          interval: 1_800,
          filter: () => (user) => user.bot && user.id !== user.client.user.id,
        },
      },
      ...options,
    });

    this.services = services;
  }
}
