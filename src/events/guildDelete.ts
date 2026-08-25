import type { Event } from '../core/types.js';
import { leaveChannel } from '../modules/music/session-manager.js';

export const guildDeleteEvent: Event<'guildDelete'> = {
  name: 'guildDelete',
  async execute(client, guild) {
    try {
      await leaveChannel(guild.id);
    } catch (error) {
      client.services.logger.warn(
        { err: error, guildId: guild.id },
        'guild left; music teardown failed',
      );
    }
    client.services.guildSettings.delete(guild.id);
    client.services.logger.info({ guildId: guild.id }, 'guild left; settings removed');
  },
};
