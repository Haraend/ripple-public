import type { Event } from '../core/types.js';

export const clientReadyEvent: Event<'clientReady'> = {
  name: 'clientReady',
  once: true,
  execute(client) {
    client.services.logger.info(
      {
        user: client.user?.tag,
        guilds: client.guilds.cache.size,
        commands: client.commands.size,
      },
      'logged in',
    );
  },
};
