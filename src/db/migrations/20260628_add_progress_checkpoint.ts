import { Kysely } from 'kysely'

// Stores, per session, how many received items have already been broadcast to
// Discord for each receiving player slot (JSON: { slotId: count }). Used on
// reconnect to figure out which item sends were missed while the bot was
// offline and replay or summarize them. Nullable: existing/new sessions start
// with no checkpoint, and the first connect establishes the baseline.
export async function up (db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('sessions')
    .addColumn('progressCheckpoint', 'text')
    .execute()
}

export async function down (db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('sessions')
    .dropColumn('progressCheckpoint')
    .execute()
}
