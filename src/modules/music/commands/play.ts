import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { enqueueTrack } from '../queue.js';
import { resolveQuery } from '../resolvers/index.js';
import { ensureVoiceForMember, setSessionVolume } from '../session-manager.js';
import { acquireResolveSlot, releaseResolveSlot } from '../throttle.js';

export const playCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play or queue YouTube, SoundCloud, Spotify track, or a direct URL')
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

    await ensureVoiceForMember(ctx.member, ctx.logger);
    setSessionVolume(ctx.guild.id, settings.defaultVolume);

    const env = ctx.client.services.env;
    acquireResolveSlot(ctx.guild.id, ctx.user.id, env);
    try {
      const track = await resolveQuery(url, {
        env,
        trackCache: ctx.client.services.trackCache,
        logger: ctx.logger,
      });

      const maxQueue = Math.min(env.MUSIC_MAX_QUEUE_SIZE, settings.maxQueueSize);
      const result = await enqueueTrack(
        ctx.guild.id,
        {
          ...track,
          requestedBy: ctx.user.id,
        },
        env,
        ctx.logger,
        maxQueue,
      );

      if (result.started) {
        await ctx.editReply(
          `Playing \`${track.title}\` (FFmpeg **${result.mode ?? 'transcode'}** mode, volume ${settings.defaultVolume}).`,
        );
      } else {
        await ctx.editReply(
          `Queued \`${track.title}\` at position **#${result.position}**.`,
        );
      }
    } finally {
      releaseResolveSlot(ctx.guild.id);
    }
  },
};
