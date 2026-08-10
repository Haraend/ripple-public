import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { removeUpcoming } from '../queue.js';

export const removeCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track from the upcoming queue by position')
    .addIntegerOption((option) =>
      option
        .setName('position')
        .setDescription('1-based position in the upcoming queue')
        .setRequired(true)
        .setMinValue(1),
    ),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['remove', 'rm'],
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }
    const position = ctx.options.getInteger('position', true);
    if (position === null) {
      throw new UserFacingError('Provide a queue position to remove.');
    }
    const removed = await removeUpcoming(ctx.guild.id, position);
    await ctx.reply(`Removed \`${removed.title}\` from position **#${position}**.`);
  },
};
