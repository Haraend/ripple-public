import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { getQueueSnapshot, restartCurrentAt } from '../queue.js';

export const seekCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Seek to a position in the current track (seconds)')
    .addIntegerOption((option) =>
      option
        .setName('seconds')
        .setDescription('Position in seconds from the start')
        .setRequired(true)
        .setMinValue(0),
    ),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['seek'],
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }
    const seconds = ctx.options.getInteger('seconds', true);
    if (seconds === null || seconds < 0) {
      throw new UserFacingError('Seek position must be 0 or greater.');
    }

    const snap = getQueueSnapshot(ctx.guild.id);
    if (snap.current === null) {
      throw new UserFacingError('Nothing is playing.');
    }

    let seekMs = seconds * 1000;
    const durationMs = snap.current.durationMs;
    if (durationMs !== null && durationMs > 0) {
      if (seekMs >= durationMs) {
        throw new UserFacingError(
          `That is past the end of the track (${formatMs(durationMs)}).`,
        );
      }
      seekMs = Math.min(seekMs, Math.max(0, durationMs - 1000));
    }

    const expected = { title: snap.current.title, url: snap.current.url };
    const { mode, applied } = await restartCurrentAt(ctx.guild.id, seekMs, expected);
    if (!applied) {
      await ctx.reply('Track changed before seek could apply.');
      return;
    }
    await ctx.reply(
      `Seeked to **${formatMs(seekMs)}** (FFmpeg **${mode}**).`,
    );
  },
};

function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
