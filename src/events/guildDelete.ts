import type { Event } from '../core/types.js';

export const guildDeleteEvent: Event<'guildDelete'> = {
  name: 'guildDelete',
  execute(client, guild) {
    client.services.guildSettings.delete(guild.id);
    client.services.logger.info({ guildId: guild.id }, 'guild left; settings removed');
  },
};
