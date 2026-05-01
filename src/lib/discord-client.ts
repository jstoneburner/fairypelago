import * as DC from 'discord.js'

import { parseArchipelagoRoomUrl } from './util/archipelago-room-scrape.js'
import { createRoomDataDisplay } from './util/discord-formatting.js'
import { reloadAvaliableCommands, getAvaliableCommands } from './commands.js'
import { catchAndLogError } from './util/general.js'
import { logger } from './util/logger.js'
import { replyWithError, stripDiscordEmojis } from './util/message-utils.js'
import { ArchipelagoSessionRegistry } from './archipelago-session-registry.js'
import { IGuildSettingsRepository, INotificationRequestsRepository, ISessionRepository } from '../db/interfaces.js'
import { tryToExecuteSessionCommand } from './session-commands.js'
import { ArchipelagoWebhostClient } from './archipelago-webhost-client.js'
import { IOptionsProvider } from './interfaces/options-provider.js'

const intents = [
  DC.GatewayIntentBits.MessageContent,
  DC.GatewayIntentBits.Guilds,
  DC.GatewayIntentBits.GuildMessages,
  DC.GatewayIntentBits.GuildMessageReactions,
  DC.GatewayIntentBits.GuildMembers,
  DC.GatewayIntentBits.DirectMessages,
]

export class DiscordClient {
  #client: DC.Client

  constructor (
    private sessionRegistry: ArchipelagoSessionRegistry,
    private sessionRepo: ISessionRepository,
    private settingsRepo: IGuildSettingsRepository,
    private notificationRequestsRepo: INotificationRequestsRepository,
    private optionsProvider: IOptionsProvider,
  ) {
    this.#client = new DC.Client({ intents })
  }

  async login (token: string) {
    await this.#client.login(token)
  }

  get client () {
    return this.#client
  }

  registerListeners () {
    this.#client.once(DC.Events.ClientReady, async (client) => {
      logger.info('Client ready', { tag: client.user.tag })
      await reloadAvaliableCommands()
      await this.sessionRegistry.initFromDb(this.#client)
      await Promise.all(this.sessionRegistry.getAllSessions().map(async session => {
        if (!session.isSocketConnected) await session.start()
      }))
    })

    // Handle general bot commands
    this.#client.on(
      DC.Events.MessageCreate,
      catchAndLogError(async (message: DC.OmitPartialGroupDMChannel<DC.Message<boolean>>) => {
        if (!this.#client.user) return
        if (message.author.id === this.#client.user.id) return
        if (message.author.bot) return
        if (!message.guildId) return

        const guildSettings = await this.settingsRepo.getSettings(message.guildId)
        if (!message.content.startsWith(guildSettings.commandPrefix)) return

        const truncatedMsg = message.content.substring(guildSettings.commandPrefix.length)
        const tokens = truncatedMsg.split(' ')
        const commandName = tokens.shift()?.toLocaleLowerCase()
        if (!commandName) return

        const avaliableCommands = getAvaliableCommands()

        if (commandName === 'reload' && message.author.id === process.env.OWNER_ID) {
          await reloadAvaliableCommands()
          await message.react('✅')
          await new Promise<void>(resolve => setTimeout(() => resolve(), 2000))
          await message.delete()
        } else if (!(commandName in avaliableCommands)) {
          message.react('❓')
        } else {
          const command = avaliableCommands[commandName as string]
          try {
            await command.execute(message, tokens, avaliableCommands, {
              sessionRegistry: this.sessionRegistry,
              guildSettingsRepo: this.settingsRepo,
              sessionRepo: this.sessionRepo,
              optionsProvider: this.optionsProvider,
            })
            logger.info('Executed command', { commandName, tokens })
          } catch (err) {
            logger.error('Failed to execute command', { err })
            message.react('❗')
          }
        }
      }),
    )

    // Handles session commands within a session room, or forward the messages to AP server
    this.#client.on(
      DC.Events.MessageCreate,
      catchAndLogError(async (message: DC.OmitPartialGroupDMChannel<DC.Message<boolean>>) => {
        if (!this.#client.user) return
        if (message.author.id === this.#client.user.id) return
        if (message.author.bot) return

        const existingSession = this.sessionRegistry.getSessionByChannelId(message.channelId)
        if (!existingSession) return

        const guildSettings = await this.settingsRepo.getSettings(message.guildId!)
        const prefix = guildSettings.sessionCommandPrefix

        if (message.content.startsWith(prefix)) {
          const strippedContent = message.content.slice(prefix.length).trim()
          await tryToExecuteSessionCommand(message, strippedContent, existingSession, {
            notificationRequestsRepo: this.notificationRequestsRepo,
            sessionRegistry: this.sessionRegistry,
          })
          return
        }

        // Prevent forwarding empty messages, which can happen is only an attachment (e.g. image) is sent
        if (message.content.length <= 0) return
        const messageWithShortEmojis = stripDiscordEmojis(message.content)
        try {
          await existingSession.sendMessage(`[${message.author.username}] :: ${messageWithShortEmojis}`)
          logger.info('Forwarded message to archipelago', { message: messageWithShortEmojis })
        } catch (err) {
          logger.info('Failed to forward message', { message: messageWithShortEmojis, err })
        }
      }),
    )

    // Handle the initialization of AP session
    this.#client.on(
      DC.Events.MessageCreate,
      catchAndLogError(async (message: DC.OmitPartialGroupDMChannel<DC.Message<boolean>>) => {
        if (!this.#client.user) return
        if (message.author.id === this.#client.user.id) return
        if (message.author.bot) return
        // Skip if message is already in a session channel (broadcast or chat)
        if (this.sessionRegistry.getSessionByChannelId(message.channelId)) return
        if (!message.guildId) return

        // Checks if message contains archipelago room link
        const archRoomData = parseArchipelagoRoomUrl(message.content)
        if (archRoomData === null) return

        logger.info('AP Room Url detected, attempt to create session', {
          channelId: message.channelId,
          guildId: message.guildId,
          roomData: archRoomData,
        })

        // Check if webhost server endpoint is avaliable. If not, either room link is broken or the server is down.
        const webhostClient = new ArchipelagoWebhostClient(archRoomData.domain)
        const sessionStatus = await webhostClient.fetchSessionStatus(archRoomData.roomId)
        if (!sessionStatus) {
          await replyWithError(message, 'Failed to fetch info from this AP room, perhaps the url is incorrect or the site is down...')
          logger.info('AP room link detected but failed to connect to webhost, ', {
            channelId: message.channelId,
            guildId: message.guildId,
            roomData: archRoomData,
          })
          return
        }

        const guildSettings = await this.settingsRepo.getSettings(message.guildId)

        const logChannelId = guildSettings.logChannelId
        if (logChannelId === null) {
          message.channel.send('Log channel has not been setup yet.')
          logger.info('Did not create session due to missing log channel setting', {
            channelId: message.channelId,
            guildId: message.guildId,
            roomData: archRoomData,
          })
          return
        }
        if (!message.guild) return
        const logChannel = await message.guild.channels.fetch(logChannelId)
        if (logChannel === null) return

        // If room already exists, instead reply with link to existing thread
        const existingSessionChannelId = await this.sessionRegistry.getChannelIdByRoomUrl(archRoomData.url)
        if (existingSessionChannelId) {
          const existingChannelUrl = (await message.guild?.channels.fetch(existingSessionChannelId))?.url
          if (!existingChannelUrl) return
          await message.reply(existingChannelUrl)
          return
        }

        // Determine the category to place new channels in (same as log channel, if any)
        const parentCategoryId = (logChannel as DC.TextChannel).parentId ?? null

        // Build a date-stamped name; append a counter if that name already exists
        const dateStr = new Date().toISOString().slice(0, 10)
        const takenNames = new Set(
          message.guild.channels.cache
            .filter(c => c.parentId === parentCategoryId)
            .map(c => c.name),
        )
        let broadcastName = `ap-${dateStr}`
        let chatName = `ap-chat-${dateStr}`
        let suffix = 2
        while (takenNames.has(broadcastName) || takenNames.has(chatName)) {
          broadcastName = `ap-${dateStr}-${suffix}`
          chatName = `ap-chat-${dateStr}-${suffix}`
          suffix++
        }

        // Broadcast channel — bot can post, everyone else can only read
        const broadcastChannel = await message.guild.channels.create({
          name: broadcastName,
          type: DC.ChannelType.GuildText,
          parent: parentCategoryId,
          permissionOverwrites: [
            {
              id: message.guild.roles.everyone.id,
              allow: [DC.PermissionFlagsBits.ViewChannel, DC.PermissionFlagsBits.ReadMessageHistory],
              deny: [DC.PermissionFlagsBits.SendMessages, DC.PermissionFlagsBits.CreatePublicThreads, DC.PermissionFlagsBits.CreatePrivateThreads],
            },
            {
              id: this.#client.user!.id,
              allow: [DC.PermissionFlagsBits.ViewChannel, DC.PermissionFlagsBits.SendMessages, DC.PermissionFlagsBits.ManageMessages, DC.PermissionFlagsBits.EmbedLinks, DC.PermissionFlagsBits.AttachFiles],
            },
          ],
        })

        // Chat channel — open for everyone
        const chatChannel = await message.guild.channels.create({
          name: chatName,
          type: DC.ChannelType.GuildText,
          parent: parentCategoryId,
        })

        logger.info('New channels created for session', {
          guildId: message.guildId,
          broadcastChannelId: broadcastChannel.id,
          chatChannelId: chatChannel.id,
          url: archRoomData.url,
        })

        const newSession = await this.sessionRegistry.createSession(broadcastChannel, archRoomData)
        if (!newSession) {
          await replyWithError(message, 'Failed to fetch info from this AP room, perhaps the room is expired or the site is down...')
          await broadcastChannel.delete().catch(() => undefined)
          await chatChannel.delete().catch(() => undefined)
          logger.info('AP room link detected but failed to create session, ', {
            channelId: message.channelId,
            guildId: message.guildId,
            url: archRoomData.url,
          })
          return
        }

        // Register the chat channel so session commands and AP forwarding work there
        await this.sessionRepo.setChatChannelId(newSession.sessionId, chatChannel.id)
        this.sessionRegistry.linkChatChannel(newSession.sessionId, chatChannel.id)

        // Pin the player list to the broadcast channel
        const initialMessage = await broadcastChannel.send(createRoomDataDisplay(newSession.staticState))
        await initialMessage.pin()

        // Announce both channels in the log channel (and in the originating channel if different)
        const announcement = `New AP run started!\nBroadcast: ${broadcastChannel.url}\nChat: ${chatChannel.url}`
        await (logChannel as DC.TextChannel).send(announcement)
        if (message.channelId !== logChannelId) {
          await message.reply(announcement)
        }

        await newSession.start()
      }))
  }
}
