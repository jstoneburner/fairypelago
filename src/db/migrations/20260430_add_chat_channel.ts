import { Kysely } from 'kysely'

export async function up (db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('sessions')
    .addColumn('chatChannelId', 'text')
    .execute()
}

export async function down (db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('sessions')
    .dropColumn('chatChannelId')
    .execute()
}
