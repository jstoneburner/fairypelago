import { Item, Player } from 'archipelago.js'
import * as DC from 'discord.js'

import { ArchipelagoSession } from '../archipelago-session.js'
import { CatchUpResult, SessionLoginAttemptResult } from '../../types/session-types.js'

export interface IEventHandler {
  changeDiscordChannel: (channel: DC.TextChannel | DC.ThreadChannel) => void;
  sessionIdle: (session: ArchipelagoSession) => Promise<void>;
  sessionFailedAutojoin: (session: ArchipelagoSession, attemptResult: SessionLoginAttemptResult) => Promise<void>;
  /** willReconnect=true means an automatic retry is already scheduled; suppress the message. */
  socketDisconnected: (session: ArchipelagoSession, isFinished: boolean, willReconnect: boolean) => Promise<void>;
  /** isAutoReconnect=true means this was a silent background reconnect; suppress the message.
   *  missedGoalNames: players who reached their goal while the bot was offline (detected via webhost API on reconnect). */
  socketConnected: (session: ArchipelagoSession, isAutoReconnect: boolean, missedGoalNames?: string[]) => Promise<void>;
  /** Replays or summarizes item sends that were missed while the bot was offline,
   *  reconstructed by diffing the webhost tracker against the persisted checkpoint. */
  caughtUp: (session: ArchipelagoSession, result: CatchUpResult) => Promise<void>;
  /** Called when the session exhausts all automatic reconnect attempts. */
  reconnectFailed: (session: ArchipelagoSession) => Promise<void>;
  /** Called when a fresh webhost API fetch reveals a different port than the last known one. */
  portChanged: (session: ArchipelagoSession, oldPort: number, newPort: number) => Promise<void>;
  botShutdown: (session: ArchipelagoSession) => Promise<void>;
  adminCommand: (session: ArchipelagoSession, text: string) => Promise<void>;
  chat: (session: ArchipelagoSession, message: string, player: Player) => Promise<void>;
  collected: (session: ArchipelagoSession, text: string, player: Player) => Promise<void>;
  connected: (session: ArchipelagoSession, text: string, player: Player, tags: string[]) => Promise<void>;
  countdown: (session: ArchipelagoSession, text: string, value: number) => Promise<void>;
  disconnected: (session: ArchipelagoSession, text: string, player: Player) => Promise<void>;
  goaled: (session: ArchipelagoSession, text: string, player: Player) => Promise<void>;
  allGoaled: (session: ArchipelagoSession,) => Promise<void>;
  itemCheated: (session: ArchipelagoSession, text: string, item: Item) => Promise<void>;
  itemHinted: (session: ArchipelagoSession, text: string, item: Item) => Promise<void>;
  itemSent: (session: ArchipelagoSession, text: string, item: Item) => Promise<void>;
  released: (session: ArchipelagoSession, text: string, player: Player) => Promise<void>;
  serverChat: (session: ArchipelagoSession, message: string) => Promise<void>;
  tagsUpdated: (session: ArchipelagoSession, text: string, player: Player, tags: string[]) => Promise<void>;
  tutorial: (session: ArchipelagoSession, text: string) => Promise<void>;
  userCommand: (session: ArchipelagoSession, text: string) => Promise<void>;
}
