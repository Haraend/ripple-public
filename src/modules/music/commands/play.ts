import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { assertSafeMediaUrl } from '../url-safety.js';
import { ensureVoiceForMember, playDirectUrl, setSessionVolume } from '../session-manager.js';
import type { TrackLike } from '../stream.js';

/**
 * Phase 1 smoke: only direct HTTP(S) audio URLs.
 * Phase 2 replaces resolution with yt-dlp; this command stays the entrypoint.
 */
export const playCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a direct audio URL in the voice channel (smoke test)')
    .addStringOption((option) =>
      option
        .setName('url')
        .setDescription('Direct HTTP(S) audio URL (ogg/opus preferred)')
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

    await assertSafeMediaUrl(url);
    await ensureVoiceForMember(ctx.member, ctx.logger);

    setSessionVolume(ctx.guild.id, settings.defaultVolume);

    const lower = url.toLowerCase();
    const codec = lower.endsWith('.opus') || lower.endsWith('.ogg') ? 'opus' : 'other';

    const track: TrackLike = {
      url,
      title: url.split('/').pop() ?? 'direct-url',
      codec,
    };

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
