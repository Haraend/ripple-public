import type { Module } from '../../core/types.js';
import { clearEveryAutoleave, initAutoleave } from './autoleave.js';
import { clearCommand } from './commands/clear.js';
import { joinCommand } from './commands/join.js';
import { leaveCommand } from './commands/leave.js';
import { loopCommand } from './commands/loop.js';
import { nowPlayingCommand } from './commands/nowplaying.js';
import { pauseCommand } from './commands/pause.js';
import { playCommand } from './commands/play.js';
import { queueCommand } from './commands/queue.js';
import { removeCommand } from './commands/remove.js';
import { resumeCommand } from './commands/resume.js';
import { seekCommand } from './commands/seek.js';
import { skipCommand } from './commands/skip.js';
import { stopCommand } from './commands/stop.js';
import { volumeCommand } from './commands/volume.js';
import { registerMusicComponentHandler } from './components.js';
import { schedulePanelClear, schedulePanelForget, schedulePanelUpsert } from './now-playing-panel.js';
import { destroyAllPlayers, initQueueBridge, setPanelNotifyHandler } from './player.js';
import { startFfmpegReaper, stopFfmpegReaper } from './reaper.js';
import { killYtDlpChildren } from './resolvers/ytdlp.js';
import { getSession, leaveChannel, shutdownMusicSessions } from './session-manager.js';

initQueueBridge();
registerMusicComponentHandler();

export const musicModule: Module = {
  name: 'music',
  enabled: true,
  commands: [
    joinCommand,
    leaveCommand,
    playCommand,
    pauseCommand,
    resumeCommand,
    skipCommand,
    stopCommand,
    clearCommand,
    removeCommand,
    loopCommand,
    queueCommand,
    nowPlayingCommand,
    volumeCommand,
    seekCommand,
  ],
  async init(client) {
    setPanelNotifyHandler((guildId, event) => {
      if (event === 'forget') {
        schedulePanelForget(guildId, client);
        return;
      }
      if (event === 'clear') {
        schedulePanelClear(guildId, client);
        return;
      }
      schedulePanelUpsert(guildId, client, { immediate: true });
    });

    initAutoleave(
      (guildId) => {
        void leaveChannel(guildId);
      },
      (guildId) => {
        const session = getSession(guildId);
        if (!session) {
          return true;
        }
        const guild = client.guilds.cache.get(guildId);
        const channel = guild?.channels.cache.get(session.channelId);
        if (!channel || !channel.isVoiceBased()) {
          return true;
        }
        return !channel.members.some((member) => !member.user.bot);
      },
    );

    startFfmpegReaper(client.services.logger);
  },
  async shutdown() {
    stopFfmpegReaper();
    clearEveryAutoleave();
    killYtDlpChildren();
    destroyAllPlayers();
    await shutdownMusicSessions();
  },
};
