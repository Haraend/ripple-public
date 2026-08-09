export type SourceCodec = 'opus' | 'other';

export interface TrackLike {
  readonly url: string;
  readonly title: string;
  readonly codec: SourceCodec;
}

export interface FfmpegPlaybackOptions {
  readonly volume: number;
  readonly seekMs: number;
  readonly opusBitrate: number;
}

export function needsTranscode(
  track: Pick<TrackLike, 'codec'>,
  options: Pick<FfmpegPlaybackOptions, 'volume' | 'seekMs'>,
): boolean {
  return options.volume !== 100 || options.seekMs > 0 || track.codec !== 'opus';
}

/**
 * Build FFmpeg argv (excluding the binary path) that writes Ogg/Opus to stdout.
 * Copy mode when possible; otherwise libopus transcode for volume/seek/non-opus.
 */
export function buildFfmpegArgs(
  track: TrackLike,
  options: FfmpegPlaybackOptions,
): readonly string[] {
  const reconnect = [
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '5',
  ] as const;

  const seekArgs =
    options.seekMs > 0 ? (['-ss', (options.seekMs / 1000).toFixed(3)] as const) : ([] as const);

  if (!needsTranscode(track, options)) {
    return [
      ...reconnect,
      '-i',
      track.url,
      '-vn',
      '-c:a',
      'copy',
      '-f',
      'opus',
      '-loglevel',
      'error',
      'pipe:1',
    ];
  }

  const volumeLinear = Math.max(0, Math.min(2, options.volume / 100));

  return [
    ...seekArgs,
    ...reconnect,
    '-i',
    track.url,
    '-vn',
    '-c:a',
    'libopus',
    '-b:a',
    String(options.opusBitrate),
    '-ar',
    '48000',
    '-ac',
    '2',
    '-af',
    `volume=${volumeLinear}`,
    '-f',
    'opus',
    '-loglevel',
    'error',
    'pipe:1',
  ];
}
