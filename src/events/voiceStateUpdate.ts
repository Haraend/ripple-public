import type { Event } from '../core/types.js';
import {
  cancelEmptyChannelAutoleave,
  scheduleEmptyChannelAutoleave,
} from '../modules/music/autoleave.js';
import { getSession } from '../modules/music/session-manager.js';

function channelHasHumans(channel: {
  members: { some: (fn: (m: { user: { bot: boolean } }) => boolean) => boolean };
}): boolean {
  return channel.members.some((member) => !member.user.bot);
}

/**
 * Empty-channel autoleave: when the bot is alone in its voice channel, start the timer.
 */
export const voiceStateUpdateEvent: Event<'voiceStateUpdate'> = {
  name: 'voiceStateUpdate',
  execute(client, oldState, newState) {
    const guildId = newState.guild.id;
    const session = getSession(guildId);
    if (!session) {
      return;
    }

    const channel =
      newState.guild.channels.cache.get(session.channelId) ??
      oldState.guild.channels.cache.get(session.channelId);
    if (!channel || !channel.isVoiceBased()) {
      return;
    }

    if (channelHasHumans(channel)) {
      cancelEmptyChannelAutoleave(guildId);
      return;
    }

    scheduleEmptyChannelAutoleave(
      guildId,
      client.services.env.MUSIC_EMPTY_CHANNEL_TIMEOUT_MS,
    );
  },
};
