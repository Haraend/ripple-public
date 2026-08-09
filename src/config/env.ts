import { z } from 'zod';

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const booleanish = z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) {
    return false;
  }
  return value;
}, z.boolean());

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake');

const requiredSnowflake = z.preprocess((value) => {
  if (value === undefined || value === null) {
    return '';
  }
  return value;
}, z.string()).superRefine((value, ctx) => {
  if (value.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'DISCORD_CLIENT_ID is required' });
    return;
  }
  if (!/^\d{17,20}$/.test(value)) {
    ctx.addIssue({ code: 'custom', message: 'must be a Discord snowflake' });
  }
});

const envSchema = z
  .object({
    DISCORD_TOKEN: z.preprocess(
      (value) => (value === undefined || value === null ? '' : value),
      z.string().min(1, 'DISCORD_TOKEN is required'),
    ),
    DISCORD_CLIENT_ID: requiredSnowflake,
    DEV_GUILD_ID: z.preprocess(emptyToUndefined, snowflake.optional()),
    OWNER_IDS: z.preprocess((value) => {
      if (value === undefined || value === null || value === '') {
        return [];
      }
      if (typeof value !== 'string') {
        return value;
      }
      return value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    }, z.array(snowflake).default([])),

    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_PATH: z.string().min(1).default('./data/ripple.db'),

    FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
    YTDLP_PATH: z.string().min(1).default('yt-dlp'),
    YTDLP_COOKIES_PATH: z.preprocess(emptyToUndefined, z.string().min(1).optional()),

    MUSIC_MAX_QUEUE_SIZE: z.coerce.number().int().positive().default(100),
    MUSIC_MAX_CONCURRENT_STREAMS: z.coerce.number().int().positive().default(2),
    MUSIC_DEFAULT_VOLUME: z.coerce.number().int().min(0).max(200).default(100),
    MUSIC_OPUS_BITRATE: z.coerce.number().int().positive().default(96_000),
    MUSIC_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    MUSIC_EMPTY_CHANNEL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    /** Max track_cache rows (metadata/URLs only). 0 disables caching. */
    MUSIC_TRACK_CACHE_MAX_ROWS: z.coerce.number().int().min(0).default(5000),

    ENABLE_PREFIX_COMMANDS: booleanish.default(false),
    COMMAND_PREFIX: z.string().min(1).max(5).default('!'),

    APEX_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    APEX_MAX_TRACKED_ACCOUNTS: z.coerce.number().int().positive().default(50),
    APEX_MAX_TRACKED_PER_GUILD: z.coerce.number().int().positive().default(25),
    APEX_POLL_HOT_MINUTES: z.coerce.number().int().positive().default(4),
    APEX_POLL_WARM_MINUTES: z.coerce.number().int().positive().default(15),
    APEX_POLL_COLD_MINUTES: z.coerce.number().int().positive().default(60),

    SPOTIFY_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    SPOTIFY_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  })
  .superRefine((data, ctx) => {
    const hasSpotifyId = data.SPOTIFY_CLIENT_ID !== undefined;
    const hasSpotifySecret = data.SPOTIFY_CLIENT_SECRET !== undefined;
    if (hasSpotifyId !== hasSpotifySecret) {
      ctx.addIssue({
        code: 'custom',
        message: 'SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must both be set or both omitted',
        path: hasSpotifyId ? ['SPOTIFY_CLIENT_SECRET'] : ['SPOTIFY_CLIENT_ID'],
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached === undefined) {
    cached = parseEnv();
  }
  return cached;
}

/** Test helper — clears the memoized env so parseEnv can be re-run. */
export function resetEnvCache(): void {
  cached = undefined;
}

export function isApexEnabled(env: Env = getEnv()): boolean {
  return env.APEX_API_KEY !== undefined;
}

export function isSpotifyEnabled(env: Env = getEnv()): boolean {
  return env.SPOTIFY_CLIENT_ID !== undefined && env.SPOTIFY_CLIENT_SECRET !== undefined;
}
