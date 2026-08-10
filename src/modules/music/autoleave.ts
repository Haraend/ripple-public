/**
 * Autoleave timers — empty voice channel and idle empty queue.
 * Leave / alone callbacks are injected to avoid circular imports.
 */

type LeaveFn = (guildId: string) => void;
/** True when the bot should treat the VC as empty of humans (alone or unknown). */
type IsAloneFn = (guildId: string) => boolean;

let leaveGuild: LeaveFn = () => undefined;
let isAloneInVoice: IsAloneFn = () => true;

interface GuildAutoleave {
  emptyChannel: ReturnType<typeof setTimeout> | null;
  idleQueue: ReturnType<typeof setTimeout> | null;
}

const timers = new Map<string, GuildAutoleave>();

/** Wire once from the music module. */
export function initAutoleave(leaveFn: LeaveFn, isAloneFn: IsAloneFn = () => true): void {
  leaveGuild = leaveFn;
  isAloneInVoice = isAloneFn;
}

export function isBotAloneInVoice(guildId: string): boolean {
  return isAloneInVoice(guildId);
}

function getOrCreate(guildId: string): GuildAutoleave {
  const existing = timers.get(guildId);
  if (existing) {
    return existing;
  }
  const created: GuildAutoleave = { emptyChannel: null, idleQueue: null };
  timers.set(guildId, created);
  return created;
}

function clearTimer(handle: ReturnType<typeof setTimeout> | null): void {
  if (handle !== null) {
    clearTimeout(handle);
  }
}

export function cancelEmptyChannelAutoleave(guildId: string): void {
  const state = timers.get(guildId);
  if (!state) {
    return;
  }
  clearTimer(state.emptyChannel);
  state.emptyChannel = null;
}

export function cancelIdleQueueAutoleave(guildId: string): void {
  const state = timers.get(guildId);
  if (!state) {
    return;
  }
  clearTimer(state.idleQueue);
  state.idleQueue = null;
}

export function clearAllAutoleave(guildId: string): void {
  cancelEmptyChannelAutoleave(guildId);
  cancelIdleQueueAutoleave(guildId);
  timers.delete(guildId);
}

export function clearEveryAutoleave(): void {
  const guildIds = Array.from(timers.keys());
  for (const guildId of guildIds) {
    clearAllAutoleave(guildId);
  }
}

/** Start/replace the empty-channel leave timer (bot alone in VC). */
export function scheduleEmptyChannelAutoleave(guildId: string, timeoutMs: number): void {
  const state = getOrCreate(guildId);
  clearTimer(state.emptyChannel);
  state.emptyChannel = setTimeout(() => {
    state.emptyChannel = null;
    if (!isAloneInVoice(guildId)) {
      return;
    }
    leaveGuild(guildId);
  }, timeoutMs);
}

/**
 * Start/replace idle leave when the guild queue is empty.
 * Only arms (and only fires) while the bot is alone in the voice channel —
 * humans staying in VC after the last track must not be disconnected by this timer.
 */
export function scheduleIdleQueueAutoleave(guildId: string, timeoutMs: number): void {
  if (!isAloneInVoice(guildId)) {
    cancelIdleQueueAutoleave(guildId);
    return;
  }
  const state = getOrCreate(guildId);
  clearTimer(state.idleQueue);
  state.idleQueue = setTimeout(() => {
    state.idleQueue = null;
    if (!isAloneInVoice(guildId)) {
      return;
    }
    leaveGuild(guildId);
  }, timeoutMs);
}

/** @internal Test helpers */
export function resetAutoleaveForTests(): void {
  const guildIds = Array.from(timers.keys());
  for (const guildId of guildIds) {
    clearAllAutoleave(guildId);
  }
  leaveGuild = () => undefined;
  isAloneInVoice = () => true;
}

export function hasEmptyChannelTimerForTest(guildId: string): boolean {
  return timers.get(guildId)?.emptyChannel !== null && timers.get(guildId)?.emptyChannel !== undefined;
}

export function hasIdleQueueTimerForTest(guildId: string): boolean {
  return timers.get(guildId)?.idleQueue !== null && timers.get(guildId)?.idleQueue !== undefined;
}
