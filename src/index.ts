import { loadDotEnv } from './config/load-dotenv.js';
import { getEnv, isApexEnabled, isSpotifyEnabled, parseEnv, resetEnvCache } from './config/env.js';
import { RippleClient } from './core/client.js';
import { installShutdownHandlers } from './core/shutdown.js';
import { initModules, registerEvents, registerModule } from './core/registry.js';
import { createDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { GuildSettingsRepository } from './db/repositories/guild-settings.js';
import { clientReadyEvent } from './events/clientReady.js';
import { guildDeleteEvent } from './events/guildDelete.js';
import { interactionCreateEvent } from './events/interactionCreate.js';
import { messageCreateEvent } from './events/messageCreate.js';
import { voiceStateUpdateEvent } from './events/voiceStateUpdate.js';
import { createLogger } from './lib/logger.js';
import { coreModule } from './modules/core/index.js';
import { musicModule } from './modules/music/index.js';

async function main(): Promise<void> {
  loadDotEnv();
  resetEnvCache();
  const env = parseEnv();
  const logger = createLogger(env);

  logger.info(
    {
      node: process.version,
      apex: isApexEnabled(env),
      spotify: isSpotifyEnabled(env),
      prefix: env.ENABLE_PREFIX_COMMANDS,
    },
    'starting ripple',
  );

  const { db, sqlite } = createDb(env, logger);
  runMigrations(db, logger);
  const guildSettings = new GuildSettingsRepository(db);

  const client = new RippleClient({
    env,
    logger,
    db,
    guildSettings,
    closeDb: () => {
      sqlite.close();
    },
  });

  registerModule(client, coreModule);
  registerModule(client, musicModule);
  // Apex module registers in Phase 3 when APEX_API_KEY is present.

  registerEvents(client, [
    clientReadyEvent,
    interactionCreateEvent,
    messageCreateEvent,
    voiceStateUpdateEvent,
    guildDeleteEvent,
  ]);

  installShutdownHandlers(client);
  await initModules(client);
  await client.login(env.DISCORD_TOKEN);
}

main().catch((error: unknown) => {
  // Avoid importing logger before env is valid — print readable message only.
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});

// Re-export for tests / tooling that import the package entry.
export { getEnv };
