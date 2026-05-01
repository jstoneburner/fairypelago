import * as DC from 'discord.js'

import { ArchipelagoRoomData } from '../../types/archipelago-types.js'
import { ArchipelagoSessionRegistry } from '../archipelago-session-registry.js'
import { ISessionRepository } from '../../db/interfaces.js'
import { createRoomDataDisplay } from './discord-formatting.js'
import { logger } from './logger.js'

export interface CreateRunChannelsResult {
  broadcastChannel: DC.TextChannel
  chatChannel: DC.TextChannel
  announcement: string
}

/**
 * Looks up a category channel by name (case-insensitive) in the guild.
 * Returns null if not found.
 */
export function resolveSessionCategory (guild: DC.Guild, categoryName: string): DC.CategoryChannel | null {
  return (guild.channels.cache.find(
    c => c.type === DC.ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase(),
  ) as DC.CategoryChannel | undefined) ?? null
}

/**
 * Creates a broadcast + chat channel pair for an AP run, sets up permissions,
 * registers the session, and pins the room link + player list.
 *
 * Returns the two channels and a ready-made announcement string, or null if
 * any step fails (channels are cleaned up on failure).
 */
export async function createRunChannels (
  guild: DC.Guild,
  botUserId: string,
  archRoomData: ArchipelagoRoomData,
  parentCategoryId: string | null,
  sessionRegistry: ArchipelagoSessionRegistry,
  sessionRepo: ISessionRepository,
): Promise<CreateRunChannelsResult | null> {

  // Build a date-stamped name (MM-DD-YYYY); append a counter if taken
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const yyyy = now.getFullYear()
  const dateStr = `${mm}-${dd}-${yyyy}`
  const takenNames = new Set(
    guild.channels.cache
      .filter(c => c.parentId === parentCategoryId)
      .map(c => c.name),
  )
  let broadcastName = `run-${dateStr}`
  let chatName = `run-chat-${dateStr}`
  let suffix = 2
  while (takenNames.has(broadcastName) || takenNames.has(chatName)) {
    broadcastName = `run-${dateStr}-${suffix}`
    chatName = `run-chat-${dateStr}-${suffix}`
    suffix++
  }

  // Broadcast channel — bot can post, everyone else can only read
  const broadcastChannel = await guild.channels.create({
    name: broadcastName,
    type: DC.ChannelType.GuildText,
    parent: parentCategoryId,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        allow: [DC.PermissionFlagsBits.ViewChannel, DC.PermissionFlagsBits.ReadMessageHistory],
        deny: [DC.PermissionFlagsBits.SendMessages, DC.PermissionFlagsBits.CreatePublicThreads, DC.PermissionFlagsBits.CreatePrivateThreads],
      },
      {
        id: botUserId,
        allow: [DC.PermissionFlagsBits.ViewChannel, DC.PermissionFlagsBits.SendMessages, DC.PermissionFlagsBits.ManageMessages, DC.PermissionFlagsBits.EmbedLinks, DC.PermissionFlagsBits.AttachFiles],
      },
    ],
  })

  // Chat channel — open for everyone
  const chatChannel = await guild.channels.create({
    name: chatName,
    type: DC.ChannelType.GuildText,
    parent: parentCategoryId,
  })

  logger.info('New channels created for session', {
    guildId: guild.id,
    broadcastChannelId: broadcastChannel.id,
    chatChannelId: chatChannel.id,
    url: archRoomData.url,
  })

  const newSession = await sessionRegistry.createSession(broadcastChannel, archRoomData)
  if (!newSession) {
    await broadcastChannel.delete().catch(() => undefined)
    await chatChannel.delete().catch(() => undefined)
    logger.warn('Failed to create session after creating channels', { url: archRoomData.url })
    return null
  }

  // Register the chat channel so session commands and AP forwarding work there.
  // Must happen before sending anything to the chat channel to prevent the
  // room-link detection handler from treating the pinned URL as a new run.
  await sessionRepo.setChatChannelId(newSession.sessionId, chatChannel.id)
  sessionRegistry.linkChatChannel(newSession.sessionId, chatChannel.id)

  // Pin the player list to the broadcast channel
  const initialMessage = await broadcastChannel.send(createRoomDataDisplay(newSession.staticState))
  await initialMessage.pin()

  // Pin the AP room link in the chat channel
  const chatRoomLinkMessage = await chatChannel.send(archRoomData.url)
  await chatRoomLinkMessage.pin()

  await newSession.start()

  return {
    broadcastChannel,
    chatChannel,
    announcement: `New AP run started!\nBroadcast: ${broadcastChannel.url}\nChat: ${chatChannel.url}`,
  }
}
