import type { RippleClient } from '../client.js';
import { assertPermissionTier, createInteractionContext } from '../context.js';
import { UserFacingError } from '../errors.js';
import type { Logger } from '../../lib/logger.js';

export async function handleChatInputCommand(
  client: RippleClient,
  interaction: import('discord.js').ChatInputCommandInteraction,
): Promise<void> {
  const command = client.commands.get(interaction.commandName);
  if (!command) {
    await interaction.reply({ content: 'Unknown command.', ephemeral: true });
    return;
  }

  const logger = client.services.logger.child({
    command: command.data.name,
    guildId: interaction.guildId,
    userId: interaction.user.id,
  });
  const ctx = createInteractionContext(client, interaction, logger);

  try {
    if (command.guildOnly && !interaction.guild) {
      throw new UserFacingError('This command can only be used in a server.');
    }
    await assertPermissionTier(client, ctx, command.tier);
    await command.execute(ctx);
  } catch (error) {
    await respondWithError(ctx, error, logger);
  }
}

async function respondWithError(
  ctx: ReturnType<typeof createInteractionContext>,
  error: unknown,
  logger: Logger,
): Promise<void> {
  if (error instanceof UserFacingError) {
    const payload = { content: error.message, ephemeral: error.ephemeral };
    try {
      if (ctx.rawInteraction?.deferred || ctx.rawInteraction?.replied) {
        await ctx.editReply(payload);
      } else {
        await ctx.reply(payload);
      }
    } catch (replyError) {
      logger.warn({ err: replyError }, 'failed to send user-facing error reply');
    }
    return;
  }

  logger.error({ err: error }, 'command execution failed');
  const payload = {
    content: 'Something went wrong while running that command.',
    ephemeral: true,
  };
  try {
    if (ctx.rawInteraction?.deferred || ctx.rawInteraction?.replied) {
      await ctx.editReply(payload);
    } else {
      await ctx.reply(payload);
    }
  } catch (replyError) {
    logger.warn({ err: replyError }, 'failed to send generic error reply');
  }
}
