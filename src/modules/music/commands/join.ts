import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { joinChannel } from '../session-manager.js';

export const joinCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your current voice channel (smoke test)'),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['join'],
  async execute(ctx) {
    if (!ctx.guild || !ctx.member) {
      return;
    }

    const settings = ctx.client.services.guildSettings.get(ctx.guild.id);
    if (!settings.musicEnabled) {
      throw new UserFacingError('Music is disabled in this server. Ask an admin via `/config`.');
    }

    const channel = ctx.member.voice.channel;
    if (!channel) {
      throw new UserFacingError('Join a voice channel first.');
    }

    await joinChannel(channel, ctx.logger);
    await ctx.reply(`Joined **${channel.name}**.`);
  },
};
