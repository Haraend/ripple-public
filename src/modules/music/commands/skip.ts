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
    if (skipped === null) {
      if (next) {
        await ctx.reply(`Resumed queue. Now playing \`${next.title}\`.`);
      } else if (upcomingCount > 0) {
        await ctx.reply(
          `Tried to resume the queue — **${upcomingCount}** still queued but could not start. Try \`/skip\` again in a moment.`,
        );
      } else {
        await ctx.reply('Queue is empty.');
      }
      return;
    }
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
