import * as DC from 'discord.js'

import { Command } from '../../types/command.js'
import { resolveSessionCategory } from '../util/create-run-channels.js'
import { replyWithError } from '../util/message-utils.js'

const setCategory: Command = {
  name: 'Set Session Category',
  aliases: ['setcategory'],
  categories: ['Settings', 'Admin'],
  description: 'Sets the Discord category that new run channels are created in. Defaults to "Sessions".',
  usageHelpText: 'setcategory `category name`',
  async execute (message, tokens, _commands, { guildSettingsRepo }) {
    if (!message.member?.permissions.has(DC.PermissionFlagsBits.Administrator) &&
      message.author.id !== process.env.OWNER_ID) {
      await message.reply('Only admins can use this command.')
      return
    }

    if (!message.guild || !message.guildId) {
      await replyWithError(message, 'This command can only be used in a server.')
      return
    }

    if (tokens.length === 0) {
      const { sessionCategoryName } = await guildSettingsRepo.getSettings(message.guildId)
      const category = resolveSessionCategory(message.guild, sessionCategoryName)
      if (category) {
        await message.reply(`Current session category is **${sessionCategoryName}**.`)
      } else {
        await message.reply(`Current session category is **${sessionCategoryName}**, but no category with that name exists in this server.`)
      }
      return
    }

    const newName = tokens.join(' ')
    const category = resolveSessionCategory(message.guild, newName)
    if (!category) {
      await replyWithError(message, `No category named "${newName}" found in this server. Create it in Discord first, then run this command.`)
      return
    }

    await guildSettingsRepo.setSessionCategoryName(message.guildId, newName)
    await message.reply(`Session category set to **${newName}**.`)
  },
}

export default setCategory
