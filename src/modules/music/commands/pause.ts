import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { getQueueSnapshot } from '../queue.js';
import { rememberPanelChannel, schedulePanelUpsert } from '../now-playing-panel.js';
import { isPaused, pausePlayback } from '../session-manager.js';

export const pauseCommand: Command = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause the current track'),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['pause'],
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }
    if (getQueueSnapshot(ctx.guild.id).current === null) {
      throw new UserFacingError('Nothing is playing.');
    }
    if (isPaused(ctx.guild.id)) {
      throw new UserFacingError('Playback is already paused.');
    }
    pausePlayback(ctx.guild.id);
    if (ctx.channel) {
      rememberPanelChannel(ctx.guild.id, ctx.channel.id);
    }
    schedulePanelUpsert(ctx.guild.id, ctx.client, { immediate: true });
    await ctx.reply('Paused.');
  },
};
