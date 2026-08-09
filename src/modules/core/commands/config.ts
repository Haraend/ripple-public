import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
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
          `Max queue size: \`${settings.maxQueueSize}\``,
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
    }
  },
};
