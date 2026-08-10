import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { enqueueTrack, getQueueSnapshot } from '../queue.js';
import { classifyQuery, resolveQuery } from '../resolvers/index.js';
import { rememberPanelChannel, schedulePanelUpsert } from '../now-playing-panel.js';
import {
  ensureVoiceForMember,
  assertVoiceReady,
  isPlaybackActive,
  setSessionVolume,
} from '../session-manager.js';
import { acquireResolveSlot, releaseResolveSlot } from '../throttle.js';

export const playCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play or queue a song name, YouTube/SoundCloud/Spotify track, or direct URL')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('Song name or YouTube / SoundCloud / Spotify / direct http(s) URL')
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

    const raw = ctx.options.getString('query', true) ?? ctx.options.getRest() ?? '';
    const query = raw.trim();

    await ensureVoiceForMember(ctx.member, ctx.logger);

    // Only apply guild default volume when starting a fresh idle session — never
    // overwrite a user `/volume` while something is already playing/queued.
    const idle =
      !isPlaybackActive(ctx.guild.id) && getQueueSnapshot(ctx.guild.id).current === null;
    if (idle) {
      setSessionVolume(ctx.guild.id, settings.defaultVolume);
    }

    if (ctx.channel) {
      rememberPanelChannel(ctx.guild.id, ctx.channel.id);
    }

    const env = ctx.client.services.env;
    const resolveCtx = {
      env,
      trackCache: ctx.client.services.trackCache,
      logger: ctx.logger,
    };
    const kind = classifyQuery(query, resolveCtx);

    acquireResolveSlot(ctx.guild.id, ctx.user.id, env);
    try {
      const track = await resolveQuery(query, resolveCtx);

      // Voice may have dropped during a long resolve — rejoin once under the join mutex.
      if (!assertVoiceReady(ctx.guild.id)) {
        await ensureVoiceForMember(ctx.member, ctx.logger);
      }

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
        ctx.client.services.trackCache,
      );

      const searchHint = kind === 'search' ? ' (search)' : '';
      if (result.started) {
        await ctx.editReply(`Playing \`${track.title}\`${searchHint}.`);
      } else if (result.waitingForCapacity) {
        await ctx.editReply(
          `Queued \`${track.title}\`${searchHint} — host is at stream capacity; playback will start when a slot frees.`,
        );
      } else {
        await ctx.editReply(
          `Queued \`${track.title}\`${searchHint} at position **#${result.position}**.`,
        );
      }
      schedulePanelUpsert(ctx.guild.id, ctx.client, { immediate: true });
    } finally {
      releaseResolveSlot(ctx.guild.id);
    }
  },
};
