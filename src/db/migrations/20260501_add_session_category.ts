import { Kysely } from 'kysely'

export async function up (db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('guild_settings')
    .addColumn('sessionCategoryName', 'text', col => col.notNull().defaultTo('Sessions'))
    .execute()
}

export async function down (db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('guild_settings')
    .dropColumn('sessionCategoryName')
    .execute()
}
