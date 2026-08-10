/**
 * Thin facade over GuildPlayer for stable import paths.
 * Prefer importing from `./player.js` in new code.
 */
export {
  clearUpcoming,
  cycleLoopMode,
  destroyAllPlayers,
  enqueueTrack,
  getQueueSnapshot,
  handlePlayerIdle,
  initQueueBridge,
  onSessionDestroyed,
  previousTrack,
  removeUpcoming,
  resetQueueBridgeForTests,
  restartCurrentAt,
  setFreshUrlResolverForTests,
  setLoopMode,
  setPanelNotifyHandler,
  skipTrack,
  stopQueue,
  type LoopMode,
  type QueuedTrack,
  type QueueSnapshot,
} from './player.js';
