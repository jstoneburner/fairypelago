import { ChannelType } from 'discord.js'
import { search } from 'fast-fuzzy'

import { SessionCommand } from '../../types/session-command.js'

export const change: SessionCommand = {
  name: 'change',
  description: 'Change some aspect of the session',
  async execute (message, args, session, deps) {
    if (args.length <= 1 || (args[0] !== 'channel' && args[0] !== 'vessel')) {
      await message.reply('Possible things to change: `change channel <id>` and `change vessel <player name>`')
      return
    }
    if (args[0] === 'vessel') {
      const maybeSlotName = args[1]
      const currentVessel = session.getCurrentVessel()
      if (maybeSlotName === currentVessel) {
        await message.reply('That\'s already my current vessel.')
        return
      }
      const existingPlayers = session.staticState.players.map(p => p.slotName)
      if (!existingPlayers.includes(maybeSlotName)) {
        const closestNames = search(maybeSlotName, existingPlayers)
        if (closestNames.length <= 0) {
          await message.reply(`I don't know anyone named __${maybeSlotName}__... `)
        } else {
          await message.reply(`I don't know anyone named __${maybeSlotName}__, did you perhaps mean __${closestNames[0]}__?`)
        }
        return
      }
      const wasSuccessful = await session.changeVessel(maybeSlotName)
      if (wasSuccessful) {
        await message.reply(`Vessel successfully changed to __${maybeSlotName}__`)
      } else {
        await message.reply(`Failed to change vessel to __${maybeSlotName}__`)
      }
    } else if (args[0] === 'channel') {
      const channelId = args[1]
      if (!channelId) {
        await message.reply('Please provide a channel ID: `change channel <id>`')
        return
      }
      let fetchedChannel: import('discord.js').Channel | null
      try {
        fetchedChannel = await message.client.channels.fetch(channelId)
      } catch {
        await message.reply(`Could not find a channel with ID \`${channelId}\`.`)
        return
      }
      if (
        !fetchedChannel ||
        (fetchedChannel.type !== ChannelType.GuildText && fetchedChannel.type !== ChannelType.PublicThread)
      ) {
        await message.reply('That must be a text channel or public thread in this server.')
        return
      }
      const newChannel = fetchedChannel as import('discord.js').TextChannel | import('discord.js').ThreadChannel
      const success = await deps.sessionRegistry.moveSessionToChannel(session.sessionId, newChannel)
      if (success) {
        await newChannel.send(`Session moved here from <#${message.channelId}>.`)
        await message.reply(`Session successfully moved to <#${channelId}>.`)
      } else {
        await message.reply('Failed to move the session to that channel.')
      }
    }
  },
}
