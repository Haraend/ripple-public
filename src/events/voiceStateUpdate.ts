import type { Event } from '../core/types.js';
import {
  cancelEmptyChannelAutoleave,
  cancelIdleQueueAutoleave,
  scheduleEmptyChannelAutoleave,
  scheduleIdleQueueAutoleave,
} from '../modules/music/autoleave.js';
import { getQueueSnapshot } from '../modules/music/queue.js';
import { getSession } from '../modules/music/session-manager.js';

function channelHasHumans(channel: {
  members: { some: (fn: (m: { user: { bot: boolean } }) => boolean) => boolean };
}): boolean {
  return channel.members.some((member) => !member.user.bot);
}

/**
 * Empty-channel + idle-queue autoleave hooks on voice membership changes.
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
      cancelIdleQueueAutoleave(guildId);
      return;
    }

    const env = client.services.env;
    scheduleEmptyChannelAutoleave(guildId, env.MUSIC_EMPTY_CHANNEL_TIMEOUT_MS);

    const snap = getQueueSnapshot(guildId);
    if (snap.current === null && snap.upcoming.length === 0) {
      scheduleIdleQueueAutoleave(guildId, env.MUSIC_IDLE_TIMEOUT_MS);
    }
  },
};
