import * as DC from 'discord.js'

import { Command } from '../../types/command.js'
import { replyWithError } from '../util/message-utils.js'

/**
 * .sessions — list all sessions in the DB for this guild
 * .sessions delete <id> — remove a stale session record by ID (admin only)
 */
const sessions: Command = {
  name: 'Sessions',
  aliases: ['sessions'],
  categories: ['Admin'],
  description: 'Lists all sessions registered in the database, or deletes a stale one by ID.',
  usageHelpText: 'sessions [delete <id>]',
  async execute (message, tokens, _commands, { sessionRepo, sessionRegistry }) {
    if (!message.member?.permissions.has(DC.PermissionFlagsBits.Administrator) &&
      message.author.id !== process.env.OWNER_ID) {
      await message.reply('Only admins can use this command.')
      return
    }

    if (!message.guild || !message.guildId) {
      await replyWithError(message, 'This command can only be used in a server.')
      return
    }

    // .sessions delete <id>
    if (tokens[0] === 'delete') {
      const id = parseInt(tokens[1] ?? '', 10)
      if (isNaN(id)) {
        await replyWithError(message, 'Usage: `.sessions delete <id>`')
        return
      }
      const session = await sessionRepo.findSessionById(id)
      if (!session) {
        await replyWithError(message, `No session found with ID ${id}.`)
        return
      }
      // If the session is live in the registry, route through removeSession() so
      // its reconnect loop is disposed — a plain repo delete leaves a zombie
      // session reconnecting forever against a dead room. removeSession() also
      // deletes the DB row, but it bails early (without touching the DB) when the
      // session isn't live, so fall back to a direct repo delete in that case.
      if (sessionRegistry.getSession(id) !== null) {
        await sessionRegistry.removeSession(id)
      } else {
        await sessionRepo.removeSessionById(id)
      }
      await message.reply(`Session **#${id}** (channel <#${session.channelId}>, room \`${session.roomData.roomId}\`) has been removed from the database.`)
      return
    }

    // .sessions — list all
    const allSessions = await sessionRepo.getSessions({ includeExpired: true })
    const guildSessions = allSessions.filter(s => s.guildId === message.guildId)

    if (guildSessions.length === 0) {
      await message.reply('No sessions found in the database for this server.')
      return
    }

    const lines = guildSessions.map(s => {
      const isActive = sessionRegistry.getSessionByChannelId(s.channelId) !== null
      const status = s.expiredAt != null ? '🔴 expired' : isActive ? '🟢 active' : '🟡 registered'
      const created = new Date(s.createdAt).toLocaleDateString('en-US')
      const chatPart = s.chatChannelId ? ` | chat: <#${s.chatChannelId}>` : ''
      return `**#${s.id}** ${status} — <#${s.channelId}>${chatPart} | room: \`${s.roomData.roomId}\` | created ${created}`
    })

    await message.reply(`**Sessions (${guildSessions.length}):**\n${lines.join('\n')}`)
  },
}

export default sessions
