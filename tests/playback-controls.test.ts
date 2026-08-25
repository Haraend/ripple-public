import { describe, expect, it } from 'vitest';
import { needsTranscode, buildFfmpegArgs } from '../src/modules/music/stream.js';

describe('playback position helpers via ffmpeg args', () => {
  it('needsTranscode when volume or seek changes', () => {
    const track = { url: 'https://cdn.example.com/a.webm', title: 'a', codec: 'opus' as const };
    expect(needsTranscode(track, { volume: 100, seekMs: 0 })).toBe(false);
    expect(needsTranscode(track, { volume: 50, seekMs: 0 })).toBe(true);
    expect(needsTranscode(track, { volume: 100, seekMs: 5_000 })).toBe(true);
  });

  it('includes -ss for seek in transcode path', () => {
    const args = buildFfmpegArgs(
      { url: 'https://cdn.example.com/a.mp3', title: 'a', codec: 'other' },
      { volume: 100, seekMs: 12_500, opusBitrate: 96_000 },
    );
    expect(args).toContain('-ss');
    expect(args).toContain('12.500');
  });
});
