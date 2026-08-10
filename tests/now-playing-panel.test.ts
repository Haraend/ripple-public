import { describe, expect, it } from 'vitest';
import {
  bindPanelMessage,
  buildNowPlayingPayload,
  buildProgressBar,
  clearNowPlayingPanel,
  forgetPanel,
  getPanelRefForTests,
  musicCustomId,
  parseMusicCustomId,
  rememberPanelChannel,
  resetNowPlayingPanelForTests,
} from '../src/modules/music/now-playing-panel.js';
import { resolveSessionTokenForJoin } from '../src/modules/music/session-manager.js';

describe('music customId', () => {
  it('round-trips actions and tokens', () => {
    expect(musicCustomId('skip', 'abc123')).toBe('music:skip:abc123');
    expect(parseMusicCustomId('music:pause:tok')).toEqual({ action: 'pause', token: 'tok' });
  });

  it('rejects malformed ids', () => {
    expect(parseMusicCustomId('music:skip')).toBeNull();
    expect(parseMusicCustomId('other:skip:tok')).toBeNull();
  });
});

describe('buildProgressBar', () => {
  it('renders a fixed-width bar with time labels', () => {
    const bar = buildProgressBar(60_000, 240_000, 28);
    expect(bar.startsWith('███████')).toBe(true);
    expect(bar).toContain('1:00 / 4:00');
    expect(bar.replace(/[^█░]/gu, '').length).toBe(28);
  });

  it('handles unknown duration without shrinking width', () => {
    const bar = buildProgressBar(12_000, null, 28);
    expect(bar.replace(/[^█░]/gu, '').length).toBe(28);
    expect(bar).toContain('0:12');
  });
});

describe('buildNowPlayingPayload', () => {
  it('returns null when nothing is playing', () => {
    resetNowPlayingPanelForTests();
    expect(buildNowPlayingPayload('guild-empty')).toBeNull();
  });
});

describe('panel channel retention', () => {
  it('clear keeps channelId; forget drops the entry', async () => {
    resetNowPlayingPanelForTests();
    rememberPanelChannel('g1', 'ch1');
    bindPanelMessage('g1', 'ch1', 'msg1');
    expect(getPanelRefForTests('g1')?.messageId).toBe('msg1');

    const fakeClient = {
      channels: { cache: { get: () => undefined }, fetch: async () => null },
      services: {
        logger: { warn: () => undefined },
        guildSettings: { get: () => ({ musicChannelId: null }) },
      },
    };

    await clearNowPlayingPanel('g1', fakeClient as never);
    const afterClear = getPanelRefForTests('g1');
    expect(afterClear?.channelId).toBe('ch1');
    expect(afterClear?.messageId).toBeNull();

    await forgetPanel('g1', fakeClient as never);
    expect(getPanelRefForTests('g1')).toBeUndefined();
  });

  it('sticky remember ignores later channels', () => {
    resetNowPlayingPanelForTests();
    rememberPanelChannel('g1', 'ch1');
    rememberPanelChannel('g1', 'ch2');
    expect(getPanelRefForTests('g1')?.channelId).toBe('ch1');
    expect(getPanelRefForTests('g1')?.sticky).toBe(true);
  });
});

describe('resolveSessionTokenForJoin', () => {
  it('reuses previous token on remount', () => {
    expect(resolveSessionTokenForJoin('keep-me')).toBe('keep-me');
  });

  it('mints a new token when none exists', () => {
    const token = resolveSessionTokenForJoin(undefined);
    expect(token).toMatch(/^[a-f0-9]{16}$/);
  });
});
