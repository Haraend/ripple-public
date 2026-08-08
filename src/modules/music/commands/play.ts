import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { playDirectUrl, setSessionVolume } from '../session-manager.js';
import type { TrackLike } from '../stream.js';

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

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

    const settings = ctx.client.services.guildSettings.get(ctx.guild.id);
    if (!settings.musicEnabled) {
      throw new UserFacingError('Music is disabled in this server.');
    }

    const raw =
      ctx.options.getString('url', true) ??
      ctx.options.getRest() ??
      '';
    const url = raw.trim();
    if (!isHttpUrl(url)) {
      throw new UserFacingError(
        'Phase 1 only accepts a direct http(s) audio URL. YouTube arrives in Phase 2.',
      );
    }

    if (!ctx.member.voice.channel) {
      throw new UserFacingError('Join a voice channel first (or use `/join`).');
    }

    // Ensure we are in the member's channel if not already.
    const { joinChannel, getSession } = await import('../session-manager.js');
    if (!getSession(ctx.guild.id)) {
      await joinChannel(ctx.member.voice.channel, ctx.logger);
    }

    setSessionVolume(ctx.guild.id, settings.defaultVolume);

    // Direct URLs are usually not raw opus — default to transcode-safe 'other'.
    // Pure .opus/.ogg URLs can use copy when volume is 100.
    const lower = url.toLowerCase();
    const codec = lower.endsWith('.opus') || lower.endsWith('.ogg') ? 'opus' : 'other';

    const track: TrackLike = {
      url,
      title: url.split('/').pop() ?? 'direct-url',
      codec,
    };

    await ctx.defer(false);
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
