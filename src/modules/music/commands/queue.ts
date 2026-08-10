import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../../core/types.js';
import { getQueueSnapshot } from '../queue.js';

function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) {
    return '?:??';
  }
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const queueCommand: Command = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the music queue'),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['queue', 'q'],
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }
    const snap = getQueueSnapshot(ctx.guild.id);
    if (snap.current === null && snap.upcoming.length === 0) {
      await ctx.reply('The queue is empty.');
      return;
    }

    const lines: string[] = [`Loop: **${snap.loop}**`];
    if (snap.current) {
      lines.push(
        `Now: **${snap.current.title}** (${formatDuration(snap.current.durationMs)})`,
      );
    }
    if (snap.upcoming.length > 0) {
      lines.push('Up next:');
      const shown = snap.upcoming.slice(0, 15);
      for (let i = 0; i < shown.length; i += 1) {
        const track = shown[i];
        if (!track) {
          continue;
        }
        lines.push(
          `**${i + 1}.** ${track.title} (${formatDuration(track.durationMs)})`,
        );
      }
      if (snap.upcoming.length > shown.length) {
        lines.push(`…and ${snap.upcoming.length - shown.length} more`);
      }
    }
    await ctx.reply(lines.join('\n'));
  },
};
