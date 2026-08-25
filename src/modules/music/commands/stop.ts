import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../../core/types.js';
import { stopQueue } from '../queue.js';

export const stopCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and clear the queue'),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['stop'],
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }
    await stopQueue(ctx.guild.id);
    await ctx.reply('Stopped playback and cleared the queue.');
  },
};
