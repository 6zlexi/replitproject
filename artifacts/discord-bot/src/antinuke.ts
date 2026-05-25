import {
  type Client,
  type Guild,
  type GuildAuditLogsEntry,
  type Message,
  AuditLogEvent,
  EmbedBuilder,
} from "discord.js";
import { db } from "@workspace/db";
import { whitelistedBots } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { isCoOwner, COLORS } from "./permissions.js";
import { sendLog, makeEmbed } from "./logging.js";
import { saveGuildDataNow } from "./persistence.js";
import { logger } from "./logger.js";

interface RateBucket {
  timestamps: number[];
}

const channelDeleteBuckets = new Map<string, RateBucket>();
const roleDeleteBuckets = new Map<string, RateBucket>();
const banBuckets = new Map<string, RateBucket>();
const webhookBuckets = new Map<string, RateBucket>();

const WINDOW_MS = 10_000;
const CHANNEL_DELETE_THRESHOLD = 3;
const ROLE_DELETE_THRESHOLD = 2;
const BAN_THRESHOLD = 3;
const WEBHOOK_THRESHOLD = 3;

function addToRateBucket(buckets: Map<string, RateBucket>, key: string): number {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { timestamps: [] };
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < WINDOW_MS);
  bucket.timestamps.push(now);
  buckets.set(key, bucket);
  return bucket.timestamps.length;
}

async function isWhitelistedBot(guildId: string, botId: string): Promise<boolean> {
  try {
    const result = await db
      .select()
      .from(whitelistedBots)
      .where(and(eq(whitelistedBots.guildId, guildId), eq(whitelistedBots.botId, botId)))
      .limit(1);
    return result.length > 0;
  } catch {
    return false;
  }
}

async function nukeResponse(guild: Guild, executorId: string, reason: string): Promise<void> {
  try {
    const isOwner = executorId === guild.ownerId;
    if (isOwner) return;

    const whitelisted = await isWhitelistedBot(guild.id, executorId);
    if (whitelisted) return;

    await guild.members.ban(executorId, { reason: `[Anti-Nuke] ${reason}` });

    await sendLog(guild, makeEmbed({
      title: "🚨 Anti-Nuke Triggered",
      color: COLORS.antinuke,
      fields: [
        { name: "Executor Banned", value: `<@${executorId}>`, inline: true },
        { name: "Reason", value: reason },
      ],
      footer: "Anti-Nuke System",
    }));

    logger.warn({ guildId: guild.id, executorId, reason }, "Anti-nuke triggered");
  } catch (err) {
    logger.error({ err }, "Anti-nuke response failed");
  }
}

async function getAuditExecutor(
  guild: Guild,
  event: AuditLogEvent
): Promise<string | null> {
  try {
    const logs = await guild.fetchAuditLogs({ limit: 1, type: event });
    const entry = logs.entries.first();
    if (!entry) return null;
    if (Date.now() - entry.createdTimestamp > 5000) return null;
    return entry.executor?.id ?? null;
  } catch {
    return null;
  }
}

export function initAntiNuke(client: Client): void {
  client.on("channelDelete", async (channel) => {
    if (!("guild" in channel) || !channel.guild) return;
    const guild = channel.guild;

    const executorId = await getAuditExecutor(guild, AuditLogEvent.ChannelDelete);
    if (!executorId || executorId === client.user?.id) return;

    const whitelisted = await isWhitelistedBot(guild.id, executorId);
    if (whitelisted) return;

    const count = addToRateBucket(channelDeleteBuckets, `${guild.id}:${executorId}`);
    if (count >= CHANNEL_DELETE_THRESHOLD) {
      await nukeResponse(guild, executorId, `Mass channel deletion (${count} channels in 10s)`);
    }
  });

  client.on("roleDelete", async (role) => {
    const guild = role.guild;

    const executorId = await getAuditExecutor(guild, AuditLogEvent.RoleDelete);
    if (!executorId || executorId === client.user?.id) return;

    const whitelisted = await isWhitelistedBot(guild.id, executorId);
    if (whitelisted) return;

    const count = addToRateBucket(roleDeleteBuckets, `${guild.id}:${executorId}`);
    if (count >= ROLE_DELETE_THRESHOLD) {
      await nukeResponse(guild, executorId, `Mass role deletion (${count} roles in 10s)`);
    }
  });

  client.on("guildBanAdd", async (ban) => {
    const guild = ban.guild;

    const executorId = await getAuditExecutor(guild, AuditLogEvent.MemberBanAdd);
    if (!executorId || executorId === client.user?.id) return;

    const whitelisted = await isWhitelistedBot(guild.id, executorId);
    if (whitelisted) return;

    const count = addToRateBucket(banBuckets, `${guild.id}:${executorId}`);
    if (count >= BAN_THRESHOLD) {
      await nukeResponse(guild, executorId, `Mass banning (${count} bans in 10s)`);
    }
  });

  client.on("webhookUpdate", async (channel) => {
    if (!channel.guild) return;
    const guild = channel.guild;

    const executorId = await getAuditExecutor(guild, AuditLogEvent.WebhookCreate);
    if (!executorId || executorId === client.user?.id) return;

    const whitelisted = await isWhitelistedBot(guild.id, executorId);
    if (whitelisted) return;

    const count = addToRateBucket(webhookBuckets, `${guild.id}:${executorId}`);
    if (count >= WEBHOOK_THRESHOLD) {
      await nukeResponse(guild, executorId, `Webhook abuse (${count} webhooks in 10s)`);
    }
  });

  client.on("guildMemberAdd", async (member) => {
    if (!member.user.bot) return;
    const guild = member.guild;

    const whitelisted = await isWhitelistedBot(guild.id, member.id);
    if (whitelisted) return;

    try {
      const logs = await guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.BotAdd });
      const entry = logs.entries.first();
      if (!entry || Date.now() - entry.createdTimestamp > 10000) return;

      const addedBy = entry.executor?.id;
      if (!addedBy || addedBy === guild.ownerId) return;

      const adder = await guild.members.fetch(addedBy).catch(() => null);
      if (!adder) return;

      if (!isCoOwner(adder)) {
        await member.kick("Suspicious bot added by non-privileged user");
        await sendLog(guild, makeEmbed({
          title: "🤖 Suspicious Bot Removed",
          color: COLORS.antinuke,
          fields: [
            { name: "Bot", value: `<@${member.id}> (${member.user.tag})`, inline: true },
            { name: "Added By", value: `<@${addedBy}>`, inline: true },
            { name: "Action", value: "Bot kicked (not whitelisted, added by non-staff)" },
          ],
        }));
      }
    } catch (err) {
      logger.warn({ err }, "Suspicious bot check failed");
    }
  });

  logger.info("Anti-nuke system initialized");
}

export async function handleWhitelistBot(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isCoOwner(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **co owner** and **owner** can manage the bot whitelist." })] });
    return;
  }

  const mentionMatch = args[0]?.match(/^<@!?(\d+)>$/);
  const botId = mentionMatch?.[1] ?? args[0];
  if (!botId?.match(/^\d+$/)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?whitelistbot <@bot>`" })] });
    return;
  }

  try {
    await db.insert(whitelistedBots)
      .values({ guildId: message.guild.id, botId, addedBy: message.author.id })
      .onConflictDoNothing();
    saveGuildDataNow(message.guild.id).catch(() => {});

    await message.reply({ embeds: [makeEmbed({ title: "✅ Bot Whitelisted", color: COLORS.success, description: `<@${botId}> has been whitelisted from anti-nuke.` })] });
  } catch (err) {
    logger.error({ err }, "whitelistbot failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to whitelist bot." })] });
  }
}

export async function handleUnwhitelistBot(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isCoOwner(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **co owner** and **owner** can manage the bot whitelist." })] });
    return;
  }

  const mentionMatch = args[0]?.match(/^<@!?(\d+)>$/);
  const botId = mentionMatch?.[1] ?? args[0];
  if (!botId?.match(/^\d+$/)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?unwhitelistbot <@bot>`" })] });
    return;
  }

  try {
    await db.delete(whitelistedBots)
      .where(and(eq(whitelistedBots.guildId, message.guild.id), eq(whitelistedBots.botId, botId)));
    saveGuildDataNow(message.guild.id).catch(() => {});

    await message.reply({ embeds: [makeEmbed({ title: "✅ Bot Removed", color: COLORS.success, description: `<@${botId}> has been removed from the whitelist.` })] });
  } catch (err) {
    logger.error({ err }, "unwhitelistbot failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to remove bot from whitelist." })] });
  }
}

export async function handleWhitelistedBots(message: Message): Promise<void> {
  if (!message.guild) return;

  try {
    const bots = await db
      .select()
      .from(whitelistedBots)
      .where(eq(whitelistedBots.guildId, message.guild.id));

    if (bots.length === 0) {
      await message.reply({ embeds: [makeEmbed({ title: "🤖 Whitelisted Bots", color: COLORS.info, description: "No bots are whitelisted." })] });
      return;
    }

    const list = bots.map((b, i) => `**${i + 1}.** <@${b.botId}> — added by <@${b.addedBy}>`).join("\n");
    await message.reply({ embeds: [makeEmbed({ title: `🤖 Whitelisted Bots (${bots.length})`, color: COLORS.info, description: list })] });
  } catch (err) {
    logger.error({ err }, "whitelistedbots failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to fetch whitelist." })] });
  }
}
