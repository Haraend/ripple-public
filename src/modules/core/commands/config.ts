import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';

export const configCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription("View or update this server's Ripple settings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('show').setDescription('Show current guild settings'))
    .addSubcommand((sub) =>
      sub
        .setName('dj-mode')
        .setDescription('Enable or disable DJ role gating for music controls')
        .addBooleanOption((option) =>
          option.setName('enabled').setDescription('Whether DJ mode is enabled').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('dj-role')
        .setDescription('Set the DJ role (or clear it)')
        .addRoleOption((option) =>
          option.setName('role').setDescription('DJ role').setRequired(false),
        )
        .addBooleanOption((option) =>
          option.setName('clear').setDescription('Clear the DJ role').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('music')
        .setDescription('Enable or disable music commands in this server')
        .addBooleanOption((option) =>
          option.setName('enabled').setDescription('Whether music is enabled').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('volume')
        .setDescription('Set the default playback volume (0-200)')
        .addIntegerOption((option) =>
          option
            .setName('value')
            .setDescription('Default volume percent')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(200),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('max-queue')
        .setDescription('Set max upcoming tracks for this server (capped by host env)')
        .addIntegerOption((option) =>
          option
            .setName('value')
            .setDescription('Max queue size')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(500),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('apex-channel')
        .setDescription('Set or clear the Apex announcement channel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Text channel for Apex events')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option.setName('clear').setDescription('Clear the Apex channel').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('music-channel')
        .setDescription('Set or clear the now-playing control panel channel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Text channel for the music control panel')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        )
        .addBooleanOption((option) =>
          option.setName('clear').setDescription('Clear the music channel').setRequired(false),
        ),
    ),
  tier: 'admin',
  guildOnly: true,
  defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }

    const interaction = ctx.rawInteraction;
    const sub = interaction?.options.getSubcommand(true) ?? 'show';
    const repo = ctx.client.services.guildSettings;
    const hostMaxQueue = ctx.client.services.env.MUSIC_MAX_QUEUE_SIZE;

    if (sub === 'show') {
      const settings = repo.get(ctx.guild.id);
      await ctx.reply({
        ephemeral: true,
        content: [
          `**Settings for ${ctx.guild.name}**`,
          `Music enabled: \`${settings.musicEnabled}\``,
          `DJ mode: \`${settings.djModeEnabled}\``,
          `DJ role: ${settings.djRoleId ? `<@&${settings.djRoleId}>` : '`none`'}`,
          `Default volume: \`${settings.defaultVolume}\``,
          `Max queue size: \`${settings.maxQueueSize}\` (host cap \`${hostMaxQueue}\`)`,
          `Music channel: ${settings.musicChannelId ? `<#${settings.musicChannelId}>` : '`none (sticky)`'}`,
          `Apex channel: ${settings.apexChannelId ? `<#${settings.apexChannelId}>` : '`none`'}`,
        ].join('\n'),
      });
      return;
    }

    if (sub === 'dj-mode') {
      const enabled = ctx.options.getBoolean('enabled', true) ?? false;
      repo.update(ctx.guild.id, { djModeEnabled: enabled });
      await ctx.reply({
        ephemeral: true,
        content: `DJ mode is now **${enabled ? 'enabled' : 'disabled'}**.`,
      });
      return;
    }

    if (sub === 'dj-role') {
      const clear = ctx.options.getBoolean('clear') ?? false;
      if (clear) {
        repo.update(ctx.guild.id, { djRoleId: null });
        await ctx.reply({ ephemeral: true, content: 'DJ role cleared.' });
        return;
      }
      const role = ctx.options.getRole('role');
      if (!role) {
        await ctx.reply({
          ephemeral: true,
          content: 'Provide a role, or set `clear` to true.',
        });
        return;
      }
      repo.update(ctx.guild.id, { djRoleId: role.id });
      await ctx.reply({ ephemeral: true, content: `DJ role set to **${role.name}**.` });
      return;
    }

    if (sub === 'music') {
      const enabled = ctx.options.getBoolean('enabled', true) ?? false;
      repo.update(ctx.guild.id, { musicEnabled: enabled });
      await ctx.reply({
        ephemeral: true,
        content: `Music is now **${enabled ? 'enabled' : 'disabled'}**.`,
      });
      return;
    }

    if (sub === 'volume') {
      const value = ctx.options.getInteger('value', true);
      if (value === null) {
        return;
      }
      repo.update(ctx.guild.id, { defaultVolume: value });
      await ctx.reply({ ephemeral: true, content: `Default volume set to **${value}**.` });
      return;
    }

    if (sub === 'max-queue') {
      const value = ctx.options.getInteger('value', true);
      if (value === null) {
        return;
      }
      if (value > hostMaxQueue) {
        throw new UserFacingError(
          `Max queue cannot exceed the host cap of **${hostMaxQueue}** (MUSIC_MAX_QUEUE_SIZE).`,
        );
      }
      repo.update(ctx.guild.id, { maxQueueSize: value });
      await ctx.reply({
        ephemeral: true,
        content: `Max queue size set to **${value}** (host cap **${hostMaxQueue}**).`,
      });
      return;
    }

    if (sub === 'apex-channel') {
      const clear = ctx.options.getBoolean('clear') ?? false;
      if (clear) {
        repo.update(ctx.guild.id, { apexChannelId: null });
        await ctx.reply({ ephemeral: true, content: 'Apex channel cleared.' });
        return;
      }
      const channel = ctx.options.getChannel('channel');
      if (!channel) {
        await ctx.reply({
          ephemeral: true,
          content: 'Provide a channel, or set `clear` to true.',
        });
        return;
      }
      repo.update(ctx.guild.id, { apexChannelId: channel.id });
      await ctx.reply({
        ephemeral: true,
        content: `Apex channel set to <#${channel.id}>.`,
      });
      return;
    }

    if (sub === 'music-channel') {
      const clear = ctx.options.getBoolean('clear') ?? false;
      if (clear) {
        repo.update(ctx.guild.id, { musicChannelId: null });
        await ctx.reply({
          ephemeral: true,
          content: 'Music channel cleared. The panel will stick to the first /play channel.',
        });
        return;
      }
      const channel = ctx.options.getChannel('channel');
      if (!channel) {
        await ctx.reply({
          ephemeral: true,
          content: 'Provide a channel, or set `clear` to true.',
        });
        return;
      }
      repo.update(ctx.guild.id, { musicChannelId: channel.id });
      await ctx.reply({
        ephemeral: true,
        content: `Music control panel channel set to <#${channel.id}>.`,
      });
    }
  },
};
