import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs, needsTranscode } from '../src/modules/music/stream.js';

const opusTrack = {
  url: 'https://example.com/audio.opus',
  title: 'demo',
  codec: 'opus' as const,
};

const otherTrack = {
  url: 'https://example.com/audio.mp3',
  title: 'demo-mp3',
  codec: 'other' as const,
};

describe('needsTranscode', () => {
  it('is false for opus at volume 100 with no seek', () => {
    expect(needsTranscode(opusTrack, { volume: 100, seekMs: 0 })).toBe(false);
  });

  it('is true when volume is not 100', () => {
    expect(needsTranscode(opusTrack, { volume: 50, seekMs: 0 })).toBe(true);
  });

  it('is true when seek is set', () => {
    expect(needsTranscode(opusTrack, { volume: 100, seekMs: 1500 })).toBe(true);
  });

  it('is true for non-opus sources', () => {
    expect(needsTranscode(otherTrack, { volume: 100, seekMs: 0 })).toBe(true);
  });
});

describe('buildFfmpegArgs', () => {
  it('uses copy mode for opus passthrough', () => {
    const args = buildFfmpegArgs(opusTrack, {
      volume: 100,
      seekMs: 0,
      opusBitrate: 96_000,
    });
    expect(args).toContain('copy');
    expect(args).not.toContain('libopus');
    expect(args.at(-1)).toBe('pipe:1');
  });

  it('uses libopus transcode when volume changes', () => {
    const args = buildFfmpegArgs(opusTrack, {
      volume: 50,
      seekMs: 0,
      opusBitrate: 96_000,
    });
    expect(args).toContain('libopus');
    expect(args).toContain('volume=0.5');
    expect(args).toContain('96000');
  });

  it('prefixes -ss when seeking', () => {
    const args = buildFfmpegArgs(opusTrack, {
      volume: 100,
      seekMs: 2500,
      opusBitrate: 96_000,
    });
    expect(args[0]).toBe('-ss');
    expect(args[1]).toBe('2.500');
    expect(args).toContain('libopus');
  });
});
