import {
  type Message,
  type TextChannel,
  type GuildChannel,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
} from "discord.js";
import { isAdmin, isMod, canBulkDelete, COLORS } from "./permissions.js";
import { sendLog, makeEmbed } from "./logging.js";
import { logger } from "./logger.js";

function findRoleByName(message: Message, name: string) {
  return message.guild!.roles.cache.find(
    (r) => r.name.toLowerCase() === name.toLowerCase()
  ) ?? null;
}

export async function handleLock1(message: Message): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isAdmin(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **admin** and **co owner** can lock channels." })] });
    return;
  }

  const channel = message.channel as TextChannel;
  const everyone = message.guild.roles.everyone;
  const coOwnerRole = findRoleByName(message, "co owner") ?? findRoleByName(message, "co-owner");
  const adminRole = findRoleByName(message, "admin");

  try {
    const denied = [
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.AttachFiles,
      PermissionsBitField.Flags.EmbedLinks,
      PermissionsBitField.Flags.CreatePublicThreads,
      PermissionsBitField.Flags.CreatePrivateThreads,
      PermissionsBitField.Flags.UseApplicationCommands,
    ];
    const allowed = [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.AttachFiles,
      PermissionsBitField.Flags.EmbedLinks,
      PermissionsBitField.Flags.UseApplicationCommands,
    ];

    await channel.permissionOverwrites.edit(everyone, { SendMessages: false, AttachFiles: false, EmbedLinks: false, UseApplicationCommands: false });
    if (coOwnerRole) await channel.permissionOverwrites.edit(coOwnerRole, { SendMessages: true, AttachFiles: true, EmbedLinks: true, UseApplicationCommands: true });
    if (adminRole) await channel.permissionOverwrites.edit(adminRole, { SendMessages: true, AttachFiles: true, EmbedLinks: true, UseApplicationCommands: true });

    await message.reply({ embeds: [makeEmbed({ title: "🔒 Channel Locked (Level 1)", color: COLORS.error, description: "Only **co owner** and **admin** can send messages here." })] });
    await sendLog(message.guild, makeEmbed({
      title: "🔒 Channel Locked (Level 1)",
      color: COLORS.error,
      fields: [
        { name: "Channel", value: `<#${channel.id}>`, inline: true },
        { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
      ],
    }));
  } catch (err) {
    logger.error({ err }, "lock1 failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to lock channel. Check my permissions." })] });
  }
}

export async function handleLock2(message: Message): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isAdmin(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **admin** and **co owner** can lock channels." })] });
    return;
  }

  const channel = message.channel as TextChannel;
  const everyone = message.guild.roles.everyone;
  const coOwnerRole = findRoleByName(message, "co owner") ?? findRoleByName(message, "co-owner");
  const adminRole = findRoleByName(message, "admin");
  const modRole = findRoleByName(message, "mod") ?? findRoleByName(message, "moderator");

  try {
    await channel.permissionOverwrites.edit(everyone, { SendMessages: false, AttachFiles: false, EmbedLinks: false, UseApplicationCommands: false });
    if (coOwnerRole) await channel.permissionOverwrites.edit(coOwnerRole, { SendMessages: true, AttachFiles: true, EmbedLinks: true, UseApplicationCommands: true });
    if (adminRole) await channel.permissionOverwrites.edit(adminRole, { SendMessages: true, AttachFiles: true, EmbedLinks: true, UseApplicationCommands: true });
    if (modRole) await channel.permissionOverwrites.edit(modRole, { SendMessages: true, AttachFiles: true, EmbedLinks: true, UseApplicationCommands: true });

    await message.reply({ embeds: [makeEmbed({ title: "🔒 Channel Locked (Level 2)", color: COLORS.warning, description: "Only **co owner**, **admin**, and **mod** can send messages here." })] });
    await sendLog(message.guild, makeEmbed({
      title: "🔒 Channel Locked (Level 2)",
      color: COLORS.warning,
      fields: [
        { name: "Channel", value: `<#${channel.id}>`, inline: true },
        { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
      ],
    }));
  } catch (err) {
    logger.error({ err }, "lock2 failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to lock channel. Check my permissions." })] });
  }
}

export async function handleUnlock(message: Message): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isAdmin(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **admin** and **co owner** can unlock channels." })] });
    return;
  }

  const channel = message.channel as TextChannel;
  const everyone = message.guild.roles.everyone;

  try {
    await channel.permissionOverwrites.edit(everyone, { SendMessages: null, AttachFiles: null, EmbedLinks: null, UseApplicationCommands: null });

    await message.reply({ embeds: [makeEmbed({ title: "🔓 Channel Unlocked", color: COLORS.success, description: "Members can chat again." })] });
    await sendLog(message.guild, makeEmbed({
      title: "🔓 Channel Unlocked",
      color: COLORS.success,
      fields: [
        { name: "Channel", value: `<#${channel.id}>`, inline: true },
        { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
      ],
    }));
  } catch (err) {
    logger.error({ err }, "unlock failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to unlock channel." })] });
  }
}

export async function handlePurge(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!canBulkDelete(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **mod**, **admin**, and **co owner** can purge messages." })] });
    return;
  }

  const channel = message.channel as TextChannel;
  const arg = args[0]?.toLowerCase();

  try {
    if (arg === "all") {
      const confirm = await message.reply({
        embeds: [makeEmbed({
          title: "⚠️ Confirm Purge All",
          color: COLORS.warning,
          description: "This will delete **ALL** messages by cloning the channel. Reply `yes` within 10 seconds to confirm.",
        })],
      });

      const filter = (m: Message) => m.author.id === message.author.id && m.content.toLowerCase() === "yes";
      try {
        await (channel as TextChannel).awaitMessages({ filter, max: 1, time: 10000, errors: ["time"] });
      } catch {
        await confirm.edit({ embeds: [makeEmbed({ title: "❌ Cancelled", color: COLORS.error, description: "Purge all cancelled." })] });
        return;
      }

      const position = channel.position;
      const newChannel = await channel.clone({ reason: `Purge all by ${message.author.tag}` });
      await newChannel.setPosition(position);
      await channel.delete(`Purge all by ${message.author.tag}`);

      await newChannel.send({ embeds: [makeEmbed({ title: "🗑️ Channel Purged", color: COLORS.success, description: `All messages deleted by <@${message.author.id}>.` })] });
      await sendLog(message.guild, makeEmbed({
        title: "🗑️ Channel Purged (All)",
        color: COLORS.error,
        fields: [
          { name: "Channel", value: `<#${newChannel.id}>`, inline: true },
          { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
        ],
      }));
    } else {
      const amount = Math.min(Math.max(1, parseInt(arg ?? "1") || 1), 100);
      await message.delete().catch(() => {});
      const deleted = await channel.bulkDelete(amount, true);

      const reply = await channel.send({ embeds: [makeEmbed({ title: "🗑️ Messages Purged", color: COLORS.success, description: `Deleted **${deleted.size}** messages.` })] });
      setTimeout(() => reply.delete().catch(() => {}), 4000);

      await sendLog(message.guild, makeEmbed({
        title: "🗑️ Messages Purged",
        color: COLORS.warning,
        fields: [
          { name: "Channel", value: `<#${channel.id}>`, inline: true },
          { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
          { name: "Count", value: String(deleted.size), inline: true },
        ],
      }));
    }
  } catch (err) {
    logger.error({ err }, "purge failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to purge messages. Messages older than 14 days cannot be bulk deleted." })] });
  }
}

export async function handleMoveMulti(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isAdmin(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **admin** and **co owner** can move channels." })] });
    return;
  }

  if (args.length < 2) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?movemulti <category name> <#channel1> <#channel2> ...`" })] });
    return;
  }

  const channelMentions = args.filter((a) => a.match(/^<#\d+>$/));
  const categoryName = args.filter((a) => !a.match(/^<#\d+>$/)).join(" ");

  if (!categoryName || channelMentions.length === 0) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?movemulti <category name> <#channel1> <#channel2> ...`\n\nProvide a category name and at least one channel mention." })] });
    return;
  }

  const category = message.guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
  );

  if (!category) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Category Not Found", color: COLORS.error, description: `No category named **${categoryName}** found.` })] });
    return;
  }

  const movedChannels: string[] = [];
  const failedChannels: string[] = [];

  for (const mention of channelMentions) {
    const channelId = mention.replace(/[<#>]/g, "");
    const ch = message.guild.channels.cache.get(channelId) as GuildChannel | undefined;
    if (!ch) { failedChannels.push(mention); continue; }
    try {
      await ch.setParent(category.id, { lockPermissions: false });
      movedChannels.push(`<#${ch.id}>`);
    } catch {
      failedChannels.push(`<#${ch.id}>`);
    }
  }

  await message.reply({
    embeds: [makeEmbed({
      title: "📁 Channels Moved",
      color: movedChannels.length > 0 ? COLORS.success : COLORS.error,
      fields: [
        { name: "Category", value: categoryName, inline: true },
        { name: "Moved", value: movedChannels.join(", ") || "None", inline: false },
        ...(failedChannels.length > 0 ? [{ name: "Failed", value: failedChannels.join(", ") }] : []),
      ],
    })],
  });

  await sendLog(message.guild, makeEmbed({
    title: "📁 Channels Moved",
    color: COLORS.info,
    fields: [
      { name: "Category", value: categoryName, inline: true },
      { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
      { name: "Channels", value: movedChannels.join(", ") || "None" },
    ],
  }));
}

export async function handleDeleteEmojis(message: Message): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isAdmin(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **admin** and **co owner** can delete emojis." })] });
    return;
  }

  const emojis = [...message.guild.emojis.cache.values()];
  if (emojis.length === 0) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Emojis", color: COLORS.error, description: "This server has no custom emojis." })] });
    return;
  }

  const confirm = await message.reply({
    embeds: [makeEmbed({
      title: "⚠️ Confirm Delete All Emojis",
      color: COLORS.warning,
      description: `This will delete **${emojis.length}** custom emojis. Reply \`yes\` within 10 seconds to confirm.`,
    })],
  });

  const filter = (m: Message) => m.author.id === message.author.id && m.content.toLowerCase() === "yes";
  try {
    await (message.channel as TextChannel).awaitMessages({ filter, max: 1, time: 10000, errors: ["time"] });
  } catch {
    await confirm.edit({ embeds: [makeEmbed({ title: "❌ Cancelled", color: COLORS.error, description: "Emoji deletion cancelled." })] });
    return;
  }

  let deleted = 0;
  for (const emoji of emojis) {
    try {
      await emoji.delete(`Bulk delete by ${message.author.tag}`);
      deleted++;
    } catch {
      logger.warn({ emojiId: emoji.id }, "Failed to delete emoji");
    }
  }

  await (message.channel as TextChannel).send({ embeds: [makeEmbed({ title: "🗑️ Emojis Deleted", color: COLORS.success, description: `Deleted **${deleted}/${emojis.length}** custom emojis.` })] });
}
