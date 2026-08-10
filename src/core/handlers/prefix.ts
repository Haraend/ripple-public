import type { Message } from 'discord.js';
import type { RippleClient } from '../client.js';
import { assertPermissionTier, createMessageContext } from '../context.js';
import { UserFacingError } from '../errors.js';

export async function handlePrefixMessage(client: RippleClient, message: Message): Promise<void> {
  if (!client.services.env.ENABLE_PREFIX_COMMANDS) {
    return;
  }
  if (message.author.bot || !message.guild) {
    return;
  }

  const prefix = client.services.env.COMMAND_PREFIX;
  if (!message.content.startsWith(prefix)) {
    return;
  }

  const withoutPrefix = message.content.slice(prefix.length).trim();
  if (withoutPrefix.length === 0) {
    return;
  }

  const [aliasRaw, ...restParts] = withoutPrefix.split(/\s+/);
  const alias = aliasRaw?.toLowerCase();
  if (!alias) {
    return;
  }

  const command = [...client.commands.values()].find((entry) =>
    entry.prefixAliases?.some((candidate) => candidate.toLowerCase() === alias),
  );
  if (!command) {
    return;
  }

  const rest = restParts.join(' ');
  const logger = client.services.logger.child({
    command: command.data.name,
    alias,
    guildId: message.guild.id,
    userId: message.author.id,
  });
  const ctx = createMessageContext(client, message, rest, logger);

  try {
    if (command.guildOnly && !message.guild) {
      throw new UserFacingError('This command can only be used in a server.');
    }
    await assertPermissionTier(client, ctx, command.tier);
    await command.execute(ctx);
  } catch (error) {
    if (error instanceof UserFacingError) {
      await message.reply({
        content: error.message,
        allowedMentions: { parse: [], repliedUser: false },
      });
      return;
    }
    logger.error({ err: error }, 'prefix command failed');
    await message.reply({
      content: 'Something went wrong while running that command.',
      allowedMentions: { parse: [], repliedUser: false },
    });
  }
}
