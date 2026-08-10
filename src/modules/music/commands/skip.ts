import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../../core/types.js';
import { skipTrack } from '../queue.js';

export const skipCommand: Command = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current track'),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['skip', 's', 'next'],
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }
    const { skipped, next, upcomingCount } = await skipTrack(ctx.guild.id);
    if (next) {
      await ctx.reply(`Skipped \`${skipped.title}\`. Now playing \`${next.title}\`.`);
    } else if (upcomingCount > 0) {
      await ctx.reply(
        `Skipped \`${skipped.title}\`. Could not start the next track — **${upcomingCount}** still queued. Try \`/skip\` again in a moment.`,
      );
    } else {
      await ctx.reply(`Skipped \`${skipped.title}\`. Queue is empty.`);
    }
  },
};
