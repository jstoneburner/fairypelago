import 'dotenv/config'
import { Kysely, Migrator, FileMigrationProvider, ParseJSONResultsPlugin, SqliteDialect } from 'kysely'
import SQLite from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { DiscordClient } from './lib/discord-client.js'
import * as IconLookupTable from './lib/icon-lookup-table.js'
import { gameIcons, itemIcons, itemTierIcons } from './data/icons.js'
import { loadJobs, scheduleJobs } from './lib/jobs.js'
import { logger } from './lib/util/logger.js'
import { DatabaseSchema } from './db/schema.js'
import { SqliteGuildSettingRepository } from './db/repositories/sqlite-guild-setting-repository.js'
import { SqliteSessionRepository } from './db/repositories/sqlite-session-repository.js'
import { SessionOptionsProvider } from './lib/session-options-provider.js'
import { ArchipelagoSessionRegistry } from './lib/archipelago-session-registry.js'
import { SqliteNotificationRequestsRepository } from './db/repositories/sqlite-notification-requests-repository.js'

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN

async function main () {
  if (!DISCORD_BOT_TOKEN) {
    throw new Error('DISCORD_BOT_TOKEN missing from dotenv file')
  }

  const db = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: new SQLite('./storage/main.db'),
    }),
    plugins: [new ParseJSONResultsPlugin()],
  })

  // Bootstrap migration tracking if the database was manually initialized
  // (tables exist but Kysely's migration history doesn't). This prevents
  // the migrator from trying to re-create tables that already exist.
  const sqlite = (db.getExecutor() as any).adapter?.db as import('better-sqlite3').Database | undefined
  if (sqlite) {
    const hasMigrationTable = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='kysely_migration'",
    ).get()
    const hasSessionsTable = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
    ).get()

    if (!hasMigrationTable && hasSessionsTable) {
      logger.info('Bootstrapping migration tracking for pre-existing database')
      const migrations = await fs.readdir(path.join(import.meta.dirname, 'db/migrations'))
      const migrationNames = migrations
        .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
        .map(f => f.replace(/\.(ts|js)$/, ''))
        .sort()

      sqlite.exec(`
        CREATE TABLE kysely_migration (name TEXT PRIMARY KEY NOT NULL, timestamp TEXT NOT NULL);
        CREATE TABLE kysely_migration_lock (id TEXT PRIMARY KEY NOT NULL, is_locked INTEGER NOT NULL DEFAULT 0);
        INSERT INTO kysely_migration_lock (id, is_locked) VALUES ('migration_lock', 0);
      `)
      const insertMigration = sqlite.prepare(
        'INSERT INTO kysely_migration (name, timestamp) VALUES (?, ?)',
      )
      for (const name of migrationNames) {
        insertMigration.run(name, new Date().toISOString())
        logger.info(`Marked migration as already applied: ${name}`)
      }
    }
  }

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(import.meta.dirname, 'db/migrations'),
    }),
  })

  const { error: migrationError, results: migrationResults } = await migrator.migrateToLatest()
  for (const result of migrationResults ?? []) {
    if (result.status === 'Success') {
      logger.info(`Migration applied: ${result.migrationName}`)
    } else if (result.status === 'Error') {
      logger.error(`Migration failed: ${result.migrationName}`)
    }
  }
  if (migrationError) throw migrationError

  const sessionRepo = new SqliteSessionRepository(db)
  const settingsRepo = new SqliteGuildSettingRepository(db)
  const notificationRequestsRepo = new SqliteNotificationRequestsRepository(db)

  const optionsProvider = new SessionOptionsProvider(sessionRepo, settingsRepo)
  const sessionRegistry = new ArchipelagoSessionRegistry(
    sessionRepo, settingsRepo, notificationRequestsRepo, optionsProvider,
  )

  const discordClient = new DiscordClient(
    sessionRegistry, sessionRepo, settingsRepo, notificationRequestsRepo, optionsProvider,
  )
  discordClient.registerListeners()
  await discordClient.login(DISCORD_BOT_TOKEN)

  await IconLookupTable.fetchApplicationEmojis(discordClient.client)
  IconLookupTable.populateGameIcons(gameIcons)
  IconLookupTable.populateItemIcons(itemIcons)
  IconLookupTable.populateItemTierIcons(itemTierIcons)

  await loadJobs()
  scheduleJobs(sessionRegistry, discordClient.client)

  process.on('SIGINT', () => {
    Promise.all(sessionRegistry.getAllSessions().map(session => session.dispose())).finally(() => process.exit(0))
  })
  process.on('SIGTERM', () => {
    Promise.all(sessionRegistry.getAllSessions().map(session => session.dispose())).finally(() => process.exit(0))
  })
}

main().catch((err) => {
  console.error('Fatal error during setup:', err)
  logger.error('Fatal error during setup', { error: err })
  logger.on('finish', () => process.exit(1))
  logger.end()
})
