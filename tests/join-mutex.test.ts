import { describe, expect, it } from 'vitest';
import { withGuildJoinLock } from '../src/modules/music/session-manager.js';

describe('withGuildJoinLock', () => {
  it('serializes concurrent join-critical sections per guild', async () => {
    let active = 0;
    let maxActive = 0;
    let joins = 0;

    async function simulatedJoin(): Promise<void> {
      await withGuildJoinLock('guild-join-test', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        joins += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
      });
    }

    await Promise.all([simulatedJoin(), simulatedJoin(), simulatedJoin()]);
    expect(joins).toBe(3);
    expect(maxActive).toBe(1);
  });

  it('does not block other guilds', async () => {
    let concurrent = 0;
    let sawParallel = false;

    async function hold(guildId: string): Promise<void> {
      await withGuildJoinLock(guildId, async () => {
        concurrent += 1;
        if (concurrent >= 2) {
          sawParallel = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
        concurrent -= 1;
      });
    }

    await Promise.all([hold('guild-a'), hold('guild-b')]);
    expect(sawParallel).toBe(true);
  });
});
