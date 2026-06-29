import { Kysely, Selectable } from 'kysely'

import { DatabaseSchema, SessionsTable } from '../schema.js'
import { DBSession, GetSessionsOptions, ISessionRepository } from '../interfaces.js'
import { ArchipelagoRoomData } from '../../types/archipelago-types.js'

export class SqliteSessionRepository implements ISessionRepository {
  constructor (private db: Kysely<DatabaseSchema>) { }

  #mapToDBSession (row: Selectable<SessionsTable>): DBSession {
    return {
      id: row.id,
      guildId: row.guildId,
      channelId: row.channelId,
      chatChannelId: row.chatChannelId ?? null,
      roomData: row.roomData,
      createdAt: row.createdAt,
      expiredAt: row.expiredAt,
    }
  }

  async addSession (guildId: string, channelId: string, roomData: ArchipelagoRoomData): Promise<number> {
    const result = await this.db
      .insertInto('sessions')
      .values({
        guildId,
        channelId,
        roomData: JSON.stringify(roomData),
        createdAt: new Date().toISOString(),
        expiredAt: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    return result.id
  }

  async removeSession (channelId: string): Promise<void> {
    await this.db
      .deleteFrom('sessions')
      .where('channelId', '=', channelId)
      .execute()
  }

  async removeSessionById (sessionId: number): Promise<void> {
    await this.db
      .deleteFrom('sessions')
      .where('id', '=', sessionId)
      .execute()
  }

  async setSessionExpired (sessionId: number): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ expiredAt: new Date().toISOString() })
      .where('id', '=', sessionId)
      .execute()
  }

  async findSession (channelId: string): Promise<DBSession | null> {
    const result = await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('channelId', '=', channelId)
      .executeTakeFirst()

    return result ? this.#mapToDBSession(result) : null
  }

  async findSessionById (sessionId: number): Promise<DBSession | null> {
    const result = await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .executeTakeFirst()

    return result ? this.#mapToDBSession(result) : null
  }

  async setChatChannelId (sessionId: number, chatChannelId: string): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ chatChannelId })
      .where('id', '=', sessionId)
      .execute()
  }

  async updateChannelId (sessionId: number, channelId: string): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ channelId })
      .where('id', '=', sessionId)
      .execute()
  }

  async getProgressCheckpoint (sessionId: number): Promise<Record<number, number> | null> {
    const row = await this.db
      .selectFrom('sessions')
      .select('progressCheckpoint')
      .where('id', '=', sessionId)
      .executeTakeFirst()
    // ParseJSONResultsPlugin parses the stored JSON string into an object on read.
    return row?.progressCheckpoint ?? null
  }

  async setProgressCheckpoint (sessionId: number, checkpoint: Record<number, number>): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ progressCheckpoint: JSON.stringify(checkpoint) })
      .where('id', '=', sessionId)
      .execute()
  }

  async getSessions (options: GetSessionsOptions = {}): Promise<DBSession[]> {
    let query = await this.db
      .selectFrom('sessions')
      .selectAll()

    if (!options.includeExpired) {
      query = query.where('expiredAt', 'is', null)
    }

    const results = await query.execute()
    return results.map(this.#mapToDBSession)
  }
}
