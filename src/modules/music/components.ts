import type { ButtonInteraction, GuildMember } from 'discord.js';
import type { RippleClient } from '../../core/client.js';
import { assertPermissionTier } from '../../core/context.js';
import { UserFacingError } from '../../core/errors.js';
import { registerComponentHandler } from '../../core/handlers/components.js';
import type { CommandContext, CommandOptionsReader } from '../../core/types.js';
import {
  getPanelMessageId,
  parseMusicCustomId,
  schedulePanelClear,
  schedulePanelUpsert,
} from './now-playing-panel.js';
import {
  cycleLoopMode,
  previousTrack,
  skipTrack,
  stopQueue,
} from './player.js';
import {
  getSessionToken,
  pausePlayback,
  resumePlayback,
} from './session-manager.js';

const emptyOptions: CommandOptionsReader = {
  getString: () => null,
  getInteger: () => null,
  getBoolean: () => null,
  getUser: () => null,
  getChannel: () => null,
  getRole: () => null,
  getAttachment: () => null,
  getRest: () => null,
};

function buttonContext(
  client: RippleClient,
  interaction: ButtonInteraction,
): CommandContext {
  const member =
    interaction.member !== null &&
    typeof interaction.member === 'object' &&
    'guild' in interaction.member
      ? (interaction.member as GuildMember)
      : null;

  return {
    client,
    guild: interaction.guild,
    member,
    channel: interaction.channel,
    user: interaction.user,
    options: emptyOptions,
    logger: client.services.logger,
    source: 'interaction',
    rawInteraction: null,
    rawMessage: null,
    async defer() {
      return;
    },
    async reply() {
      return;
    },
    async editReply() {
      return;
    },
  };
}

async function replyEphemeral(interaction: ButtonInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, ephemeral: true });
    return;
  }
  await interaction.reply({ content, ephemeral: true });
}

async function deleteStalePanelMessage(interaction: ButtonInteraction): Promise<void> {
  try {
    if (interaction.message.deletable) {
      await interaction.message.delete();
    }
  } catch {
    // already gone / missing permissions
  }
}

/**
 * Ack the Discord button first, then run work. Exported for ordering tests.
 * @internal
 */
export async function deferThen<T>(
  deferUpdate: () => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  await deferUpdate();
  return work();
}

/**
 * Ack the button first, then run work. Exported for ordering tests.
 * @internal
 */
export async function runMusicButtonAction(
  action: 'prev' | 'pause' | 'resume' | 'skip' | 'loop' | 'stop',
  guildId: string,
  deferUpdate: () => Promise<void>,
  after: {
    onSkip: (next: Awaited<ReturnType<typeof skipTrack>>['next']) => void;
    onStop: () => void;
    onUpsert: () => void;
  },
): Promise<void> {
  await deferThen(deferUpdate, async () => {
    switch (action) {
      case 'prev':
        await previousTrack(guildId, { panel: 'upsert' });
        after.onUpsert();
        break;
      case 'pause':
        pausePlayback(guildId);
        after.onUpsert();
        break;
      case 'resume':
        resumePlayback(guildId);
        after.onUpsert();
        break;
      case 'skip': {
        const { next } = await skipTrack(guildId, { panel: 'upsert' });
        after.onSkip(next);
        break;
      }
      case 'loop':
        cycleLoopMode(guildId);
        after.onUpsert();
        break;
      case 'stop':
        await stopQueue(guildId);
        after.onStop();
        break;
      default:
        break;
    }
  });
}

async function handleMusicButton(
  client: RippleClient,
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseMusicCustomId(interaction.customId);
  if (parsed === null) {
    return;
  }

  const guildId = interaction.guildId;
  if (guildId === null || interaction.guild === null) {
    await replyEphemeral(interaction, 'Music controls only work in a server.');
    return;
  }

  const liveToken = getSessionToken(guildId);
  if (liveToken === null || liveToken !== parsed.token) {
    await replyEphemeral(
      interaction,
      'This control panel is outdated. Use the latest now-playing message.',
    );
    await deleteStalePanelMessage(interaction);
    return;
  }

  const liveMessageId = getPanelMessageId(guildId);
  if (liveMessageId !== null && interaction.message.id !== liveMessageId) {
    await replyEphemeral(
      interaction,
      'This control panel is outdated. Use the latest now-playing message.',
    );
    await deleteStalePanelMessage(interaction);
    return;
  }

  const ctx = buttonContext(client, interaction);
  try {
    await assertPermissionTier(client, ctx, 'dj');
  } catch (error) {
    if (error instanceof UserFacingError) {
      await replyEphemeral(interaction, error.message);
      return;
    }
    throw error;
  }

  try {
    await runMusicButtonAction(
      parsed.action,
      guildId,
      async () => {
        await interaction.deferUpdate();
      },
      {
        onSkip: (next) => {
          if (next === null) {
            schedulePanelClear(guildId, client);
          } else {
            schedulePanelUpsert(guildId, client, { immediate: true });
          }
        },
        onStop: () => {
          schedulePanelClear(guildId, client);
        },
        onUpsert: () => {
          schedulePanelUpsert(guildId, client, { immediate: true });
        },
      },
    );
  } catch (error) {
    if (error instanceof UserFacingError) {
      await replyEphemeral(interaction, error.message);
      if (getSessionToken(guildId) !== null) {
        schedulePanelUpsert(guildId, client);
      }
      return;
    }
    throw error;
  }
}

/** Register the `music:` button namespace once. */
export function registerMusicComponentHandler(): void {
  registerComponentHandler('music', handleMusicButton);
}
