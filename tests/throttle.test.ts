import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv, resetEnvCache } from '../src/config/env.js';
import { UserFacingError } from '../src/core/errors.js';
import {
  acquireResolveSlot,
  getPendingResolvesForTest,
  releaseResolveSlot,
  resetMusicThrottles,
} from '../src/modules/music/throttle.js';

function env(overrides: Record<string, string | undefined> = {}) {
  return parseEnv({
    DISCORD_TOKEN: 'test-token',
    DISCORD_CLIENT_ID: '123456789012345678',
    NODE_ENV: 'test',
    ...overrides,
  });
}

describe('music resolve throttles', () => {
  afterEach(() => {
    resetEnvCache();
    resetMusicThrottles();
  });

  it('enforces per-user cooldown with a visible error', () => {
    const e = env({ MUSIC_RESOLVE_COOLDOWN_MS: '5000' });
    acquireResolveSlot('g1', 'u1', e, 1_000);
    releaseResolveSlot('g1');

    expect(() => acquireResolveSlot('g1', 'u1', e, 2_000)).toThrow(UserFacingError);
    expect(() => acquireResolveSlot('g1', 'u1', e, 2_000)).toThrow(/wait \d+s/i);

    acquireResolveSlot('g1', 'u1', e, 7_000);
    releaseResolveSlot('g1');
  });

  it('allows a different user during another user cooldown', () => {
    const e = env({ MUSIC_RESOLVE_COOLDOWN_MS: '5000' });
    acquireResolveSlot('g1', 'u1', e, 1_000);
    releaseResolveSlot('g1');
    acquireResolveSlot('g1', 'u2', e, 1_500);
    releaseResolveSlot('g1');
  });

  it('caps pending resolves per guild', () => {
    const e = env({
      MUSIC_RESOLVE_COOLDOWN_MS: '0',
      MUSIC_MAX_PENDING_RESOLVES_PER_GUILD: '2',
    });
    acquireResolveSlot('g1', 'u1', e);
    acquireResolveSlot('g1', 'u2', e);
    expect(getPendingResolvesForTest('g1')).toBe(2);
    expect(() => acquireResolveSlot('g1', 'u3', e)).toThrow(/already has 2 tracks resolving/i);
    releaseResolveSlot('g1');
    releaseResolveSlot('g1');
    expect(getPendingResolvesForTest('g1')).toBe(0);
  });
});
