import { ArchipelagoRoomData } from '../types/archipelago-types.js'
import { SessionOptions } from '../types/session-types.js'

export interface DBSession {
  id: number;
  guildId: string;
  channelId: string;
  chatChannelId: string | null;
  roomData: ArchipelagoRoomData;
  createdAt: Date;
  expiredAt: Date | null;
}

export interface GetSessionsOptions {
  includeExpired?: boolean;
}

export interface ISessionRepository {
  addSession(guildId: string, channelId: string, roomData: ArchipelagoRoomData): Promise<number>;
  removeSession(channelId: string): Promise<void>;
  removeSessionById(sessionId: number): Promise<void>;
  getSessions(options?: GetSessionsOptions): Promise<DBSession[]>;
  setSessionExpired(sessionId: number): Promise<void>;
  findSession(channelId: string): Promise<DBSession | null>;
  findSessionById(sessionId: number): Promise<DBSession | null>;
  updateChannelId(sessionId: number, channelId: string): Promise<void>;
  setChatChannelId(sessionId: number, chatChannelId: string): Promise<void>;
  /** Per-receiver count of received items already broadcast, used for reconnect
   *  catch-up. Returns null when no baseline has been established yet. */
  getProgressCheckpoint(sessionId: number): Promise<Record<number, number> | null>;
  setProgressCheckpoint(sessionId: number, checkpoint: Record<number, number>): Promise<void>;
  /** Slot ids whose goal has already been announced. Returns null when no goal
   *  baseline has been established yet. */
  getAnnouncedGoals(sessionId: number): Promise<number[] | null>;
  setAnnouncedGoals(sessionId: number, slotIds: number[]): Promise<void>;
}

export interface DBGuildSettings {
  guildId: string;
  logChannelId: string | null;
  commandPrefix: string;
  sessionCommandPrefix: string;
  sessionCategoryName: string;
  sessionOptions: SessionOptions;
  playerEmojis: Record<string, string>;
}

export interface IGuildSettingsRepository {
  getSettings(guildId: string): Promise<DBGuildSettings>;
  setPrefix(guildId: string, prefix: string): Promise<void>;
  setSessionPrefix(guildId: string, prefix: string): Promise<void>;
  setLogChannel(guildId: string, channelId: string): Promise<void>;
  setSessionOptions(guildId: string, sessionOptions: SessionOptions): Promise<void>;
  setPlayerEmojis(guildId: string, playerEmojis: Record<string, string>): Promise<void>;
  setSessionCategoryName(guildId: string, name: string): Promise<void>;
}

export interface DBNotificationRequest {
  id: number;
  sessionId: number;
  discordId: string;
  targetPlayerSlotId: number;
  targetItemName: string;
}

export interface INotificationRequestsRepository {
  addNotification(notification: Omit<DBNotificationRequest, 'id'>): Promise<number>;
  removeNotification(id: number): Promise<void>;
  getNotificationsForUser(sessionId: number, discordId: string): Promise<DBNotificationRequest[]>;
  findMatches(sessionId: number, slot: number, itemName: string): Promise<DBNotificationRequest[]>
}
