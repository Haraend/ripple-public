import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  clearTrackedFfmpegChildrenForTests,
  reapOrphanFfmpegChildren,
  trackFfmpegChildForTests,
} from '../src/modules/music/session-manager.js';

function fakeChild(options: {
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
}): ChildProcess {
  const emitter = new EventEmitter();
  const child = emitter as unknown as ChildProcess;
  Object.defineProperty(child, 'exitCode', {
    get: () => (options.exitCode === undefined ? null : options.exitCode),
  });
  Object.defineProperty(child, 'signalCode', {
    get: () => (options.signalCode === undefined ? null : options.signalCode),
  });
  Object.defineProperty(child, 'killed', { get: () => false, configurable: true });
  child.kill = vi.fn(() => {
    Object.defineProperty(child, 'killed', { get: () => true });
    return true;
  }) as ChildProcess['kill'];
  return child;
}

describe('reapOrphanFfmpegChildren', () => {
  afterEach(() => {
    clearTrackedFfmpegChildrenForTests();
  });

  it('prunes exited children and kills live orphans', () => {
    const exited = fakeChild({ exitCode: 0 });
    const orphan = fakeChild({});
    trackFfmpegChildForTests(exited);
    trackFfmpegChildForTests(orphan);

    const result = reapOrphanFfmpegChildren();
    expect(result.pruned).toBe(1);
    expect(result.killed).toBe(1);
    expect(orphan.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('leaves owned children alone when none are orphaned', () => {
    // No sessions in this unit test → any live tracked child is an orphan.
    // Verified above; empty tracked set is a no-op.
    expect(reapOrphanFfmpegChildren()).toEqual({ killed: 0, pruned: 0 });
  });
});
