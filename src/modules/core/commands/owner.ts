import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../../core/types.js';

export const ownerCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('owner')
    .setDescription('Owner-only maintenance commands')
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show process and module status'),
    )
    .addSubcommand((sub) =>
      sub.setName('guilds').setDescription('List guild IDs this bot is in'),
    ),
  tier: 'owner',
  guildOnly: false,
  async execute(ctx) {
    const sub = ctx.rawInteraction?.options.getSubcommand(true) ?? 'status';

    if (sub === 'status') {
      const memory = process.memoryUsage();
      await ctx.reply({
        ephemeral: true,
        content: [
          '**Ripple owner status**',
          `Node: \`${process.version}\``,
          `Uptime: \`${Math.floor(process.uptime())}s\``,
          `RSS: \`${Math.round(memory.rss / 1024 / 1024)} MB\``,
          `Heap used: \`${Math.round(memory.heapUsed / 1024 / 1024)} MB\``,
          `Guilds: \`${ctx.client.guilds.cache.size}\``,
          `Modules: \`${[...ctx.client.modules.keys()].join(', ') || 'none'}\``,
          `Commands: \`${ctx.client.commands.size}\``,
        ].join('\n'),
      });
      return;
    }

    if (sub === 'guilds') {
      const lines = ctx.client.guilds.cache.map((guild) => `• ${guild.name} (\`${guild.id}\`)`);
      await ctx.reply({
        ephemeral: true,
        content: lines.length > 0 ? lines.join('\n') : 'Not in any guilds.',
      });
    }
  },
};
