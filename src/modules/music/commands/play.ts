import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { resolveWithYtDlp, shouldUseYtDlp } from '../resolvers/ytdlp.js';
import { assertSafeMediaUrl } from '../url-safety.js';
import { ensureVoiceForMember, playDirectUrl, setSessionVolume } from '../session-manager.js';
import type { TrackLike } from '../stream.js';

export const playCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play YouTube, SoundCloud, or a direct audio URL')
    .addStringOption((option) =>
      option
        .setName('url')
        .setDescription('YouTube/SoundCloud URL or direct http(s) audio URL')
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

    let track: TrackLike;
    if (shouldUseYtDlp(url)) {
      track = await resolveWithYtDlp(url, ctx.client.services.env);
    } else {
      await assertSafeMediaUrl(url);
      const lower = url.toLowerCase();
      const codec = lower.endsWith('.opus') || lower.endsWith('.ogg') ? 'opus' : 'other';
      track = {
        url,
        title: url.split('/').pop() ?? 'direct-url',
        codec,
      };
    }

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
