import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../../core/types.js';
import { getQueueSnapshot } from '../player.js';
import {
  bindPanelMessage,
  buildNowPlayingPayload,
  preparePanelRebind,
  rememberPanelChannel,
  upsertNowPlayingPanel,
} from '../now-playing-panel.js';

export const nowPlayingCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the currently playing track with controls'),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['nowplaying', 'np'],
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }
    const snap = getQueueSnapshot(ctx.guild.id);
    if (snap.current === null) {
      await ctx.reply('Nothing is playing right now.');
      return;
    }

    const payload = buildNowPlayingPayload(ctx.guild.id);
    if (payload === null) {
      await ctx.reply(`Now playing: **${snap.current.title}** (loop: ${snap.loop})`);
      return;
    }

    if (ctx.rawInteraction) {
      const channelId = ctx.channel?.id ?? ctx.rawInteraction.channelId;
      await preparePanelRebind(ctx.guild.id, ctx.client, channelId);
      await ctx.reply({
        embeds: payload.embeds,
        components: payload.components,
      });
      const reply = await ctx.rawInteraction.fetchReply();
      bindPanelMessage(ctx.guild.id, reply.channelId, reply.id);
      return;
    }

    if (ctx.channel) {
      rememberPanelChannel(ctx.guild.id, ctx.channel.id);
    }
    await upsertNowPlayingPanel(ctx.guild.id, ctx.client);
    await ctx.reply(`Now playing: **${snap.current.title}** (loop: ${snap.loop})`);
  },
};
