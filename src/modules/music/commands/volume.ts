import { SlashCommandBuilder } from 'discord.js';
import { UserFacingError } from '../../../core/errors.js';
import type { Command } from '../../../core/types.js';
import { getQueueSnapshot, restartCurrentAt } from '../queue.js';
import { getPlaybackPositionMs, getSession, setSessionVolume } from '../session-manager.js';

export const volumeCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set playback volume (0–200%). Mid-track changes restart FFmpeg.')
    .addIntegerOption((option) =>
      option
        .setName('level')
        .setDescription('Volume percent (100 = normal, max 200)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(200),
    ),
  tier: 'dj',
  guildOnly: true,
  prefixAliases: ['volume', 'vol'],
  async execute(ctx) {
    if (!ctx.guild) {
      return;
    }
    const level = ctx.options.getInteger('level', true);
    if (level === null || level < 0 || level > 200) {
      throw new UserFacingError('Volume must be between 0 and 200.');
    }

    setSessionVolume(ctx.guild.id, level);

    const snap = getQueueSnapshot(ctx.guild.id);
    const session = getSession(ctx.guild.id);
    if (snap.current === null || !session || !session.current) {
      await ctx.reply(`Volume set to **${level}%** (applies to the next track).`);
      return;
    }

    const positionMs = getPlaybackPositionMs(ctx.guild.id);
    const { mode } = await restartCurrentAt(ctx.guild.id, positionMs);
    const note =
      level === 100
        ? mode === 'copy'
          ? ' (Opus copy when possible)'
          : ''
        : ' (transcode — volume ≠ 100)';
    await ctx.reply(`Volume set to **${level}%**${note}. Restarted at ${formatMs(positionMs)}.`);
  },
};

function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
