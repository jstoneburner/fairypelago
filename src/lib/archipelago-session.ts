import { Client as ArchipelagoClient, LoginError } from 'archipelago.js'

import { ArchipelagoMessageType, type ArchipelagoRoomData } from '../types/archipelago-types.js'
import { catchAndLogError } from './util/general.js'
import { logger } from './util/logger.js'
import { IEventHandler } from './interfaces/event-handler.js'
import { IOptionsProvider } from './interfaces/options-provider.js'
import { ISessionRepository } from '../db/interfaces.js'
import { ArchipelagoWebhostClient, WebhostInitialSessionData, WebhostSessionStatus } from './archipelago-webhost-client.js'
import { ItemTier } from '../types/icon-types.js'
import { TTLCache } from './util/ttl-cache.js'
import { SessionStaticState, SessionHintingInfo, SessionItemReceived, SessionStatus, SessionLoginAttemptResult, CaughtUpItem } from '../types/session-types.js'

interface SessionVesselChange {
  isInTransition: boolean,
  prevVesselName: string | null,
}

export interface SessionDeps {
  eventHandler: IEventHandler;
  optionsProvider: IOptionsProvider;
  sessionRepo: ISessionRepository;
}

function extractToStaticState (initialData: WebhostInitialSessionData): SessionStaticState {
  return {
    trackerId: initialData.trackerId,
    players: initialData.players.map(player => ({
      slotId: player.slotId,
      slotName: player.slotName,
      download: player.download,
      team: player.team,
      game: {
        name: player.game,
        totalLocations: initialData.games.find(game => game.slotId === player.slotId)?.totalLocations ?? 0,
      },
    })),
  }
}

function parseNetworkItemFlags (flags: number): ItemTier[] {
  const tiers: ItemTier[] = []
  if (flags & 0b001) tiers.push('progression')
  if (flags & 0b010) tiers.push('useful')
  if (flags & 0b100) tiers.push('trap')
  if (flags === 0) tiers.push('filler')
  return tiers
}

function extractToSessionStatus (client: ArchipelagoClient, staticState: SessionStaticState, data: WebhostSessionStatus): SessionStatus {
  const checksDone: Record<number, string[]> = {}
  for (const [_slotId, locationIds] of Object.entries(data.checksDone)) {
    const slotId = Number.parseInt(_slotId)
    const gameName = staticState.players.find(p => p.slotId === slotId)?.game.name ?? ''
    checksDone[slotId] = []
    for (const locationId of locationIds) {
      const locationName = client.package.lookupLocationName(gameName, locationId)
      checksDone[slotId].push(locationName)
    }
  }
  const itemsReceived: Record<number, SessionItemReceived[]> = {}
  for (const [_slotId, networkItems] of Object.entries(data.itemsReceived)) {
    const slotId = Number.parseInt(_slotId)
    const items = networkItems.map<SessionItemReceived>(nItem => {
      const senderData = staticState.players.find(p => p.slotId === nItem.player)
      const senderName = senderData?.slotName ?? 'Unknown'
      const senderGame = senderData?.game.name ?? ''
      return {
        name: client.package.lookupItemName(senderGame, nItem.item),
        location: client.package.lookupLocationName(senderGame, nItem.location),
        sender: senderName,
        tiers: parseNetworkItemFlags(nItem.flags),
      }
    })

    itemsReceived[slotId] = items
  }
  return {
    port: data.port,
    lastRoomActivity: data.lastRoomActivity,
    lastPlayerActivity: data.lastPlayerActivity,
    lastPlayerConnection: data.lastPlayerConnection,
    checksDone,
    itemsReceived,
    aliases: data.aliases,
    playerStatus: data.playerStatus,
  }
}

export class ArchipelagoSession {
  readonly #sessionId: number
  #client: ArchipelagoClient
  #webhostClient: ArchipelagoWebhostClient
  #roomData: ArchipelagoRoomData
  #eventHandler: IEventHandler
  #optionsProvider: IOptionsProvider
  #sessionRepo: ISessionRepository
  #staticState: SessionStaticState
  #isFinished = false
  #isDisposed = false

  // Calls to current status endpoint are cached due to long overhead
  // Inflight prevents duplicate calls while waiting on the network for the first call
  #dynamicStateCache = new TTLCache<SessionStatus>(20000)
  #inflightStatusFetch: Promise<SessionStatus | null> | null = null

  #prevVesselChange: SessionVesselChange = {
    isInTransition: false,
    prevVesselName: null,
  }

  // Saved credentials for automatic reconnection after unexpected disconnects
  #lastVesselName: string | null = null
  #lastPassword: string | undefined = undefined
  // Last successfully fetched port — used as fallback when the webhost API is unreachable
  #lastKnownPort: number | null = null

  // Tracks recent goals by slotId to prevent item release spam
  #goalCache = new Set<number>()

  // Whether a goal baseline has been persisted for this session. Seeded from the
  // DB in makeSession. While false (no baseline yet), the first successful
  // connect records the currently-goaled players silently instead of announcing
  // them all as "missed" — without this, every restart re-announces every goal
  // because #goalCache starts empty in memory.
  #hasPersistedGoalBaseline = false

  // Per-receiver count of received items already accounted for (broadcast or
  // filtered). Seeded from the persisted checkpoint on connect and incremented
  // per live itemSent, so a reconnect can diff it against the webhost tracker to
  // find what was missed while offline. Kept aligned with the tracker's
  // append-ordered itemsReceived list.
  #broadcastCounts: Record<number, number> = {}

  // Guards against reconnect loops caused by archipelago.js's socket.connect() always
  // calling disconnect() first, which emits 'disconnected' and triggers #scheduleReconnect.
  // Set to true for the entire duration of any login attempt so that 'disconnected' events
  // fired by connect() itself are ignored.
  #isLoggingIn = false

  // Prevents concurrent start() calls (e.g. startup autojoin racing with a queued >connect
  // Discord message). Without this, two concurrent #client.login() calls on the same socket
  // tear each other down. #scheduleReconnect bypasses this by calling #attemptLoginAsPlayer
  // directly, so reconnects are never blocked.
  #startInProgress = false

  // Incremented whenever a user-initiated start() call begins, so that any previously
  // queued #scheduleReconnect callbacks know they've been superseded and should exit.
  #reconnectGeneration = 0

  private constructor (
    sessionId: number,
    client: ArchipelagoClient,
    webhostClient: ArchipelagoWebhostClient,
    roomData: ArchipelagoRoomData,
    staticState: SessionStaticState,
    deps: SessionDeps,
  ) {
    this.#sessionId = sessionId
    this.#client = client
    this.#webhostClient = webhostClient
    this.#roomData = roomData
    this.#staticState = staticState
    this.#eventHandler = deps.eventHandler
    this.#optionsProvider = deps.optionsProvider
    this.#sessionRepo = deps.sessionRepo
  }

  static async makeSession (
    sessionId: number,
    roomData: ArchipelagoRoomData,
    deps: SessionDeps,
  ) {
    // Disable autoFetchDataPackage: in AP 0.6.x the server requires Connect
    // to arrive before any GetDataPackage requests; fetching first causes the
    // server to send InvalidPacket when Connect finally arrives. We fetch
    // manually after successful login instead.
    const client = new ArchipelagoClient({ autoFetchDataPackage: false })
    const webhostClient = new ArchipelagoWebhostClient(roomData.domain)
    const initialSessionData = await webhostClient.fetchInitialSessionData(roomData.roomId)
    if (!initialSessionData) return null
    const staticState = extractToStaticState(initialSessionData)

    const session = new this(sessionId, client, webhostClient, roomData, staticState, deps)
    session.attachListeners()
    // Seed the goal baseline from the DB so already-announced goals aren't
    // re-announced after a restart (the in-memory #goalCache starts empty).
    const announcedGoals = await deps.sessionRepo.getAnnouncedGoals(sessionId)
    if (announcedGoals) {
      for (const slotId of announcedGoals) session.#goalCache.add(slotId)
      session.#hasPersistedGoalBaseline = true
    }
    return session
  }

  // Attempt to login to the session if a slotName/password is given
  // If not, attempt to start under any account if autojoin is enabled,
  // otherwise fire session idle event
  async start (slotName?: string, password?: string) {
    if (this.#startInProgress) {
      logger.warn('start() called while login already in progress, ignoring', { sessionId: this.#sessionId })
      return
    }
    this.#startInProgress = true
    try {
      return await this.#doStart(slotName, password)
    } finally {
      this.#startInProgress = false
    }
  }

  async #doStart (slotName?: string, password?: string) {
    // Bump the generation so any previously scheduled reconnect callbacks abort.
    this.#reconnectGeneration++
    if (slotName) {
      return this.#attemptLoginAsPlayer(slotName, password)
    }
    const sessionOptions = await this.#optionsProvider.getOptionsBySessionId(this.#sessionId)
    if (sessionOptions.enableAutojoin) {
      const attemptResult = await this.#attemptAutojoin()
      if (attemptResult !== SessionLoginAttemptResult.Success) {
        await this.#eventHandler.sessionFailedAutojoin(this, attemptResult)
        // A cold-start autojoin that fails because the room is unreachable
        // (ServerDown) never opens a socket, so the 'disconnected' handler never
        // fires and no reconnect is ever scheduled — the bot would sit idle
        // forever (e.g. it restarts during a power outage while the room is
        // momentarily down). Kick off the reconnect loop so it keeps retrying
        // until the room comes back. Other failures (PlayerNotFound, etc.) are
        // not retryable, so only do this for ServerDown.
        if (attemptResult === SessionLoginAttemptResult.ServerDown) {
          void this.#scheduleReconnect(1, this.#reconnectGeneration)
        }
      }
    } else {
      await this.#eventHandler.sessionIdle(this)
    }
  }

  async #attemptAutojoin (): Promise<SessionLoginAttemptResult> {
    for (const player of this.#staticState.players) {
      const attemptResult = await this.#attemptLoginAsPlayer(player.slotName)
      if (attemptResult === SessionLoginAttemptResult.PasswordIncorrect) {
        continue
      } else if (attemptResult === SessionLoginAttemptResult.Success) {
        return SessionLoginAttemptResult.Success
      } else {
        return attemptResult
      }
    }
    return SessionLoginAttemptResult.PasswordIncorrect
  }

  async #attemptLoginAsPlayer (slotName: string, password?: string, isAutoReconnect = false): Promise<SessionLoginAttemptResult> {
    // While a login is in progress, the 'disconnected' event handler must be a no-op.
    // archipelago.js's socket.connect() always calls disconnect() first, which emits
    // 'disconnected'. Without this guard that emission triggers #scheduleReconnect,
    // which then fires 1 s later and tears down the connection we just established.
    this.#isLoggingIn = true
    try {
      // Snapshot the goal cache before fetching fresh status. After login we'll diff
      // against the new cache to find players who goaled while the bot was offline.
      const previouslyGoaled = new Set(this.#goalCache)

      const sessionStatus = await this.getCurrentStatus()

      // Cache the port whenever we get a fresh status, so we can fall back to it
      // if the webhost API is temporarily unavailable.
      if (sessionStatus) {
        if (this.#lastKnownPort !== null && this.#lastKnownPort !== sessionStatus.port) {
          await this.#eventHandler.portChanged(this, this.#lastKnownPort, sessionStatus.port)
        }
        this.#lastKnownPort = sessionStatus.port
      }

      const port = sessionStatus?.port ?? this.#lastKnownPort
      if (!port) {
        logger.warn(
          'Failed to get session status and no cached port available',
          { roomId: this.#roomData.roomId, sessionId: this.#sessionId, vessel: slotName, hasPassword: !!password },
        )
        return SessionLoginAttemptResult.ServerDown
      }

      if (!sessionStatus) {
        logger.warn(
          'Webhost API unavailable — attempting connect with last known port',
          { roomId: this.#roomData.roomId, sessionId: this.#sessionId, vessel: slotName, port },
        )
      }

      if (!this.#staticState.players.map(player => player.slotName).includes(slotName)) {
        return SessionLoginAttemptResult.PlayerNotFound
      }
      try {
        const url = `${this.#roomData.domain}:${port}`
        // Pass the actual game name for this slot (AP 0.6.x validates this field).
        const gameName = this.#staticState.players.find(p => p.slotName === slotName)?.game.name ?? ''
        // For TextOnly/Tracker clients, items_handling must be 0 (minimal) — the bot
        // is an observer and does not receive or track items.
        // Also never pass password: undefined — that overrides the default '' and omits
        // the field from the JSON packet entirely; use '' when no password is provided.
        const loginOptions = {
          tags: ['Discord', 'Tracker', 'TextOnly'] as string[],
          items: 0,
          password: password ?? '',
        }
        logger.info('Attempting AP login', {
          sessionId: this.#sessionId,
          url,
          vessel: slotName,
          gameName,
          items: loginOptions.items,
          hasPassword: !!password,
        })
        await this.#client.login(url, slotName, gameName, loginOptions)
        logger.info('Started websocket connection to AP server', {
          sessionId: this.#sessionId,
          vessel: slotName,
          hasPassword: !!password,
          url,
        })

        // Save credentials so the reconnect logic can restore the connection
        this.#lastVesselName = slotName
        this.#lastPassword = password

        // Populate data package cache with current game packages
        // for item name lookup in the status to work
        await this.getDataPackage()

        // Compute which players goaled while the bot was offline (newly added to
        // #goalCache by getCurrentStatus() vs. what was already cached before this attempt).
        const missedGoalNames = [...this.#goalCache]
          .filter(slotId => !previouslyGoaled.has(slotId))
          .map(slotId => this.#staticState.players.find(p => p.slotId === slotId)?.slotName ?? `Slot ${slotId}`)

        this.#isLoggingIn = false
        // Only announce missed goals once a baseline exists. On the very first
        // connect (no baseline — new session, or first run after this shipped),
        // the current goals ARE the baseline, so stay silent to avoid announcing
        // the entire backlog. Subsequent connects announce only newly-goaled.
        const goalNamesToAnnounce = this.#hasPersistedGoalBaseline && missedGoalNames.length > 0
          ? missedGoalNames
          : undefined
        await this.#eventHandler.socketConnected(this, isAutoReconnect, goalNamesToAnnounce)
        // Persist the current goaled set so these are never re-announced after a
        // restart, and so a baseline now exists for future diffs.
        this.#hasPersistedGoalBaseline = true
        await this.#persistAnnouncedGoals()
        // Reconcile against the webhost tracker and replay/summarize any item
        // sends missed while the bot was offline. Runs after socketConnected so
        // catch-up appears below the "reconnected"/missed-goal messages.
        await this.#catchUpMissedItems()
        return SessionLoginAttemptResult.Success
      } catch (err) {
        if (err instanceof LoginError) {
          logger.warn('Login refused by AP server', {
            sessionId: this.#sessionId,
            vessel: slotName,
            hasPassword: !!password,
            reasons: err.errors,
          })
          // InvalidSlot means the server we reached has no slot by this name —
          // almost always because the room spun down and its port was recycled to
          // a different room. Treat it as retryable (ServerDown) and invalidate the
          // port cache so the next attempt re-fetches the room's real current port
          // once it comes back up. A genuine auth failure (InvalidPassword) is not
          // retryable and stays PasswordIncorrect so >connect can prompt for one.
          if (Array.isArray(err.errors) && err.errors.includes('InvalidSlot')) {
            this.#dynamicStateCache.invalidate()
            return SessionLoginAttemptResult.ServerDown
          }
          return SessionLoginAttemptResult.PasswordIncorrect
        }
        // Invalidate the status cache so the next reconnect attempt re-fetches the
        // port from the webhost API — the server may have restarted on a new port.
        this.#dynamicStateCache.invalidate()
        logger.warn('Failed to login to archipelago session', { error: err, sessionId: this.#sessionId, vessel: slotName, hasPassword: !!password })
        return SessionLoginAttemptResult.ServerDown
      }
    } finally {
      this.#isLoggingIn = false
    }
  }

  async changeVessel (slotName: string) {
    const currentVessel = this.getCurrentVessel()
    if (slotName === currentVessel) {
      return false
    }
    const isExistingPlayer = this.#staticState.players.find(p => p.slotName === slotName)
    if (!isExistingPlayer) {
      return false
    }
    const sessionStatus = await this.getCurrentStatus()
    if (!sessionStatus) {
      logger.warn(
        'Failed to get session status when changing vessels',
        { roomId: this.#roomData.roomId, sessionId: this.#sessionId },
      )
      return false
    }
    const newClient = new ArchipelagoClient({ autoFetchDataPackage: false })
    try {
      const gameName = this.#staticState.players.find(p => p.slotName === slotName)?.game.name ?? ''
      await newClient.login(
        `${this.#roomData.domain}:${sessionStatus.port}`,
        slotName,
        gameName,
        { tags: ['Discord', 'Tracker', 'TextOnly'] },
      )
      const oldClient = this.#client
      this.#prevVesselChange = {
        isInTransition: true,
        prevVesselName: currentVessel,
      }
      oldClient.socket.disconnect()
      this.#client = newClient
      this.attachListeners()

      logger.info('Successfully changed vessel', {
        sessionId: this.#sessionId,
        oldVessel: currentVessel,
        newVessel: slotName,
      })
      return true
    } catch (err) {
      logger.warn('Failed to change vessel', {
        sessionId: this.#sessionId,
        oldVessel: currentVessel,
        newVessel: slotName,
        error: err,
      })
      return false
    }
  }

  async dispose () {
    this.#isDisposed = true
    if (this.isSocketConnected) {
      await this.#eventHandler.botShutdown(this)
    }
  }

  changeDiscordChannel (channel: import('discord.js').TextChannel | import('discord.js').ThreadChannel) {
    this.#eventHandler.changeDiscordChannel(channel)
  }

  async #scheduleReconnect (attempt: number, generation: number): Promise<void> {
    // Note: no #lastVesselName guard here — a cold-start reconnect (room down at
    // launch) has no known vessel yet and falls back to autojoin below. Callers
    // that should only reconnect an established session (the 'disconnected'
    // handler) gate on #lastVesselName themselves.
    if (this.#isDisposed || this.#isFinished) return
    // A newer start() call or login attempt has superseded this reconnect chain.
    if (generation !== this.#reconnectGeneration) return

    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5 * 60 * 1000)

    // Attempt 9 is the first time the delay is capped at 5 minutes, meaning the
    // initial exponential backoff window has been exhausted. Notify the channel
    // once so users know the server appears down, but continue retrying every
    // 5 minutes indefinitely — no manual intervention required.
    if (attempt === 9) {
      logger.warn('AP reconnect backoff capped — server appears down, will keep retrying every 5 minutes', { sessionId: this.#sessionId })
      await this.#eventHandler.reconnectFailed(this)
    }

    logger.info('Scheduling AP reconnect', { sessionId: this.#sessionId, attempt, delayMs })
    await new Promise<void>(resolve => setTimeout(resolve, delayMs))
    if (this.#isDisposed || this.#isFinished) return
    if (generation !== this.#reconnectGeneration) return

    const vessel = this.#lastVesselName
    logger.info('Attempting AP reconnect', { sessionId: this.#sessionId, attempt, vessel: vessel ?? '(autojoin)' })
    // If we have a known-good vessel, reconnect as it; otherwise this is a
    // cold-start retry, so re-run autojoin to find a joinable slot.
    const result = vessel
      ? await this.#attemptLoginAsPlayer(vessel, this.#lastPassword, true)
      : await this.#attemptAutojoin()
    if (result !== SessionLoginAttemptResult.Success) {
      logger.warn('AP reconnect attempt failed', { sessionId: this.#sessionId, attempt, result })
      await this.#scheduleReconnect(attempt + 1, generation)
    }
  }

  async getCurrentStatus () {
    const cached = this.#dynamicStateCache.get()
    if (cached) return cached

    if (this.#inflightStatusFetch) {
      return this.#inflightStatusFetch
    }

    this.#inflightStatusFetch = (async () => {
      try {
        const status = await this.#webhostClient.fetchSessionStatus(this.#roomData.roomId)
        if (!status) return null

        // No data-package fetch here: the socket may not be authenticated yet when
        // getCurrentStatus() is called (it runs before login() to discover the port).
        // Game packages are fetched in #attemptLoginAsPlayer after a successful login.

        const finalStatus = extractToSessionStatus(this.#client, this.#staticState, status)
        this.#dynamicStateCache.set(finalStatus)
        Object.entries(finalStatus.playerStatus).forEach(([slotId, sessionStatus]) => {
          if (sessionStatus === 'Goaled') {
            this.#goalCache.add(Number.parseInt(slotId))
          }
        })
        return finalStatus
      } finally {
        this.#inflightStatusFetch = null
      }
    })()

    return this.#inflightStatusFetch
  }

  // Fetches player hints. If null, slotName likely doesn't exist
  async getPlayerHints (slotName: string) {
    const slotId = this.#staticState.players.find(p => p.slotName === slotName)?.slotId
    if (!slotId) return null
    const player = this.#client.players.findPlayer(slotId)
    // Shouldn't happen but in case staticState and websocket state is desynced
    if (!player) return null
    const hints = await player.fetchHints()
    const { hideFoundHints } = await this.#optionsProvider.getOptionsBySessionId(this.#sessionId)
    if (hideFoundHints) {
      return hints.filter(hint => !hint.found)
    }
    return hints
  }

  // Returns hinting info ONLY for the current vessel
  async getHintingInfo (): Promise<SessionHintingInfo | null> {
    const currentVessel = this.getCurrentVessel()
    if (!currentVessel) return null
    return {
      vesselName: currentVessel,
      hintCost: this.#client.room.hintCost,
      hintCostPercentage: this.#client.room.hintCostPercentage,
      hintPoints: this.#client.room.hintPoints,
    }
  }

  // Fetches game data packages (item/location name tables) via the WebSocket.
  // Delegates directly to archipelago.js which compares server checksums against
  // what is already cached and only requests what's actually missing — so calling
  // this after every successful login is safe and efficient.
  // NOTE: the pre-loaded "Archipelago" package always makes exportPackage() return
  // a non-empty object, so the old "length <= 0" guard was always skipping the fetch.
  async getDataPackage (games?: string[]) {
    return await this.#client.package.fetchPackage(games)
  }

  getCurrentVessel () {
    if (!this.isSocketConnected) return null
    return this.#client.name
  }

  get staticState () {
    return this.#staticState
  }

  get roomData () {
    return this.#roomData
  }

  get sessionId () {
    return this.#sessionId
  }

  get isSocketConnected () {
    return this.#client.socket.connected
  }

  // Current cache of goaled players
  // This cache is updated on bot connect and during a goal event emit
  // and thus might be inaccurate when the bot is not connected
  get goalCache () {
    return this.#goalCache
  }

  async sendMessage (message: string) {
    if (this.isSocketConnected) {
      await this.#client.messages.say(message)
    }
  }

  async #isWhitelisted (msgType: ArchipelagoMessageType) {
    const options = await this.#optionsProvider.getOptionsBySessionId(this.#sessionId)
    return options.whitelistedMessageTypes.includes(msgType)
  }

  async #emitEventIfEveryoneGoaled () {
    if (this.#isFinished) return
    // Cache is cheaper to check but may not be accurate if the bot restarts during a session
    if (this.#goalCache.size === this.#staticState.players.length) {
      this.#isFinished = true
      await this.#eventHandler.allGoaled(this)
      return
    }
    const status = await this.getCurrentStatus()
    if (status && Object.values(status?.playerStatus).every(s => s === 'Goaled')) {
      this.#isFinished = true
      await this.#eventHandler.allGoaled(this)
    }
  }

  // Diff the webhost tracker against the persisted checkpoint to find item sends
  // that happened while the bot was offline, then replay (small gap) or
  // summarize (large gap) them and advance the checkpoint.
  async #catchUpMissedItems () {
    try {
      // Re-fetch status with the data package now loaded so item/location names
      // resolve — the pre-login fetch runs before the package is available.
      this.#dynamicStateCache.invalidate()
      const status = await this.getCurrentStatus()
      if (!status) return

      // Current per-receiver received counts = server truth.
      const currentCounts: Record<number, number> = {}
      for (const player of this.#staticState.players) {
        currentCounts[player.slotId] = (status.itemsReceived[player.slotId] ?? []).length
      }

      const saved = await this.#sessionRepo.getProgressCheckpoint(this.#sessionId)

      // First connect for this session: establish the baseline, don't replay the
      // entire pre-existing history into the channel.
      if (!saved) {
        this.#broadcastCounts = { ...currentCounts }
        await this.#persistCheckpoint()
        return
      }

      const options = await this.#optionsProvider.getOptionsBySessionId(this.#sessionId)
      const whitelist = new Set(options.whitelistedMessageTypes)
      const slotIdByName = new Map(this.#staticState.players.map(p => [p.slotName, p.slotId]))

      const missed: CaughtUpItem[] = []
      for (const player of this.#staticState.players) {
        const items = status.itemsReceived[player.slotId] ?? []
        const from = saved[player.slotId] ?? 0
        if (items.length <= from) continue
        // Skip everything for a receiver who has goaled (mirrors the live filter).
        if (this.#goalCache.has(player.slotId)) continue
        for (const item of items.slice(from)) {
          if (!this.#isCaughtUpItemDisplayable(item, whitelist, slotIdByName)) continue
          missed.push({ item, receiver: player.slotName })
        }
      }

      // Advance the checkpoint to current truth regardless of how many we display,
      // so filtered/skipped items don't resurface on the next reconnect.
      this.#broadcastCounts = { ...currentCounts }
      await this.#persistCheckpoint()

      if (missed.length === 0) return

      const CATCH_UP_REPLAY_THRESHOLD = 20
      if (missed.length <= CATCH_UP_REPLAY_THRESHOLD) {
        await this.#eventHandler.caughtUp(this, { mode: 'replay', items: missed })
      } else {
        const counts = new Map<string, number>()
        for (const { receiver } of missed) counts.set(receiver, (counts.get(receiver) ?? 0) + 1)
        const byReceiver = [...counts.entries()].map(([receiver, count]) => ({ receiver, count }))
        await this.#eventHandler.caughtUp(this, { mode: 'summary', totalItems: missed.length, byReceiver })
      }
    } catch (err) {
      logger.warn('Catch-up reconciliation failed', { sessionId: this.#sessionId, error: err })
    }
  }

  // Mirrors the live itemSent filter in attachListeners so catch-up shows exactly
  // what the live path would have: a goaled sender's non-progression items are
  // suppressed, and each item tier must be whitelisted.
  #isCaughtUpItemDisplayable (item: SessionItemReceived, whitelist: Set<ArchipelagoMessageType>, slotIdByName: Map<string, number>): boolean {
    const { tiers } = item
    const prog = tiers.includes('progression')
    const useful = tiers.includes('useful')
    const filler = tiers.includes('filler')
    const trap = tiers.includes('trap')
    const senderSlot = slotIdByName.get(item.sender)
    if (senderSlot !== undefined && this.#goalCache.has(senderSlot) && !prog) return false
    if (prog && !whitelist.has(ArchipelagoMessageType.ItemSentProgression)) return false
    if (useful && !prog && !whitelist.has(ArchipelagoMessageType.ItemSentUseful)) return false
    if (filler && !whitelist.has(ArchipelagoMessageType.ItemSentFiller)) return false
    if (trap && !whitelist.has(ArchipelagoMessageType.ItemSentTrap)) return false
    return true
  }

  async #persistCheckpoint () {
    try {
      await this.#sessionRepo.setProgressCheckpoint(this.#sessionId, this.#broadcastCounts)
    } catch (err) {
      logger.warn('Failed to persist catch-up checkpoint', { sessionId: this.#sessionId, error: err })
    }
  }

  async #persistAnnouncedGoals () {
    try {
      await this.#sessionRepo.setAnnouncedGoals(this.#sessionId, [...this.#goalCache])
    } catch (err) {
      logger.warn('Failed to persist announced goals', { sessionId: this.#sessionId, error: err })
    }
  }

  attachListeners () {
    this.#client.socket.on('disconnected', async () => {
      // Ignore disconnects that are a direct side-effect of our own login calls.
      // archipelago.js calls socket.disconnect() at the start of every connect(),
      // which would otherwise trigger a spurious reconnect loop.
      if (this.#isLoggingIn) return
      if (this.#prevVesselChange.isInTransition) {
        this.#prevVesselChange.isInTransition = false
      } else {
        await this.#emitEventIfEveryoneGoaled()
        const willReconnect = !this.#isFinished && !this.#isDisposed && !!this.#lastVesselName
        await this.#eventHandler.socketDisconnected(this, this.#isFinished, willReconnect)
        if (willReconnect) {
          // Capture current generation so this reconnect chain can be cancelled
          // if start() is called again before it completes.
          const generation = this.#reconnectGeneration
          void this.#scheduleReconnect(1, generation)
        }
      }
    })

    this.#client.socket.on('invalidPacket', (packet) => {
      logger.warn('AP Websocket received invalid packet.', {
        sessionId: this.#sessionId, packetType: packet.type, packetText: packet.text,
      })
    })

    this.#client.messages.on('connected', catchAndLogError(async (text, player, tags) => {
      if (!await this.#isWhitelisted(ArchipelagoMessageType.Connected)) return
      logger.info('Player has connected to a session', { sessionId: this.#sessionId, slotName: player.name })
      await this.#emitEventIfEveryoneGoaled()
      await this.#eventHandler.connected(this, text, player, tags)
    }))

    this.#client.messages.on('disconnected', catchAndLogError(async (text, player) => {
      if (!await this.#isWhitelisted(ArchipelagoMessageType.Disconnected)) return
      if (this.#prevVesselChange.prevVesselName === player.name) {
        this.#prevVesselChange.prevVesselName = null
        return
      }
      logger.info('Player has disconnected from a session', { sessionId: this.#sessionId, slotName: player.name })
      await this.#emitEventIfEveryoneGoaled()
      await this.#eventHandler.disconnected(this, text, player)
    }))

    this.#client.messages.on('itemSent', catchAndLogError(async (text, item) => {
      // Account for every received item before any display filtering, so the
      // persisted catch-up baseline stays aligned with the server's record even
      // for items we don't post (filtered/goaled). Persisted fire-and-forget.
      this.#broadcastCounts[item.receiver.slot] = (this.#broadcastCounts[item.receiver.slot] ?? 0) + 1
      void this.#persistCheckpoint()
      if (this.#goalCache.has(item.sender.slot) && !item.progression) return
      if (this.#goalCache.has(item.receiver.slot)) return
      if (item.progression && !await this.#isWhitelisted(ArchipelagoMessageType.ItemSentProgression)) return
      if (item.useful && !item.progression && !await this.#isWhitelisted(ArchipelagoMessageType.ItemSentUseful)) return
      if (item.filler && !await this.#isWhitelisted(ArchipelagoMessageType.ItemSentFiller)) return
      if (item.trap && !await this.#isWhitelisted(ArchipelagoMessageType.ItemSentTrap)) return
      await this.#eventHandler.itemSent(this, text, item)
    }))

    this.#client.messages.on('itemHinted', catchAndLogError(async (text, item) => {
      if (!this.#isWhitelisted(ArchipelagoMessageType.ItemHinted)) return
      const options = await this.#optionsProvider.getOptionsBySessionId(this.#sessionId)
      if (options.hideFoundHints && text.includes('(found)')) return
      await this.#eventHandler.itemHinted(this, text, item)
    }))

    this.#client.messages.on('itemCheated', catchAndLogError(async (text, item) => {
      if (!await this.#isWhitelisted(ArchipelagoMessageType.ItemCheated)) return
      await this.#eventHandler.itemCheated(this, text, item)
    }))

    this.#client.messages.on('chat', catchAndLogError(async (message, player) => {
      if (!await this.#isWhitelisted(ArchipelagoMessageType.UserChat)) return
      await this.#eventHandler.chat(this, message, player)
    }))

    this.#client.messages.on('serverChat', catchAndLogError(async (message) => {
      if (!await this.#isWhitelisted(ArchipelagoMessageType.ServerChat)) return
      await this.#eventHandler.serverChat(this, message)
    }))

    this.#client.messages.on('userCommand', catchAndLogError(async (text) => {
      if (!await this.#isWhitelisted(ArchipelagoMessageType.UserCommand)) return
      await this.#eventHandler.userCommand(this, text)
    }))

    this.#client.messages.on('adminCommand', catchAndLogError(async (text) => {
      if (!await this.#isWhitelisted(ArchipelagoMessageType.ServerCommand)) return
      await this.#eventHandler.adminCommand(this, text)
    }))

    this.#client.messages.on('goaled', catchAndLogError(async (text, player) => {
      this.#goalCache.add(player.slot)
      // Persist so this live goal is part of the baseline — otherwise a restart
      // would re-detect it as "missed" and re-announce it. Mark the baseline as
      // established too, since we now have a persisted goal set.
      this.#hasPersistedGoalBaseline = true
      void this.#persistAnnouncedGoals()

      if (!await this.#isWhitelisted(ArchipelagoMessageType.Goal)) return
      await this.#eventHandler.goaled(this, text, player)

      // Wait for webhost to clear its own cache before checking for goal info
      // Current cache timer for player tracker is 60 seconds
      await new Promise<void>((resolve) => {
        setTimeout(async () => {
          // Invalidate internal cache so that goal information is up to date
          this.#dynamicStateCache.invalidate()
          await this.#emitEventIfEveryoneGoaled()
          resolve()
        }, 60000)
      })
    }))
  }
}
