import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  ClientEvents,
  Guild,
  GuildMember,
  Message,
  PermissionResolvable,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  TextBasedChannel,
  User,
} from 'discord.js';
import type { Logger } from '../lib/logger.js';
import type { RippleClient } from './client.js';

export type PermissionTier = 'everyone' | 'dj' | 'admin' | 'owner';

export interface CommandOptionsReader {
  getString(name: string, required?: boolean): string | null;
  getInteger(name: string, required?: boolean): number | null;
  getBoolean(name: string, required?: boolean): boolean | null;
  getUser(name: string, required?: boolean): User | null;
  getChannel(name: string, required?: boolean): TextBasedChannel | null;
  getRole(name: string, required?: boolean): { id: string; name: string } | null;
  getAttachment(
    name: string,
    required?: boolean,
  ): { url: string; name: string; contentType: string | null } | null;
  /** Remaining free-text for prefix commands (after alias). */
  getRest(): string | null;
}

export interface CommandReplyPayload {
  content?: string;
  ephemeral?: boolean;
  components?: unknown[];
  embeds?: unknown[];
}

export interface CommandContext {
  readonly client: RippleClient;
  readonly guild: Guild | null;
  readonly member: GuildMember | null;
  readonly channel: TextBasedChannel | null;
  readonly user: User;
  readonly options: CommandOptionsReader;
  readonly logger: Logger;
  readonly source: 'interaction' | 'message';
  readonly rawInteraction: ChatInputCommandInteraction | null;
  readonly rawMessage: Message | null;
  defer(ephemeral?: boolean): Promise<void>;
  reply(payload: CommandReplyPayload | string): Promise<void>;
  editReply(payload: CommandReplyPayload | string): Promise<void>;
}

export type SlashCommandData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder
  | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>;

export interface Command {
  readonly data: SlashCommandData;
  readonly tier: PermissionTier;
  readonly prefixAliases?: readonly string[];
  readonly guildOnly: boolean;
  /** Extra Discord permissions to declare on the slash command (admin tier adds ManageGuild). */
  readonly defaultMemberPermissions?: PermissionResolvable | null;
  execute(ctx: CommandContext): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}

export interface Event<K extends keyof ClientEvents = keyof ClientEvents> {
  readonly name: K;
  readonly once?: boolean;
  execute(client: RippleClient, ...args: ClientEvents[K]): Promise<void> | void;
}

export interface Module {
  readonly name: 'core' | 'music' | 'apex';
  readonly enabled: boolean;
  readonly commands: readonly Command[];
  init?(client: RippleClient): Promise<void>;
  shutdown?(): Promise<void>;
}
