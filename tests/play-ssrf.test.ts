import { describe, expect, it } from 'vitest';
import { parseEnv, resetEnvCache } from '../src/config/env.js';
import { UserFacingError } from '../src/core/errors.js';
import { createLogger } from '../src/lib/logger.js';
import { playDirectUrl } from '../src/modules/music/session-manager.js';

describe('playDirectUrl SSRF gate', () => {
  it('rejects private URLs before spawning FFmpeg', async () => {
    resetEnvCache();
    const env = parseEnv({
      DISCORD_TOKEN: 'test-token',
      DISCORD_CLIENT_ID: '123456789012345678',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    const logger = createLogger(env);

    await expect(
      playDirectUrl(
        'guild-ssrf',
        {
          url: 'http://127.0.0.1/audio.mp3',
          title: 'evil',
          codec: 'other',
        },
        env,
        logger,
      ),
    ).rejects.toBeInstanceOf(UserFacingError);

    await expect(
      playDirectUrl(
        'guild-ssrf',
        {
          url: 'http://192.168.0.10/a.mp3',
          title: 'evil',
          codec: 'other',
        },
        env,
        logger,
      ),
    ).rejects.toBeInstanceOf(UserFacingError);
  });
});
