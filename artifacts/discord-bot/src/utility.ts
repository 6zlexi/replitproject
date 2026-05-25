import { type Message, EmbedBuilder } from "discord.js";
import { db } from "@workspace/db";
import { modWarns, modMuteHistory } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { COLORS } from "./permissions.js";
import { makeEmbed } from "./logging.js";
import { logger } from "./logger.js";
import { getCommandsByCategory } from "./commandRegistry.js";

export async function handlePing(message: Message): Promise<void> {
  const start = Date.now();
  const msg = await message.reply({ embeds: [makeEmbed({ title: "🏓 Pinging...", color: COLORS.info })] });
  const latency = Date.now() - start;
  const wsLatency = message.client.ws.ping;

  await msg.edit({
    embeds: [makeEmbed({
      title: "🏓 Pong!",
      color: COLORS.success,
      fields: [
        { name: "Bot Latency", value: `${latency}ms`, inline: true },
        { name: "WebSocket", value: `${wsLatency}ms`, inline: true },
      ],
    })],
  });
}

export async function handleServerInfo(message: Message): Promise<void> {
  if (!message.guild) return;
  const guild = message.guild;

  await guild.fetch();

  const owner = await guild.fetchOwner().catch(() => null);
  const createdAt = Math.floor(guild.createdTimestamp / 1000);
  const channels = guild.channels.cache.size;
  const roles = guild.roles.cache.size;
  const emojis = guild.emojis.cache.size;
  const members = guild.memberCount;
  const bots = guild.members.cache.filter((m) => m.user.bot).size;
  const humans = members - bots;

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${guild.name}`)
    .setColor(COLORS.info)
    .setThumbnail(guild.iconURL({ size: 256 }) ?? null)
    .addFields(
      { name: "Owner", value: owner ? `<@${owner.id}>` : "Unknown", inline: true },
      { name: "Created", value: `<t:${createdAt}:R>`, inline: true },
      { name: "Members", value: `${humans} humans | ${bots} bots`, inline: true },
      { name: "Channels", value: String(channels), inline: true },
      { name: "Roles", value: String(roles), inline: true },
      { name: "Emojis", value: String(emojis), inline: true },
      { name: "Verification", value: guild.verificationLevel.toString(), inline: true },
      { name: "Server ID", value: guild.id, inline: true },
    )
    .setTimestamp();

  if (guild.description) embed.setDescription(guild.description);

  await message.reply({ embeds: [embed] });
}

export async function handleUserInfo(message: Message, args: string[]): Promise<void> {
  if (!message.guild) return;

  let userId: string;
  const mentionMatch = args[0]?.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    userId = mentionMatch[1]!;
  } else if (args[0]?.match(/^\d+$/)) {
    userId = args[0];
  } else {
    userId = message.author.id;
  }

  try {
    const member = await message.guild.members.fetch(userId).catch(() => null);
    const user = member?.user ?? await message.client.users.fetch(userId).catch(() => null);

    if (!user) {
      await message.reply({ embeds: [makeEmbed({ title: "❌ User Not Found", color: COLORS.error, description: "Could not find that user." })] });
      return;
    }

    const warns = await db
      .select()
      .from(modWarns)
      .where(and(eq(modWarns.guildId, message.guild.id), eq(modWarns.userId, userId), eq(modWarns.active, true)));

    const mutes = await db
      .select()
      .from(modMuteHistory)
      .where(and(eq(modMuteHistory.guildId, message.guild.id), eq(modMuteHistory.userId, userId)))
      .orderBy(desc(modMuteHistory.createdAt))
      .limit(3);

    const createdAt = Math.floor(user.createdTimestamp / 1000);
    const joinedAt = member?.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1000) : null;
    const roles = member?.roles.cache
      .filter((r) => r.id !== message.guild!.roles.everyone.id)
      .map((r) => `<@&${r.id}>`)
      .slice(0, 10)
      .join(", ") || "None";

    const muteText = mutes.length > 0
      ? mutes.map((m) => `${m.durationMinutes}m — <t:${Math.floor(m.createdAt.getTime() / 1000)}:R>`).join("\n")
      : "No mute history";

    const isMuted = member?.communicationDisabledUntil && new Date(member.communicationDisabledUntil) > new Date();

    const embed = new EmbedBuilder()
      .setTitle(`👤 ${user.tag}`)
      .setColor(COLORS.info)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: "User ID", value: user.id, inline: true },
        { name: "Created", value: `<t:${createdAt}:R>`, inline: true },
        { name: "Joined Server", value: joinedAt ? `<t:${joinedAt}:R>` : "Not in server", inline: true },
        { name: "Active Warns", value: `${warns.length}/3`, inline: true },
        { name: "Status", value: isMuted ? "🔇 Muted" : "✅ Active", inline: true },
        { name: "Roles", value: roles },
        { name: "Recent Mutes", value: muteText },
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (err) {
    logger.error({ err }, "userinfo failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to fetch user info." })] });
  }
}

export async function handleAvatar(message: Message, args: string[]): Promise<void> {
  let userId: string = message.author.id;

  const mentionMatch = args[0]?.match(/^<@!?(\d+)>$/);
  if (mentionMatch) userId = mentionMatch[1]!;
  else if (args[0]?.match(/^\d+$/)) userId = args[0];

  try {
    const user = await message.client.users.fetch(userId);
    const avatarUrl = user.displayAvatarURL({ size: 1024, extension: "png" });

    const embed = new EmbedBuilder()
      .setTitle(`🖼️ ${user.tag}'s Avatar`)
      .setColor(COLORS.info)
      .setImage(avatarUrl)
      .addFields({ name: "Download", value: `[Click here](${avatarUrl})` })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch {
    await message.reply({ embeds: [makeEmbed({ title: "❌ User Not Found", color: COLORS.error, description: "Could not find that user." })] });
  }
}

// Category display icons — add new categories here if needed
const CATEGORY_ICONS: Record<string, string> = {
  "Moderation":        "🛡️",
  "Channel Management":"📁",
  "Utility":           "🔧",
  "Script Registry":   "📜",
  "Anti-Nuke":         "🛡️",
  "AI Brain":          "🧠",
  "Tickets":           "🎫",
  "Mood":              "😄",
  "Fun":               "🎉",
  "Economy":           "💰",
  "Games":             "🎮",
  "Owner":             "📦",
};

export async function handleCommandsList(message: Message): Promise<void> {
  const byCategory = getCommandsByCategory();

  const embed = new EmbedBuilder()
    .setTitle("📋 Bot Commands")
    .setColor(COLORS.info)
    .setDescription("All commands use prefix `?` — new commands appear here automatically")
    .setTimestamp()
    .setFooter({ text: "3 warns = auto-kick | 5 total warns = auto-ban" });

  for (const [category, commands] of byCategory) {
    const icon = CATEGORY_ICONS[category] ?? "•";
    const lines = commands.map((cmd) => {
      const display = cmd.usage ?? `?${cmd.name}`;
      const aliases = cmd.aliases?.length
        ? ` *(also: ${cmd.aliases.map((a) => `?${a}`).join(", ")})*`
        : "";
      const perm = cmd.permissionNote ? ` — *${cmd.permissionNote}*` : "";
      return `\`${display}\` — ${cmd.description}${aliases}${perm}`;
    });

    // Chunk into at most 1024 chars per field (Discord limit)
    const chunks: string[] = [];
    let current = "";
    for (const line of lines) {
      const next = current ? `${current}\n${line}` : line;
      if (next.length > 1020) {
        if (current) chunks.push(current);
        current = line;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);

    chunks.forEach((chunk, i) => {
      embed.addFields({
        name: i === 0 ? `${icon} ${category}` : `${icon} ${category} (cont.)`,
        value: chunk,
      });
    });
  }

  await message.reply({ embeds: [embed] });
}
