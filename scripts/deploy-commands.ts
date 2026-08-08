import { PermissionFlagsBits, REST, Routes } from 'discord.js';
import { loadDotEnv } from '../src/config/load-dotenv.js';
import { parseEnv, resetEnvCache } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { coreModule } from '../src/modules/core/index.js';
import { musicModule } from '../src/modules/music/index.js';
import type { Command } from '../src/core/types.js';

function collectCommands(): Command[] {
  return [...coreModule.commands, ...musicModule.commands];
}

function toJson(command: Command) {
  const builder = command.data;
  if (command.tier === 'admin' || command.defaultMemberPermissions) {
    const perms = command.defaultMemberPermissions ?? PermissionFlagsBits.ManageGuild;
    builder.setDefaultMemberPermissions(
      typeof perms === 'bigint' || typeof perms === 'string' || typeof perms === 'number'
        ? perms
        : PermissionFlagsBits.ManageGuild,
    );
  }
  return builder.toJSON();
}

async function main(): Promise<void> {
  loadDotEnv();
  resetEnvCache();
  const env = parseEnv();
  const logger = createLogger(env);

  const all = collectCommands();
  const globalCommands = all.filter((command) => command.tier !== 'owner');
  const ownerCommands = all.filter((command) => command.tier === 'owner');

  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);

  logger.info({ count: globalCommands.length }, 'deploying global application commands');
  await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), {
    body: globalCommands.map(toJson),
  });
  logger.info('global commands registered (can take up to ~1 hour to propagate)');

  if (env.DEV_GUILD_ID) {
    const guildBody = [...globalCommands, ...ownerCommands].map(toJson);
    await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DEV_GUILD_ID), {
      body: guildBody,
    });
    logger.info(
      { guildId: env.DEV_GUILD_ID, ownerCommands: ownerCommands.length },
      'guild commands registered (includes owner commands)',
    );
  } else if (ownerCommands.length > 0) {
    logger.warn(
      'OWNER commands exist but DEV_GUILD_ID is unset — /owner will not be registered anywhere',
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
