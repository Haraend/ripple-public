import { MessageFlags } from 'discord.js';
import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  type TextBasedChannel,
  type User,
} from 'discord.js';
import type { Logger } from '../lib/logger.js';
import type { RippleClient } from './client.js';
import { UserFacingError } from './errors.js';
import type {
  CommandContext,
  CommandOptionsReader,
  CommandReplyPayload,
  PermissionTier,
} from './types.js';

function normalizePayload(payload: CommandReplyPayload | string): CommandReplyPayload {
  return typeof payload === 'string' ? { content: payload } : payload;
}

class InteractionOptionsReader implements CommandOptionsReader {
  constructor(private readonly interaction: ChatInputCommandInteraction) {}

  getString(name: string, required = false): string | null {
    return this.interaction.options.getString(name, required);
  }

  getInteger(name: string, required = false): number | null {
    return this.interaction.options.getInteger(name, required);
  }

  getBoolean(name: string, required = false): boolean | null {
    return this.interaction.options.getBoolean(name, required);
  }

  getUser(name: string, required = false): User | null {
    return this.interaction.options.getUser(name, required);
  }

  getChannel(name: string, required = false): TextBasedChannel | null {
    const channel = this.interaction.options.getChannel(name, required);
    if (!channel) {
      return null;
    }
    if (
      'isTextBased' in channel &&
      typeof channel.isTextBased === 'function' &&
      channel.isTextBased()
    ) {
      return channel as TextBasedChannel;
    }
    return null;
  }

  getRole(name: string, required = false): { id: string; name: string } | null {
    const role = this.interaction.options.getRole(name, required);
    return role ? { id: role.id, name: role.name } : null;
  }

  getAttachment(
    name: string,
    required = false,
  ): { url: string; name: string; contentType: string | null } | null {
    const attachment = this.interaction.options.getAttachment(name, required);
    return attachment
      ? { url: attachment.url, name: attachment.name, contentType: attachment.contentType }
      : null;
  }

  getRest(): string | null {
    return null;
  }
}

class MessageOptionsReader implements CommandOptionsReader {
  private readonly rest: string;

  constructor(rest: string) {
    this.rest = rest.trim();
  }

  getString(_name: string, required = false): string | null {
    if (this.rest.length === 0) {
      if (required) {
        throw new UserFacingError('Missing required argument.');
      }
      return null;
    }
    return this.rest;
  }

  getInteger(_name: string, required = false): number | null {
    if (this.rest.length === 0) {
      if (required) {
        throw new UserFacingError('Missing required argument.');
      }
      return null;
    }
    const value = Number.parseInt(this.rest, 10);
    if (Number.isNaN(value)) {
      throw new UserFacingError('Expected an integer argument.');
    }
    return value;
  }

  getBoolean(_name: string, required = false): boolean | null {
    if (this.rest.length === 0) {
      if (required) {
        throw new UserFacingError('Missing required argument.');
      }
      return null;
    }
    const normalized = this.rest.toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
    throw new UserFacingError('Expected a boolean argument.');
  }

  getUser(): User | null {
    return null;
  }

  getChannel(): TextBasedChannel | null {
    return null;
  }

  getRole(): { id: string; name: string } | null {
    return null;
  }

  getAttachment(): { url: string; name: string; contentType: string | null } | null {
    return null;
  }

  getRest(): string | null {
    return this.rest.length > 0 ? this.rest : null;
  }
}

export function createInteractionContext(
  client: RippleClient,
  interaction: ChatInputCommandInteraction,
  logger: Logger,
): CommandContext {
  let deferred = false;

  return {
    client,
    guild: interaction.guild,
    member: interaction.member instanceof Object && 'guild' in interaction.member
      ? (interaction.member as GuildMember)
      : null,
    channel: interaction.channel,
    user: interaction.user,
    options: new InteractionOptionsReader(interaction),
    logger,
    source: 'interaction',
    rawInteraction: interaction,
    rawMessage: null,
    async defer(ephemeral = true) {
      if (deferred || interaction.deferred || interaction.replied) {
        return;
      }
      await interaction.deferReply(
        ephemeral ? { flags: MessageFlags.Ephemeral as const } : {},
      );
      deferred = true;
    },
    async reply(payload) {
      const body = normalizePayload(payload);
      const ephemeral = body.ephemeral ?? false;
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: body.content,
          components: body.components as never,
          embeds: body.embeds as never,
          allowedMentions: { parse: [] },
          ...(ephemeral ? { flags: MessageFlags.Ephemeral as const } : {}),
        });
      } else {
        await interaction.reply({
          content: body.content,
          components: body.components as never,
          embeds: body.embeds as never,
          allowedMentions: { parse: [] },
          ...(ephemeral ? { flags: MessageFlags.Ephemeral as const } : {}),
        });
      }
    },
    async editReply(payload) {
      const body = normalizePayload(payload);
      if (!interaction.deferred && !interaction.replied) {
        const ephemeral = body.ephemeral ?? false;
        await interaction.reply({
          content: body.content,
          components: body.components as never,
          embeds: body.embeds as never,
          allowedMentions: { parse: [] },
          ...(ephemeral ? { flags: MessageFlags.Ephemeral as const } : {}),
        });
        return;
      }
      await interaction.editReply({
        content: body.content,
        components: body.components as never,
        embeds: body.embeds as never,
        allowedMentions: { parse: [] },
      });
    },
  };
}

export function createMessageContext(
  client: RippleClient,
  message: Message,
  rest: string,
  logger: Logger,
): CommandContext {
  let replyMessage: Message | null = null;

  return {
    client,
    guild: message.guild,
    member: message.member,
    channel: message.channel.isTextBased() ? message.channel : null,
    user: message.author,
    options: new MessageOptionsReader(rest),
    logger,
    source: 'message',
    rawInteraction: null,
    rawMessage: message,
    async defer() {
      // Prefix commands have no defer; no-op.
    },
    async reply(payload) {
      const body = normalizePayload(payload);
      replyMessage = await message.reply({
        content: body.content,
        components: body.components as never,
        embeds: body.embeds as never,
        allowedMentions: { parse: [], repliedUser: false },
      });
    },
    async editReply(payload) {
      const body = normalizePayload(payload);
      if (replyMessage) {
        await replyMessage.edit({
          content: body.content,
          components: body.components as never,
          embeds: body.embeds as never,
          allowedMentions: { parse: [] },
        });
        return;
      }
      replyMessage = await message.reply({
        content: body.content,
        components: body.components as never,
        embeds: body.embeds as never,
        allowedMentions: { parse: [], repliedUser: false },
      });
    },
  };
}

export async function assertPermissionTier(
  client: RippleClient,
  ctx: CommandContext,
  tier: PermissionTier,
): Promise<void> {
  if (tier === 'everyone') {
    return;
  }

  if (tier === 'owner') {
    if (!client.services.env.OWNER_IDS.includes(ctx.user.id)) {
      throw new UserFacingError('This command is restricted to the bot owner.');
    }
    return;
  }

  if (!ctx.guild || !ctx.member) {
    throw new UserFacingError('This command can only be used in a server.');
  }

  if (tier === 'admin') {
    if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      throw new UserFacingError('You need the Manage Server permission to use this command.');
    }
    return;
  }

  // DJ tier
  const settings = client.services.guildSettings.get(ctx.guild.id);
  if (!settings.djModeEnabled) {
    return;
  }
  if (!settings.djRoleId) {
    throw new UserFacingError('DJ mode is enabled but no DJ role is configured. Ask an admin.');
  }
  if (!ctx.member.roles.cache.has(settings.djRoleId)) {
    throw new UserFacingError('You need the DJ role to use this command.');
  }
}
