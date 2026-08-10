import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { getQueueSnapshot, setLoopMode, type LoopMode } from '../queue.js';

function parseLoopMode(raw: string): LoopMode {
  if (raw === 'off' || raw === 'track' || raw === 'queue') {
    return raw;
  }
  throw new UserFacingError('Loop mode must be off, track, or queue.');
}

export const loopCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set or show loop mode (off / track / queue)')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Loop mode')
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Track', value: 'track' },
          { name: 'Queue', value: 'queue' },
        ),
    ),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['loop'],
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }
    const raw = ctx.options.getString('mode');
    if (raw === null) {
      const snap = getQueueSnapshot(ctx.guild.id);
      await ctx.reply(`Loop mode is **${snap.loop}**.`);
      return;
    }
    const applied = setLoopMode(ctx.guild.id, parseLoopMode(raw));
    await ctx.reply(`Loop mode set to **${applied}**.`);
  },
};
