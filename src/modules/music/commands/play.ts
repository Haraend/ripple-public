import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { resolveQuery } from '../resolvers/index.js';
import { ensureVoiceForMember, playDirectUrl, setSessionVolume } from '../session-manager.js';

export const playCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play YouTube, SoundCloud, Spotify track (if configured), or a direct URL')
    .addStringOption((option) =>
      option
        .setName('url')
        .setDescription('YouTube / SoundCloud / Spotify track / direct http(s) audio URL')
        .setRequired(true),
    ),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['play', 'p'],
  async execute(ctx) {
    if (!ctx.guild || !ctx.member) {
      return;
    }

    await ctx.defer(false);

    const settings = ctx.client.services.guildSettings.get(ctx.guild.id);
    if (!settings.musicEnabled) {
      throw new UserFacingError('Music is disabled in this server.');
    }

    const raw = ctx.options.getString('url', true) ?? ctx.options.getRest() ?? '';
    const url = raw.trim();

    const track = await resolveQuery(url, {
      env: ctx.client.services.env,
      trackCache: ctx.client.services.trackCache,
      logger: ctx.logger,
    });

    await ensureVoiceForMember(ctx.member, ctx.logger);
    setSessionVolume(ctx.guild.id, settings.defaultVolume);

    const { mode } = await playDirectUrl(
      ctx.guild.id,
      track,
      ctx.client.services.env,
      ctx.logger,
    );
    await ctx.editReply(
      `Playing \`${track.title}\` (FFmpeg **${mode}** mode, volume ${settings.defaultVolume}).`,
    );
  },
};
