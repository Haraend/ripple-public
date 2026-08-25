import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../../core/types.js';
import { leaveChannel } from '../session-manager.js';

export const leaveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the voice channel and stop playback'),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['leave', 'dc'],
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }
    const left = await leaveChannel(ctx.guild.id);
    await ctx.reply(left ? 'Left the voice channel.' : 'I was not in a voice channel.');
  },
};
