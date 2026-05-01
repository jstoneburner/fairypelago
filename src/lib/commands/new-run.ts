import * as DC from 'discord.js'

import { Command } from '../../types/command.js'
import { parseArchipelagoRoomUrl } from '../util/archipelago-room-scrape.js'
import { createRunChannels } from '../util/create-run-channels.js'
import { ArchipelagoWebhostClient } from '../archipelago-webhost-client.js'
import { replyWithError } from '../util/message-utils.js'

const newRun: Command = {
  name: 'New Run',
  aliases: ['newrun', 'startrun'],
  categories: ['Admin'],
  description: 'Creates broadcast and chat channels for a new AP run.',
  usageHelpText: 'newrun `archipelago-room-url`',
  async execute (message, tokens, _commands, { sessionRegistry, sessionRepo, guildSettingsRepo }) {
    if (!message.member?.permissions.has(DC.PermissionFlagsBits.Administrator) &&
      message.author.id !== process.env.OWNER_ID) {
      await message.reply('Only admins can use this command.')
      return
    }

    if (!message.guild || !message.guildId) {
      await replyWithError(message, 'This command can only be used in a server.')
      return
    }

    const roomUrl = tokens[0]
    if (!roomUrl) {
      await message.reply(`Usage: \`${message.content.split(' ')[0]} ${newRun.usageHelpText}\``)
      return
    }

    const archRoomData = parseArchipelagoRoomUrl(roomUrl)
    if (!archRoomData) {
      await replyWithError(message, 'That doesn\'t look like a valid Archipelago room URL.')
      return
    }

    // If a session already exists for this room, just link to it
    const existingChannelId = sessionRegistry.getChannelIdByRoomUrl(archRoomData.url)
    if (existingChannelId) {
      const existingChannel = await message.guild.channels.fetch(existingChannelId).catch(() => null)
      await message.reply(`A session already exists for that room: ${existingChannel?.url ?? existingChannelId}`)
      return
    }

    const guildSettings = await guildSettingsRepo.getSettings(message.guildId)
    if (!guildSettings.logChannelId) {
      await replyWithError(message, 'Log channel has not been set up yet. Use `.setlogchannel` first.')
      return
    }

    const logChannel = await message.guild.channels.fetch(guildSettings.logChannelId).catch(() => null)
    if (!logChannel || !(logChannel instanceof DC.TextChannel)) {
      await replyWithError(message, 'Could not find the configured log channel.')
      return
    }

    // Verify the room is reachable before creating channels
    const webhostClient = new ArchipelagoWebhostClient(archRoomData.domain)
    const sessionStatus = await webhostClient.fetchSessionStatus(archRoomData.roomId)
    if (!sessionStatus) {
      await replyWithError(message, 'Failed to reach that AP room — the URL may be wrong or the server may be down.')
      return
    }

    const loadingReaction = await message.react('⏳')
    const result = await createRunChannels(
      message.guild,
      message.client.user!.id,
      archRoomData,
      logChannel,
      sessionRegistry,
      sessionRepo,
    )
    await loadingReaction.remove().catch(() => undefined)

    if (!result) {
      await replyWithError(message, 'Failed to create the run channels. The room may have expired.')
      return
    }

    await logChannel.send(result.announcement)
    await message.reply(result.announcement)
  },
}

export default newRun
