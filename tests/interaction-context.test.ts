import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createInteractionContext } from '../src/core/context.js';
import type { RippleClient } from '../src/core/client.js';
import { createLogger } from '../src/lib/logger.js';
import { parseEnv, resetEnvCache } from '../src/config/env.js';

function fakeInteraction(overrides: {
  deferred?: boolean;
  replied?: boolean;
}): {
  interaction: ChatInputCommandInteraction;
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(async () => undefined);
  const followUp = vi.fn(async () => undefined);
  const editReply = vi.fn(async () => undefined);
  const interaction = {
    deferred: overrides.deferred ?? false,
    replied: overrides.replied ?? false,
    guild: null,
    member: null,
    channel: null,
    user: { id: '1' },
    options: {
      getString: () => null,
      getInteger: () => null,
      getBoolean: () => null,
      getUser: () => null,
      getChannel: () => null,
      getRole: () => null,
      getAttachment: () => null,
    },
    reply,
    followUp,
    editReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply, followUp, editReply };
}

describe('createInteractionContext allowedMentions', () => {
  it('passes allowedMentions parse [] on reply, followUp, and editReply', async () => {
    resetEnvCache();
    const env = parseEnv({
      DISCORD_TOKEN: 'test-token',
      DISCORD_CLIENT_ID: '123456789012345678',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    const logger = createLogger(env);
    const client = { services: { env } } as unknown as RippleClient;

    const fresh = fakeInteraction({});
    const ctxFresh = createInteractionContext(client, fresh.interaction, logger);
    await ctxFresh.reply('hello @everyone');
    expect(fresh.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'hello @everyone',
        allowedMentions: { parse: [] },
      }),
    );

    const deferred = fakeInteraction({ deferred: true });
    const ctxDeferred = createInteractionContext(client, deferred.interaction, logger);
    await ctxDeferred.reply('follow @here');
    expect(deferred.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'follow @here',
        allowedMentions: { parse: [] },
      }),
    );

    const edit = fakeInteraction({ deferred: true });
    const ctxEdit = createInteractionContext(client, edit.interaction, logger);
    await ctxEdit.editReply('edit @everyone');
    expect(edit.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'edit @everyone',
        allowedMentions: { parse: [] },
      }),
    );
  });
});
