import {
  type Message,
  type Guild,
  type GuildMember,
  EmbedBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import {
  modWarns,
  modMuteHistory,
  modUserFlags,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { isAdmin, isMod, isCoOwner, isGuildOwner, COLORS } from "./permissions.js";
import { sendLog, logModAction, makeEmbed } from "./logging.js";
import { saveGuildDataNow } from "./persistence.js";
import { logger } from "./logger.js";

const DEFAULT_MUTE_MINUTES = 10;

function parseTarget(message: Message, args: string[]): string | null {
  const mention = args[0];
  if (!mention) return null;
  const match = mention.match(/^<@!?(\d+)>$/);
  return match?.[1] ?? null;
}

async function fetchMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

async function getActiveWarnCount(guildId: string, userId: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(modWarns)
    .where(and(eq(modWarns.guildId, guildId), eq(modWarns.userId, userId), eq(modWarns.active, true)));
  return Number(result[0]?.count ?? 0);
}

async function getWarnKicked(guildId: string, userId: string): Promise<boolean> {
  const result = await db
    .select()
    .from(modUserFlags)
    .where(and(eq(modUserFlags.guildId, guildId), eq(modUserFlags.userId, userId)))
    .limit(1);
  return result[0]?.warnKicked ?? false;
}

async function setWarnKicked(guildId: string, userId: string, value: boolean): Promise<void> {
  const existing = await db
    .select()
    .from(modUserFlags)
    .where(and(eq(modUserFlags.guildId, guildId), eq(modUserFlags.userId, userId)))
    .limit(1);
  if (existing.length === 0) {
    await db.insert(modUserFlags).values({ guildId, userId, warnKicked: value });
  } else {
    await db.update(modUserFlags)
      .set({ warnKicked: value, updatedAt: new Date() })
      .where(and(eq(modUserFlags.guildId, guildId), eq(modUserFlags.userId, userId)));
  }
}

export async function handleWarn(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isMod(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **mod**, **admin**, and **co owner** can warn members." })] });
    return;
  }

  const userId = parseTarget(message, args);
  if (!userId) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?warn <@user> [reason]`" })] });
    return;
  }

  const reason = args.slice(1).join(" ") || "No reason provided";
  const guild = message.guild;
  const target = await fetchMember(guild, userId);

  if (!target) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ User Not Found", color: COLORS.error, description: "Could not find that member." })] });
    return;
  }

  if (target.id === message.author.id) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "You can't warn yourself." })] });
    return;
  }

  try {
    await db.insert(modWarns).values({
      guildId: guild.id,
      userId: target.id,
      moderatorId: message.author.id,
      reason,
    });
    saveGuildDataNow(guild.id).catch(() => {});

    const warnCount = await getActiveWarnCount(guild.id, target.id);
    const warnKicked = await getWarnKicked(guild.id, target.id);

    await logModAction({ guildId: guild.id, action: "warn", userId: target.id, moderatorId: message.author.id, reason });

    await message.reply({
      embeds: [makeEmbed({
        title: "⚠️ Member Warned",
        color: COLORS.warning,
        fields: [
          { name: "User", value: `<@${target.id}> (${target.user.tag})`, inline: true },
          { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
          { name: "Reason", value: reason },
          { name: "Total Warns", value: `**${warnCount}**/3` },
        ],
      })],
    });

    await sendLog(guild, makeEmbed({
      title: "⚠️ Member Warned",
      color: COLORS.warning,
      fields: [
        { name: "User", value: `<@${target.id}> (${target.user.tag})`, inline: true },
        { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
        { name: "Reason", value: reason },
        { name: "Warn Count", value: String(warnCount) },
      ],
    }));

    if (!warnKicked && warnCount >= 3) {
      await setWarnKicked(guild.id, target.id, true);
      try {
        await target.kick("Auto-kick: reached 3 warnings");
        await logModAction({ guildId: guild.id, action: "auto_kick", userId: target.id, moderatorId: guild.client.user!.id, reason: "Reached 3 warnings" });
        await sendLog(guild, makeEmbed({
          title: "👢 Auto-Kicked (3 Warns)",
          color: COLORS.error,
          description: `<@${target.id}> was automatically kicked for reaching 3 warnings.`,
        }));
      } catch {
        logger.warn({ userId: target.id }, "Failed to auto-kick user");
      }
    } else if (warnKicked && warnCount >= 5) {
      try {
        await guild.members.ban(target.id, { reason: "Auto-ban: 2 warnings after warn-kick" });
        await logModAction({ guildId: guild.id, action: "auto_ban", userId: target.id, moderatorId: guild.client.user!.id, reason: "2 warnings after warn-kick" });
        await sendLog(guild, makeEmbed({
          title: "🔨 Auto-Banned (5 Total Warns)",
          color: COLORS.error,
          description: `<@${target.id}> was automatically permanently banned after receiving 2 more warnings after their warn-kick.`,
        }));
      } catch {
        logger.warn({ userId: target.id }, "Failed to auto-ban user");
      }
    }
  } catch (err) {
    logger.error({ err }, "warn command failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to warn the user." })] });
  }
}

export async function handleUnwarn(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isMod(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **mod**, **admin**, and **co owner** can unwarn members." })] });
    return;
  }

  const userId = parseTarget(message, args);
  if (!userId) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?unwarn <@user>`" })] });
    return;
  }

  try {
    const latest = await db
      .select()
      .from(modWarns)
      .where(and(eq(modWarns.guildId, message.guild.id), eq(modWarns.userId, userId), eq(modWarns.active, true)))
      .orderBy(desc(modWarns.createdAt))
      .limit(1);

    if (latest.length === 0) {
      await message.reply({ embeds: [makeEmbed({ title: "❌ No Warns", color: COLORS.error, description: "That user has no active warnings." })] });
      return;
    }

    await db.update(modWarns).set({ active: false }).where(eq(modWarns.id, latest[0]!.id));
    saveGuildDataNow(message.guild.id).catch(() => {});
    const remaining = await getActiveWarnCount(message.guild.id, userId);

    await logModAction({ guildId: message.guild.id, action: "unwarn", userId, moderatorId: message.author.id, reason: "Warning removed" });

    await message.reply({
      embeds: [makeEmbed({
        title: "✅ Warning Removed",
        color: COLORS.success,
        fields: [
          { name: "User", value: `<@${userId}>`, inline: true },
          { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
          { name: "Remaining Warns", value: String(remaining) },
        ],
      })],
    });

    await sendLog(message.guild, makeEmbed({
      title: "✅ Warning Removed",
      color: COLORS.success,
      fields: [
        { name: "User", value: `<@${userId}>`, inline: true },
        { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
        { name: "Remaining Warns", value: String(remaining) },
      ],
    }));
  } catch (err) {
    logger.error({ err }, "unwarn failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to remove warning." })] });
  }
}

export async function handleMute(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isMod(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **mod**, **admin**, and **co owner** can mute members." })] });
    return;
  }

  const userId = parseTarget(message, args);
  if (!userId) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?mute <@user> [minutes] [reason]`" })] });
    return;
  }

  const rest = args.slice(1);
  let durationMinutes = DEFAULT_MUTE_MINUTES;
  let reason = "No reason provided";

  if (rest.length > 0 && !isNaN(Number(rest[0]))) {
    durationMinutes = Math.min(Math.max(1, Number(rest[0])), 40320);
    reason = rest.slice(1).join(" ") || "No reason provided";
  } else {
    reason = rest.join(" ") || "No reason provided";
  }

  const guild = message.guild;
  const target = await fetchMember(guild, userId);

  if (!target) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ User Not Found", color: COLORS.error, description: "Could not find that member." })] });
    return;
  }

  try {
    const until = new Date(Date.now() + durationMinutes * 60 * 1000);
    await target.disableCommunicationUntil(until, reason);

    await db.insert(modMuteHistory).values({
      guildId: guild.id,
      userId: target.id,
      moderatorId: message.author.id,
      durationMinutes,
      reason,
    });
    saveGuildDataNow(guild.id).catch(() => {});

    await logModAction({ guildId: guild.id, action: "mute", userId: target.id, moderatorId: message.author.id, reason, extra: `${durationMinutes}m` });

    const durationText = durationMinutes >= 60
      ? `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`
      : `${durationMinutes}m`;

    await message.reply({
      embeds: [makeEmbed({
        title: "🔇 Member Muted",
        color: COLORS.mute,
        fields: [
          { name: "User", value: `<@${target.id}> (${target.user.tag})`, inline: true },
          { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
          { name: "Duration", value: durationText, inline: true },
          { name: "Reason", value: reason },
        ],
      })],
    });

    await sendLog(guild, makeEmbed({
      title: "🔇 Member Muted",
      color: COLORS.mute,
      fields: [
        { name: "User", value: `<@${target.id}> (${target.user.tag})`, inline: true },
        { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
        { name: "Duration", value: durationText, inline: true },
        { name: "Reason", value: reason },
      ],
    }));
  } catch (err) {
    logger.error({ err }, "mute failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to mute the user. Make sure I have the **Moderate Members** permission." })] });
  }
}

export async function handleUnmute(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isMod(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **mod**, **admin**, and **co owner** can unmute members." })] });
    return;
  }

  const userId = parseTarget(message, args);
  if (!userId) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?unmute <@user>`" })] });
    return;
  }

  const guild = message.guild;
  const target = await fetchMember(guild, userId);

  if (!target) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ User Not Found", color: COLORS.error, description: "Could not find that member." })] });
    return;
  }

  try {
    await target.disableCommunicationUntil(null, "Unmuted by moderator");

    await db.update(modMuteHistory)
      .set({ unmutedAt: new Date() })
      .where(and(eq(modMuteHistory.guildId, guild.id), eq(modMuteHistory.userId, target.id)));
    saveGuildDataNow(guild.id).catch(() => {});

    await logModAction({ guildId: guild.id, action: "unmute", userId: target.id, moderatorId: message.author.id, reason: "Unmuted" });

    await message.reply({
      embeds: [makeEmbed({
        title: "🔊 Member Unmuted",
        color: COLORS.success,
        fields: [
          { name: "User", value: `<@${target.id}> (${target.user.tag})`, inline: true },
          { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
        ],
      })],
    });

    await sendLog(guild, makeEmbed({
      title: "🔊 Member Unmuted",
      color: COLORS.success,
      fields: [
        { name: "User", value: `<@${target.id}> (${target.user.tag})`, inline: true },
        { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
      ],
    }));
  } catch (err) {
    logger.error({ err }, "unmute failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to unmute the user." })] });
  }
}

export async function handleKick(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isMod(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **mod**, **admin**, and **co owner** can kick members." })] });
    return;
  }

  const userId = parseTarget(message, args);
  if (!userId) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?kick <@user> [reason]`" })] });
    return;
  }

  const reason = args.slice(1).join(" ") || "No reason provided";
  const guild = message.guild;
  const target = await fetchMember(guild, userId);

  if (!target) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ User Not Found", color: COLORS.error, description: "Could not find that member." })] });
    return;
  }

  try {
    await target.kick(reason);
    saveGuildDataNow(guild.id).catch(() => {});
    await logModAction({ guildId: guild.id, action: "kick", userId: target.id, moderatorId: message.author.id, reason });

    await message.reply({
      embeds: [makeEmbed({
        title: "👢 Member Kicked",
        color: COLORS.error,
        fields: [
          { name: "User", value: `${target.user.tag}`, inline: true },
          { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
          { name: "Reason", value: reason },
        ],
      })],
    });

    await sendLog(guild, makeEmbed({
      title: "👢 Member Kicked",
      color: COLORS.error,
      fields: [
        { name: "User", value: `${target.user.tag} (${target.id})`, inline: true },
        { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
        { name: "Reason", value: reason },
      ],
    }));
  } catch (err) {
    logger.error({ err }, "kick failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to kick the user." })] });
  }
}

export async function handleBan(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isAdmin(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **admin** and **co owner** can ban members." })] });
    return;
  }

  const userId = parseTarget(message, args);
  if (!userId) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?ban <@user> [reason]`" })] });
    return;
  }

  const reason = args.slice(1).join(" ") || "No reason provided";
  const guild = message.guild;

  try {
    const target = await fetchMember(guild, userId);
    const tag = target?.user.tag ?? userId;

    await guild.members.ban(userId, { reason });
    saveGuildDataNow(guild.id).catch(() => {});
    await logModAction({ guildId: guild.id, action: "ban", userId, moderatorId: message.author.id, reason });

    await message.reply({
      embeds: [makeEmbed({
        title: "🔨 Member Banned",
        color: COLORS.error,
        fields: [
          { name: "User", value: tag, inline: true },
          { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
          { name: "Reason", value: reason },
        ],
      })],
    });

    await sendLog(guild, makeEmbed({
      title: "🔨 Member Banned",
      color: COLORS.error,
      fields: [
        { name: "User", value: `${tag} (${userId})`, inline: true },
        { name: "Moderator", value: `<@${message.author.id}>`, inline: true },
        { name: "Reason", value: reason },
      ],
    }));
  } catch (err) {
    logger.error({ err }, "ban failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to ban the user." })] });
  }
}

export async function handleWarnHistory(message: Message, args: string[]): Promise<void> {
  if (!message.guild) return;

  const userId = parseTarget(message, args);
  if (!userId) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?history <@user>`" })] });
    return;
  }

  try {
    const warns = await db
      .select()
      .from(modWarns)
      .where(and(eq(modWarns.guildId, message.guild.id), eq(modWarns.userId, userId)))
      .orderBy(desc(modWarns.createdAt))
      .limit(10);

    if (warns.length === 0) {
      await message.reply({ embeds: [makeEmbed({ title: "📋 Warn History", color: COLORS.info, description: `<@${userId}> has no warning history.` })] });
      return;
    }

    const active = warns.filter((w) => w.active).length;
    const lines = warns.map((w, i) =>
      `**${i + 1}.** ${w.active ? "🔴" : "✅"} ${w.reason} — <@${w.moderatorId}> • <t:${Math.floor(w.createdAt.getTime() / 1000)}:R>`
    ).join("\n");

    await message.reply({
      embeds: [makeEmbed({
        title: `📋 Warn History — <@${userId}>`,
        color: COLORS.warning,
        description: `**Active:** ${active} | **Total:** ${warns.length}\n\n${lines}`,
      })],
    });
  } catch (err) {
    logger.error({ err }, "history failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to fetch history." })] });
  }
}

export { getActiveWarnCount, getWarnKicked };
