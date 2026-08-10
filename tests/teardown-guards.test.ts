import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceConnection } from '@discordjs/voice';
import {
  clearSessionsForTests,
  markJoiningForTests,
  mayTeardownAfterDisconnect,
  setSessionConnectionForTests,
} from '../src/modules/music/session-manager.js';
import { deferThen } from '../src/modules/music/components.js';

function fakeConnection(id: string): VoiceConnection {
  return { id } as unknown as VoiceConnection;
}

describe('mayTeardownAfterDisconnect', () => {
  afterEach(() => {
    clearSessionsForTests();
  });

  it('allows teardown when session still owns that connection', () => {
    const conn = fakeConnection('live');
    setSessionConnectionForTests('g1', conn);
    expect(mayTeardownAfterDisconnect('g1', conn)).toBe(true);
  });

  it('blocks teardown when session was remounted onto a newer connection', () => {
    const oldConn = fakeConnection('old');
    const newConn = fakeConnection('new');
    setSessionConnectionForTests('g1', newConn);
    expect(mayTeardownAfterDisconnect('g1', oldConn)).toBe(false);
  });

  it('blocks orphan teardown while a join is in flight', () => {
    const joining = fakeConnection('joining');
    markJoiningForTests('g1', joining);
    expect(mayTeardownAfterDisconnect('g1', fakeConnection('stale'))).toBe(false);
  });

  it('allows orphan teardown when nothing is joining or mapped', () => {
    expect(mayTeardownAfterDisconnect('g1', fakeConnection('orphan'))).toBe(true);
  });
});

describe('deferThen', () => {
  it('awaits defer before running work', async () => {
    const order: string[] = [];
    let releaseWork!: () => void;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });

    const run = deferThen(
      async () => {
        order.push('defer');
      },
      async () => {
        order.push('work-start');
        await workGate;
        order.push('work-end');
        return 42;
      },
    );

    await vi.waitFor(() => {
      expect(order).toEqual(['defer', 'work-start']);
    });
    releaseWork();
    await expect(run).resolves.toBe(42);
    expect(order).toEqual(['defer', 'work-start', 'work-end']);
  });
});
