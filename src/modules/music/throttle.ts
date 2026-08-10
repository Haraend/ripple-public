import type { Env } from '../../config/env.js';
import { UserFacingError } from '../../core/errors.js';

const lastResolveAtByUser = new Map<string, number>();
const pendingResolvesByGuild = new Map<string, number>();

/** Test helper — clears throttle state. */
export function resetMusicThrottles(): void {
  lastResolveAtByUser.clear();
  pendingResolvesByGuild.clear();
}

function cooldownKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/**
 * Acquire a resolve slot or throw a visible UserFacingError.
 * Call `releaseResolveSlot` in a finally block after resolve finishes.
 */
export function acquireResolveSlot(
  guildId: string,
  userId: string,
  env: Pick<Env, 'MUSIC_RESOLVE_COOLDOWN_MS' | 'MUSIC_MAX_PENDING_RESOLVES_PER_GUILD'>,
  nowMs: number = Date.now(),
): void {
  const cooldownMs = env.MUSIC_RESOLVE_COOLDOWN_MS;
  if (cooldownMs > 0) {
    const key = cooldownKey(guildId, userId);
    const last = lastResolveAtByUser.get(key);
    if (last !== undefined) {
      const elapsed = nowMs - last;
      if (elapsed < cooldownMs) {
        const waitSec = Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000));
        throw new UserFacingError(
          `You're requesting tracks too quickly — wait ${waitSec}s before trying again.`,
        );
      }
    }
  }

  const pending = pendingResolvesByGuild.get(guildId) ?? 0;
  const maxPending = env.MUSIC_MAX_PENDING_RESOLVES_PER_GUILD;
  if (pending >= maxPending) {
    throw new UserFacingError(
      `This server already has ${maxPending} tracks resolving. Try again in a moment.`,
    );
  }

  pendingResolvesByGuild.set(guildId, pending + 1);
  if (cooldownMs > 0) {
    lastResolveAtByUser.set(cooldownKey(guildId, userId), nowMs);
  }
}

export function releaseResolveSlot(guildId: string): void {
  const pending = pendingResolvesByGuild.get(guildId) ?? 0;
  if (pending <= 1) {
    pendingResolvesByGuild.delete(guildId);
    return;
  }
  pendingResolvesByGuild.set(guildId, pending - 1);
}

/** @internal Test helper */
export function getPendingResolvesForTest(guildId: string): number {
  return pendingResolvesByGuild.get(guildId) ?? 0;
}
