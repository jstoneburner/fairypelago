import { ArchipelagoMessageType } from './archipelago-types.js'
import { ItemTier } from '../types/icon-types.js'

export type SessionPlayerStatus =
  'Unknown' | 'Connected' | 'Ready' | 'Playing' | 'Goaled'

export interface SessionOptions {
  whitelistedMessageTypes: ArchipelagoMessageType[]
  enablePlayerIcons: boolean;
  enableGameIcons: boolean;
  enableItemIcons: boolean;
  enableAutojoin: boolean;
  hideFoundHints: boolean;
}

// Fields which will not change from the initial webhost api fetch
export interface SessionStaticState {
  trackerId: string
  players: {
    slotId: number,
    slotName: string,
    game: {
      name: string,
      totalLocations: number,
    },
    team: number,
    download: string | null,
  }[],
}

export interface SessionItemReceived {
  name: string,
  location: string,
  sender: string,
  tiers: ItemTier[],
}

// A single missed item send to replay on reconnect catch-up.
export interface CaughtUpItem {
  item: SessionItemReceived,
  receiver: string,
}

// Result of diffing the webhost tracker against the persisted checkpoint on
// reconnect. 'replay' lists each missed send (small gap); 'summary' rolls them
// up by receiver (large gap). A gap of zero produces neither (no message sent).
export type CatchUpResult =
  | { mode: 'replay', items: CaughtUpItem[] }
  | { mode: 'summary', totalItems: number, byReceiver: { receiver: string, count: number }[] }

export interface SessionStatus {
  port: number,
  lastRoomActivity: Date,
  lastPlayerActivity: Record<number, Date | null>,
  lastPlayerConnection: Record<number, Date | null>,
  checksDone: Record<number, string[]>
  itemsReceived: Record<number, SessionItemReceived[]>
  aliases: Record<number, string | null>,
  playerStatus: Record<number, SessionPlayerStatus>,
}

export interface SessionHintingInfo {
  vesselName: string,
  hintCost: number,
  hintCostPercentage: number,
  hintPoints: number,
}

export enum SessionLoginAttemptResult {
  Success,
  ServerDown,
  PlayerNotFound,
  PasswordIncorrect,
  Unknown,
}
