import type { Module } from '../../core/types.js';
import { joinCommand } from './commands/join.js';
import { leaveCommand } from './commands/leave.js';
import { playCommand } from './commands/play.js';
import { killYtDlpChildren } from './resolvers/ytdlp.js';
import { shutdownMusicSessions } from './session-manager.js';

export const musicModule: Module = {
  name: 'music',
  enabled: true,
  commands: [joinCommand, leaveCommand, playCommand],
  async shutdown() {
    killYtDlpChildren();
    await shutdownMusicSessions();
  },
};
