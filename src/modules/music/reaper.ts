import { reapOrphanFfmpegChildren } from './session-manager.js';
import type { Logger } from '../../lib/logger.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let loggerRef: Logger | null = null;

export function startFfmpegReaper(
  logger: Logger,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): void {
  stopFfmpegReaper();
  loggerRef = logger;
  timer = setInterval(() => {
    const { killed, pruned } = reapOrphanFfmpegChildren();
    if (killed > 0 || pruned > 0) {
      loggerRef?.info({ killed, pruned }, 'reaped orphan FFmpeg children');
    } else {
      loggerRef?.debug('FFmpeg reaper tick — nothing to reap');
    }
  }, intervalMs);
  timer.unref();
}

export function stopFfmpegReaper(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  loggerRef = null;
}
