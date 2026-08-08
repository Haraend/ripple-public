import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../../core/types.js';

export const pingCommand: Command = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
  tier: 'everyone',
  guildOnly: false,
  async execute(ctx) {
    const started = Date.now();
    await ctx.defer(true);
    const roundTrip = Date.now() - started;
    const ws = ctx.client.ws.ping;
    await ctx.editReply(`Pong. Round-trip ${roundTrip}ms · websocket ${ws}ms.`);
  },
};
