import type { Event } from '../core/types.js';
import { handleInteraction } from '../core/handlers/components.js';

export const interactionCreateEvent: Event<'interactionCreate'> = {
  name: 'interactionCreate',
  async execute(client, interaction) {
    await handleInteraction(client, interaction);
  },
};
