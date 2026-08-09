import type { Event } from '../core/types.js';
import { handlePrefixMessage } from '../core/handlers/prefix.js';

export const messageCreateEvent: Event<'messageCreate'> = {
  name: 'messageCreate',
  async execute(client, message) {
    await handlePrefixMessage(client, message);
  },
};
