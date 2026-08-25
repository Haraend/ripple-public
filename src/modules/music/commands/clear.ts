import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../../core/types.js';
import { clearUpcoming } from '../queue.js';

export const clearCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear upcoming tracks (keeps the current song)'),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['clear'],
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }
    const removed = await clearUpcoming(ctx.guild.id);
    await ctx.reply(
      removed === 0
        ? 'The queue was already empty.'
        : `Cleared **${removed}** upcoming track${removed === 1 ? '' : 's'}.`,
    );
  },
};
