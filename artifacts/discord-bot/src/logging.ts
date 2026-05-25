import { EmbedBuilder, type Guild, type TextChannel } from "discord.js";
import { logger } from "./logger.js";
import { db } from "@workspace/db";
import { modActions } from "@workspace/db";

const LOGS_CHANNEL = "logs";

export async function getLogsChannel(guild: Guild): Promise<TextChannel | null> {
  try {
    const ch = guild.channels.cache.find(
      (c) => c.name.toLowerCase().includes(LOGS_CHANNEL) && c.isTextBased()
    ) as TextChannel | undefined;
    return ch ?? null;
  } catch {
    return null;
  }
}

export async function sendLog(guild: Guild, embed: EmbedBuilder): Promise<void> {
  try {
    const ch = await getLogsChannel(guild);
    if (!ch) return;
    await ch.send({ embeds: [embed] });
  } catch (err) {
    logger.warn({ err }, "Failed to send log embed");
  }
}

export async function logModAction(opts: {
  guildId: string;
  action: string;
  userId: string;
  moderatorId: string;
  reason?: string;
  extra?: string;
}): Promise<void> {
  try {
    await db.insert(modActions).values({
      guildId: opts.guildId,
      action: opts.action,
      userId: opts.userId,
      moderatorId: opts.moderatorId,
      reason: opts.reason ?? "No reason provided",
      extra: opts.extra,
    });
  } catch (err) {
    logger.warn({ err }, "Failed to log mod action to DB");
  }
}

export function makeEmbed(opts: {
  title: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  description?: string;
  thumbnail?: string;
  footer?: string;
}): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(opts.title)
    .setColor(opts.color)
    .setTimestamp();

  if (opts.description) e.setDescription(opts.description);
  if (opts.thumbnail) e.setThumbnail(opts.thumbnail);
  if (opts.footer) e.setFooter({ text: opts.footer });
  if (opts.fields && opts.fields.length > 0) e.addFields(opts.fields);

  return e;
}
