import { Client as ArchipelagoClient, LoginError } from 'archipelago.js'

import { ArchipelagoMessageType, type ArchipelagoRoomData } from '../types/archipelago-types.js'
import { catchAndLogError } from './util/general.js'
import { logger } from './util/logger.js'
import { IEventHandler } from './interfaces/event-handler.js'
import { IOptionsProvider } from './interfaces/options-provider.js'
import { ArchipelagoWebhostClient, WebhostInitialSessionData, WebhostSessionStatus } from './archipelago-webhost-client.js'
import { ItemTier } from '../types/icon-types.js'
import { TTLCache } from './util/ttl-cache.js'
import { SessionStaticState, SessionHintingInfo, SessionItemReceived, SessionStatus, SessionLoginAttemptResult } from '../types/session-types.js'

interface SessionVesselChange {
  isInTransition: boolean,
  prevVesselName: string | null,
}

export interface SessionDeps {
  eventHandler: IEventHandler;
  optionsProvider: IOptionsProvider;
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

  // Guards against reconnect loops caused by archipelago.js's socket.connect() always
  // calling disconnect() first, which emits 'disconnected' and triggers #scheduleReconnect.
  // Set to true for the entire duration of any login attempt so that 'disconnected' events
  // fired by connect() itself are ignored.
  #isLoggingIn = false

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
    return session
  }

  // Attempt to login to the session if a slotName/password is given
  // If not, attempt to start under any account if autojoin is enabled,
  // otherwise fire session idle event
  async start (slotName?: string, password?: string) {
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
        await this.#client.login(
          url,
          slotName,
          undefined, // game — not needed for TextOnly/Tracker clients
          { tags: ['Discord', 'Tracker', 'TextOnly'], password },
        )
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
        await this.#eventHandler.socketConnected(this, isAutoReconnect, missedGoalNames.length > 0 ? missedGoalNames : undefined)
        return SessionLoginAttemptResult.Success
      } catch (err) {
        if (err instanceof LoginError) {
          logger.warn('Login refused by AP server', {
            sessionId: this.#sessionId,
            vessel: slotName,
            hasPassword: !!password,
            reasons: err.errors,
          })
          return SessionLoginAttemptResult.PasswordIncorrect
        }
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
      await newClient.login(
        `${this.#roomData.domain}:${sessionStatus.port}`,
        slotName,
        undefined,
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
    const MAX_ATTEMPTS = 8
    if (this.#isDisposed || this.#isFinished || !this.#lastVesselName) return
    // A newer start() call or login attempt has superseded this reconnect chain.
    if (generation !== this.#reconnectGeneration) return
    if (attempt > MAX_ATTEMPTS) {
      logger.warn('AP reconnect max attempts reached, giving up', { sessionId: this.#sessionId })
      await this.#eventHandler.reconnectFailed(this)
      return
    }
    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5 * 60 * 1000)
    logger.info('Scheduling AP reconnect', { sessionId: this.#sessionId, attempt, delayMs })
    await new Promise<void>(resolve => setTimeout(resolve, delayMs))
    if (this.#isDisposed || this.#isFinished) return
    if (generation !== this.#reconnectGeneration) return

    logger.info('Attempting AP reconnect', { sessionId: this.#sessionId, attempt, vessel: this.#lastVesselName })
    const result = await this.#attemptLoginAsPlayer(this.#lastVesselName, this.#lastPassword, true)
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

        // Populate the data packages in cache if there is no cached version and this is called before start()
        const packages = this.#client.package.exportPackage()
        if (Object.keys(packages.games).length <= 0) {
          await this.#client.package.fetchPackage()
        }

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

  // Fetches the data package from memory.
  // If data package is not yet fetched, will perform expensive fetch calls.
  async getDataPackage (games?: string[]) {
    const packages = this.#client.package.exportPackage()
    if (Object.keys(packages.games).length <= 0) {
      return await this.#client.package.fetchPackage(games)
    } else {
      return packages
    }
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
