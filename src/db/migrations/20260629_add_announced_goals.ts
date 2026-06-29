import { Kysely } from 'kysely'

// Stores, per session, the set of player slot ids whose goal has already been
// announced to Discord (JSON: number[]). The in-memory #goalCache resets on
// restart, so without this the missed-goal catch-up re-announces every
// already-goaled player on each successful reconnect. Nullable: a null value
// means no baseline yet, so the first connect records the current goals silently
// instead of announcing the entire backlog.
export async function up (db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('sessions')
    .addColumn('announcedGoals', 'text')
    .execute()
}

export async function down (db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('sessions')
    .dropColumn('announcedGoals')
    .execute()
}
