import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { ensureVoiceForMember } from '../session-manager.js';

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

    await ctx.defer(false);

    const settings = ctx.client.services.guildSettings.get(ctx.guild.id);
    if (!settings.musicEnabled) {
      throw new UserFacingError('Music is disabled in this server. Ask an admin via `/config`.');
    }

    const channel = ctx.member.voice.channel;
    if (!channel) {
      throw new UserFacingError('Join a voice channel first.');
    }

    await ensureVoiceForMember(ctx.member, ctx.logger);
    await ctx.editReply(`Joined **${channel.name}**.`);
  },
};
