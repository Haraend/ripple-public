import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Interaction,
} from 'discord.js';
import type { RippleClient } from '../client.js';
import { handleChatInputCommand } from './commands.js';

type ComponentHandler = (client: RippleClient, interaction: ButtonInteraction) => Promise<void>;

const componentHandlers = new Map<string, ComponentHandler>();

export function registerComponentHandler(namespace: string, handler: ComponentHandler): void {
  componentHandlers.set(namespace, handler);
}

export async function handleInteraction(
  client: RippleClient,
  interaction: Interaction,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await handleChatInputCommand(client, interaction as ChatInputCommandInteraction);
    return;
  }

  if (interaction.isAutocomplete()) {
    await handleAutocomplete(client, interaction);
    return;
  }

  if (interaction.isButton()) {
    const namespace = interaction.customId.split(':')[0];
    if (!namespace) {
      return;
    }
    const handler = componentHandlers.get(namespace);
    if (!handler) {
      return;
    }
    try {
      await handler(client, interaction);
    } catch (error) {
      client.services.logger.error(
        { err: error, customId: interaction.customId },
        'component handler failed',
      );
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'Something went wrong with that button.',
          ephemeral: true,
        });
      }
    }
  }
}

async function handleAutocomplete(
  client: RippleClient,
  interaction: AutocompleteInteraction,
): Promise<void> {
  const command = client.commands.get(interaction.commandName);
  if (!command?.autocomplete) {
    await interaction.respond([]);
    return;
  }
  try {
    await command.autocomplete(interaction);
  } catch (error) {
    client.services.logger.error(
      { err: error, command: interaction.commandName },
      'autocomplete failed',
    );
    await interaction.respond([]);
  }
}
