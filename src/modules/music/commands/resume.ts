import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { getQueueSnapshot } from '../queue.js';
import { isPaused, resumePlayback } from '../session-manager.js';

export const resumeCommand: Command = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume paused playback'),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['resume', 'unpause'],
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }
    if (getQueueSnapshot(ctx.guild.id).current === null) {
      throw new UserFacingError('Nothing is playing.');
    }
    if (!isPaused(ctx.guild.id)) {
      throw new UserFacingError('Playback is not paused.');
    }
    resumePlayback(ctx.guild.id);
    await ctx.reply('Resumed.');
  },
};
