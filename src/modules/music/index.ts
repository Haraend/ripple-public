import type { Module } from '../../core/types.js';
import { clearCommand } from './commands/clear.js';
import { joinCommand } from './commands/join.js';
import { leaveCommand } from './commands/leave.js';
import { loopCommand } from './commands/loop.js';
import { nowPlayingCommand } from './commands/nowplaying.js';
import { playCommand } from './commands/play.js';
import { queueCommand } from './commands/queue.js';
import { removeCommand } from './commands/remove.js';
import { skipCommand } from './commands/skip.js';
import { stopCommand } from './commands/stop.js';
import { initQueueBridge } from './queue.js';
import { killYtDlpChildren } from './resolvers/ytdlp.js';
import { shutdownMusicSessions } from './session-manager.js';

initQueueBridge();

export const musicModule: Module = {
  name: 'music',
  enabled: true,
  commands: [
    joinCommand,
    leaveCommand,
    playCommand,
    skipCommand,
    stopCommand,
    clearCommand,
    removeCommand,
    loopCommand,
    queueCommand,
    nowPlayingCommand,
  ],
  async shutdown() {
    killYtDlpChildren();
    await shutdownMusicSessions();
  },
};
