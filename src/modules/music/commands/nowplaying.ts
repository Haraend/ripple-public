import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../../core/types.js';
import { getQueueSnapshot } from '../queue.js';

export const nowPlayingCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing track'),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['nowplaying', 'np'],
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }
    const snap = getQueueSnapshot(ctx.guild.id);
    if (snap.current === null) {
      await ctx.reply('Nothing is playing right now.');
      return;
    }
    const link =
      snap.current.webpageUrl.length > 0 ? `\n${snap.current.webpageUrl}` : '';
    await ctx.reply(
      `Now playing: **${snap.current.title}** (loop: ${snap.loop})${link}`,
    );
  },
};
