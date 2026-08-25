/**
 * Exactly one now-playing Discord message per guild.
 *
 * Channel policy:
 * - If guild_settings.musicChannelId is set → always upsert there.
 * - Else sticky: first rememberPanelChannel /nowplaying for the session wins.
 * - /nowplaying rebind deletes the previous message before binding the new one.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Message,
  type TextChannel,
} from 'discord.js';
import type { RippleClient } from '../../core/client.js';
import { formatDuration } from '../../lib/format.js';
import { Mutex } from '../../lib/mutex.js';
import { getQueueSnapshot, type LoopMode } from './player.js';
import {
  getPlaybackPositionMs,
  getSession,
  getSessionToken,
  isPaused,
} from './session-manager.js';

const PANEL_DEBOUNCE_MS = 500;
const EMBED_COLOR = 0x3d7ea6;
/** Fixed cell count so short titles still widen the embed. */
const PROGRESS_BAR_WIDTH = 28;

export type MusicButtonAction = 'prev' | 'pause' | 'resume' | 'skip' | 'loop' | 'stop';

interface PanelRef {
  channelId: string;
  messageId: string | null;
  /** Sticky channel locked for this voice session (when no config music channel). */
  sticky: boolean;
  /** Bumped on each upsert/clear so stale async ops are ignored. */
  generation: number;
}

const panels = new Map<string, PanelRef>();
const panelMutexes = new Map<string, Mutex>();
const pendingUpserts = new Map<string, ReturnType<typeof setTimeout>>();
/** Guilds waiting for a reanchor send (delete + new message at channel bottom). */
const pendingReanchor = new Set<string>();

function panelMutex(guildId: string): Mutex {
  const existing = panelMutexes.get(guildId);
  if (existing) {
    return existing;
  }
  const created = new Mutex();
  panelMutexes.set(guildId, created);
  return created;
}

function loopLabel(loop: LoopMode): string {
  if (loop === 'track') {
    return 'Track';
  }
  if (loop === 'queue') {
    return 'Queue';
  }
  return 'Off';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Fixed-width Unicode progress bar (snapshot only — never polled on a timer).
 * @internal Exported for unit tests.
 */
export function buildProgressBar(
  positionMs: number,
  durationMs: number | null,
  width: number = PROGRESS_BAR_WIDTH,
): string {
  const posLabel = formatDuration(Math.floor(Math.max(0, positionMs) / 1000));
  if (durationMs === null || durationMs <= 0) {
    const empty = '░'.repeat(width);
    return `${empty} ${posLabel}`;
  }
  const ratio = Math.min(1, Math.max(0, positionMs / durationMs));
  const filled = Math.round(ratio * width);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
  const durLabel = formatDuration(Math.floor(durationMs / 1000));
  return `${bar} ${posLabel} / ${durLabel}`;
}

export function musicCustomId(action: MusicButtonAction, token: string): string {
  return `music:${action}:${token}`;
}

export function parseMusicCustomId(
  customId: string,
): { action: MusicButtonAction; token: string } | null {
  const parts = customId.split(':');
  if (parts.length !== 3 || parts[0] !== 'music') {
    return null;
  }
  const action = parts[1];
  const token = parts[2];
  if (
    token === undefined ||
    token.length === 0 ||
    (action !== 'prev' &&
      action !== 'pause' &&
      action !== 'resume' &&
      action !== 'skip' &&
      action !== 'loop' &&
      action !== 'stop')
  ) {
    return null;
  }
  return { action, token };
}

function configuredMusicChannelId(
  client: RippleClient,
  guildId: string,
): string | null {
  try {
    return client.services.guildSettings.get(guildId).musicChannelId;
  } catch {
    return null;
  }
}

/**
 * Remember a candidate text channel for the panel.
 * Sticky: only the first channel for the session is kept (unless config overrides).
 * Configured music channel always wins when present at upsert time.
 */
export function rememberPanelChannel(guildId: string, channelId: string): void {
  const existing = panels.get(guildId);
  if (existing?.sticky) {
    return;
  }
  if (existing && existing.channelId === channelId) {
    return;
  }
  panels.set(guildId, {
    channelId,
    messageId: existing?.channelId === channelId ? (existing.messageId ?? null) : null,
    sticky: true,
    generation: existing?.generation ?? 0,
  });
}

/** Live panel message id (for rejecting outdated buttons in the same session). */
export function getPanelMessageId(guildId: string): string | null {
  return panels.get(guildId)?.messageId ?? null;
}

/** Bind an existing message (e.g. slash `/nowplaying` reply) as the live panel. */
export function bindPanelMessage(
  guildId: string,
  channelId: string,
  messageId: string,
): void {
  const existing = panels.get(guildId);
  panels.set(guildId, {
    channelId,
    messageId,
    sticky: true,
    generation: (existing?.generation ?? 0) + 1,
  });
}

export function getPanelRefForTests(guildId: string): PanelRef | undefined {
  return panels.get(guildId);
}

export function buildNowPlayingPayload(guildId: string): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} | null {
  const snap = getQueueSnapshot(guildId);
  const track = snap.current;
  if (track === null) {
    return null;
  }

  const token = getSessionToken(guildId);
  if (token === null) {
    return null;
  }

  const paused = isPaused(guildId);
  const session = getSession(guildId);
  const volume = session?.volume ?? 100;
  const positionMs = getPlaybackPositionMs(guildId);
  const durationMs = track.durationMs;
  const progressValue = buildProgressBar(positionMs, durationMs);

  const upNext =
    snap.upcoming.length === 0
      ? 'Nothing'
      : snap.upcoming.length === 1
        ? truncate(snap.upcoming[0]?.title ?? '1 track', 80)
        : `${truncate(snap.upcoming[0]?.title ?? '', 60)} (+${snap.upcoming.length - 1} more)`;

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(paused ? 'Paused' : 'Now playing')
    .setDescription(`**${truncate(track.title, 200)}**`)
    .addFields(
      { name: 'Progress', value: progressValue, inline: false },
      { name: 'Requested by', value: `<@${track.requestedBy}>`, inline: true },
      { name: 'Volume', value: `${volume}%`, inline: true },
      { name: 'Loop', value: loopLabel(snap.loop), inline: true },
      { name: 'Up next', value: upNext, inline: false },
    )
    .setFooter({ text: 'Ripple' });

  if (track.webpageUrl.startsWith('http://') || track.webpageUrl.startsWith('https://')) {
    embed.setURL(track.webpageUrl);
  }

  const prev = new ButtonBuilder()
    .setCustomId(musicCustomId('prev', token))
    .setLabel('Prev')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(snap.historyLength === 0);

  const pauseResume = paused
    ? new ButtonBuilder()
        .setCustomId(musicCustomId('resume', token))
        .setLabel('Resume')
        .setStyle(ButtonStyle.Success)
    : new ButtonBuilder()
        .setCustomId(musicCustomId('pause', token))
        .setLabel('Pause')
        .setStyle(ButtonStyle.Secondary);

  const skip = new ButtonBuilder()
    .setCustomId(musicCustomId('skip', token))
    .setLabel('Skip')
    .setStyle(ButtonStyle.Secondary);

  const loop = new ButtonBuilder()
    .setCustomId(musicCustomId('loop', token))
    .setLabel(`Loop: ${loopLabel(snap.loop)}`)
    .setStyle(snap.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Primary);

  const stop = new ButtonBuilder()
    .setCustomId(musicCustomId('stop', token))
    .setLabel('Stop')
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    prev,
    pauseResume,
    skip,
    loop,
    stop,
  );

  return { embeds: [embed], components: [row] };
}

async function resolveTextChannel(
  client: RippleClient,
  channelId: string,
): Promise<TextChannel | null> {
  const cached = client.channels.cache.get(channelId);
  if (cached && cached.isTextBased() && !cached.isDMBased() && 'send' in cached) {
    return cached as TextChannel;
  }
  try {
    const fetched = await client.channels.fetch(channelId);
    if (fetched && fetched.isTextBased() && !fetched.isDMBased() && 'send' in fetched) {
      return fetched as TextChannel;
    }
  } catch {
    return null;
  }
  return null;
}

async function deleteMessageQuietly(
  client: RippleClient,
  channelId: string,
  messageId: string,
): Promise<void> {
  const channel = await resolveTextChannel(client, channelId);
  if (!channel) {
    return;
  }
  try {
    const message = await channel.messages.fetch(messageId);
    await message.delete();
  } catch {
    // already gone
  }
}

/**
 * Resolve the target channel for upsert: config music channel > sticky/ref.
 */
async function resolvePanelChannelId(
  guildId: string,
  client: RippleClient,
  ref: PanelRef,
): Promise<string | null> {
  const configured = configuredMusicChannelId(client, guildId);
  if (configured !== null) {
    return configured;
  }
  return ref.channelId;
}

async function upsertNowPlayingPanelLocked(
  guildId: string,
  client: RippleClient,
  options: { reanchor: boolean } = { reanchor: false },
): Promise<Message | null> {
  const payload = buildNowPlayingPayload(guildId);
  if (payload === null) {
    await clearNowPlayingPanelLocked(guildId, client, { forget: false });
    return null;
  }

  let ref = panels.get(guildId);
  const configured = configuredMusicChannelId(client, guildId);
  if (!ref) {
    if (configured === null) {
      return null;
    }
    ref = {
      channelId: configured,
      messageId: null,
      sticky: false,
      generation: 0,
    };
    panels.set(guildId, ref);
  }

  const targetChannelId = await resolvePanelChannelId(guildId, client, ref);
  if (targetChannelId === null) {
    return null;
  }

  const channel = await resolveTextChannel(client, targetChannelId);
  if (!channel) {
    panels.delete(guildId);
    return null;
  }

  // Re-anchor or move channel: delete old message so the new one sits at channel bottom.
  // Skip delete+resend when the panel is already the channel's last message.
  let shouldReanchor =
    options.reanchor || (ref.channelId !== targetChannelId && ref.messageId !== null);
  if (
    shouldReanchor &&
    ref.messageId !== null &&
    ref.channelId === targetChannelId &&
    channel.lastMessageId === ref.messageId
  ) {
    shouldReanchor = false;
  }
  if (shouldReanchor && ref.messageId !== null) {
    await deleteMessageQuietly(client, ref.channelId, ref.messageId);
    ref = {
      channelId: targetChannelId,
      messageId: null,
      sticky: configured === null ? ref.sticky : false,
      generation: ref.generation,
    };
    panels.set(guildId, ref);
  } else if (ref.channelId !== targetChannelId) {
    ref = {
      ...ref,
      channelId: targetChannelId,
      sticky: configured === null ? ref.sticky : false,
    };
    panels.set(guildId, ref);
  }

  const generation = ref.generation + 1;
  panels.set(guildId, {
    channelId: channel.id,
    messageId: ref.messageId,
    sticky: ref.sticky,
    generation,
  });

  if (ref.messageId !== null) {
    try {
      const existing = await channel.messages.fetch(ref.messageId);
      const edited = await existing.edit({
        embeds: payload.embeds,
        components: payload.components,
        content: null,
      });
      const latest = panels.get(guildId);
      if (latest && latest.generation === generation) {
        panels.set(guildId, {
          channelId: channel.id,
          messageId: edited.id,
          sticky: latest.sticky,
          generation,
        });
      }
      return edited;
    } catch {
      try {
        const stale = await channel.messages.fetch(ref.messageId);
        await stale.delete();
      } catch {
        // already gone
      }
    }
  }

  const latestBeforeSend = panels.get(guildId);
  if (!latestBeforeSend || latestBeforeSend.generation !== generation) {
    return null;
  }

  const sent = await channel.send({
    embeds: payload.embeds,
    components: payload.components,
  });

  const latestAfterSend = panels.get(guildId);
  if (latestAfterSend && latestAfterSend.generation === generation) {
    panels.set(guildId, {
      channelId: channel.id,
      messageId: sent.id,
      sticky: latestAfterSend.sticky,
      generation,
    });
  } else {
    try {
      await sent.delete();
    } catch {
      // ignore
    }
    return null;
  }
  return sent;
}

async function clearNowPlayingPanelLocked(
  guildId: string,
  client: RippleClient,
  options: { forget: boolean },
): Promise<void> {
  const timer = pendingUpserts.get(guildId);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingUpserts.delete(guildId);
  }

  const ref = panels.get(guildId);
  if (!ref) {
    return;
  }

  const generation = ref.generation + 1;
  const channelId = ref.channelId;
  const messageId = ref.messageId;
  const sticky = ref.sticky;

  if (options.forget) {
    panels.delete(guildId);
  } else {
    panels.set(guildId, { channelId, messageId: null, sticky, generation });
  }

  if (messageId === null) {
    return;
  }

  await deleteMessageQuietly(client, channelId, messageId);
}

/**
 * Delete the current panel message (if any) then prepare for a rebind in `channelId`.
 * Used by `/nowplaying` so only one live control message exists.
 */
export async function preparePanelRebind(
  guildId: string,
  client: RippleClient,
  channelId: string,
): Promise<void> {
  await panelMutex(guildId).runExclusive(async () => {
    const ref = panels.get(guildId);
    if (ref?.messageId) {
      await deleteMessageQuietly(client, ref.channelId, ref.messageId);
    }
    panels.set(guildId, {
      channelId,
      messageId: null,
      sticky: true,
      generation: (ref?.generation ?? 0) + 1,
    });
  });
}

export async function upsertNowPlayingPanel(
  guildId: string,
  client: RippleClient,
  options: { reanchor?: boolean } = {},
): Promise<Message | null> {
  return panelMutex(guildId).runExclusive(() =>
    upsertNowPlayingPanelLocked(guildId, client, { reanchor: options.reanchor === true }),
  );
}

/** Delete the tracked message but keep channelId for a later repost. */
export async function clearNowPlayingPanel(
  guildId: string,
  client: RippleClient,
): Promise<void> {
  await panelMutex(guildId).runExclusive(() =>
    clearNowPlayingPanelLocked(guildId, client, { forget: false }),
  );
}

/** Full leave: delete message and drop panel state. */
export async function forgetPanel(guildId: string, client: RippleClient): Promise<void> {
  await panelMutex(guildId).runExclusive(() =>
    clearNowPlayingPanelLocked(guildId, client, { forget: true }),
  );
}

export function schedulePanelUpsert(
  guildId: string,
  client: RippleClient,
  options: { immediate?: boolean; reanchor?: boolean } = {},
): void {
  if (options.reanchor === true) {
    pendingReanchor.add(guildId);
  }

  const existing = pendingUpserts.get(guildId);
  if (existing !== undefined) {
    clearTimeout(existing);
    pendingUpserts.delete(guildId);
  }

  const run = (): void => {
    const reanchor = pendingReanchor.has(guildId);
    pendingReanchor.delete(guildId);
    void upsertNowPlayingPanel(guildId, client, { reanchor }).catch((error: unknown) => {
      client.services.logger.warn({ err: error, guildId }, 'now-playing panel upsert failed');
    });
  };

  if (options.immediate) {
    run();
    return;
  }

  const timer = setTimeout(() => {
    pendingUpserts.delete(guildId);
    run();
  }, PANEL_DEBOUNCE_MS);
  timer.unref();
  pendingUpserts.set(guildId, timer);
}

export function schedulePanelClear(guildId: string, client: RippleClient): void {
  const existing = pendingUpserts.get(guildId);
  if (existing !== undefined) {
    clearTimeout(existing);
    pendingUpserts.delete(guildId);
  }
  pendingReanchor.delete(guildId);
  void clearNowPlayingPanel(guildId, client).catch((error: unknown) => {
    client.services.logger.warn({ err: error, guildId }, 'now-playing panel clear failed');
  });
}

export function schedulePanelForget(guildId: string, client: RippleClient): void {
  const existing = pendingUpserts.get(guildId);
  if (existing !== undefined) {
    clearTimeout(existing);
    pendingUpserts.delete(guildId);
  }
  pendingReanchor.delete(guildId);
  void forgetPanel(guildId, client).catch((error: unknown) => {
    client.services.logger.warn({ err: error, guildId }, 'now-playing panel forget failed');
  });
}

/** @internal */
export function resetNowPlayingPanelForTests(): void {
  for (const timer of pendingUpserts.values()) {
    clearTimeout(timer);
  }
  pendingUpserts.clear();
  pendingReanchor.clear();
  panels.clear();
  panelMutexes.clear();
}
