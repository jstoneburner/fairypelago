import { ColumnType, Generated, JSONColumnType } from 'kysely'

import { ArchipelagoRoomData } from '../types/archipelago-types.js'
import { SessionOptions } from '../types/session-types.js'

export interface GuildSettingsTable {
  guildId: string;
  logChannelId: string | null;
  commandPrefix: string;
  sessionCommandPrefix: string;
  sessionCategoryName: string;
  sessionOptions: JSONColumnType<SessionOptions>;
  playerEmojis: JSONColumnType<Record<string, string>>;
}

export interface SessionsTable {
  id: Generated<number>;
  guildId: string;
  channelId: string;
  chatChannelId: string | null;
  roomData: JSONColumnType<ArchipelagoRoomData>;
  createdAt: ColumnType<Date, string | undefined, never>;
  expiredAt: ColumnType<Date | null, string | null, string | null>;
  // Per-receiver count of received items already broadcast to Discord, used for
  // reconnect catch-up. Nullable + optional on insert; written as a JSON string,
  // read back as a parsed object via ParseJSONResultsPlugin.
  progressCheckpoint: ColumnType<Record<number, number> | null, string | null | undefined, string | null>;
  // Player slot ids whose goal has already been announced, so a restart doesn't
  // re-announce them. Null = no baseline yet (first connect records silently).
  announcedGoals: ColumnType<number[] | null, string | null | undefined, string | null>;
}

export interface NotificationRequestsTable {
  id: Generated<number>;
  sessionId: number;
  discordId: string;
  targetPlayerSlotId: number;
  targetItemName: string;
  createdAt: ColumnType<Date, string | undefined, never>;
}

export interface DatabaseSchema {
  guild_settings: GuildSettingsTable;
  sessions: SessionsTable;
  notification_requests: NotificationRequestsTable;
}
