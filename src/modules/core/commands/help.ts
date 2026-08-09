import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../../core/types.js';

export const helpCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('List available commands for this bot'),
  tier: 'everyone',
  guildOnly: false,
  async execute(ctx) {
    const lines = [...ctx.client.commands.values()]
      .map((command) => {
        const description =
          'description' in command.data && typeof command.data.description === 'string'
            ? command.data.description
            : '';
        return `\`/${command.data.name}\` — ${description}`;
      })
      .sort((a, b) => a.localeCompare(b));

    await ctx.reply({
      content: ['**Ripple commands**', ...lines].join('\n'),
      ephemeral: true,
    });
  },
};
