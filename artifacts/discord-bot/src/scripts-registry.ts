import { type Message, EmbedBuilder } from "discord.js";
import { db } from "@workspace/db";
import { scripts } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { isAdmin, COLORS } from "./permissions.js";
import { makeEmbed } from "./logging.js";
import { saveGuildDataNow } from "./persistence.js";
import { logger } from "./logger.js";

const STATUS_EMOJIS: Record<string, string> = {
  online: "🟢",
  offline: "🔴",
  maintenance: "🟡",
};

const STATUS_COLORS: Record<string, number> = {
  online: COLORS.success,
  offline: COLORS.error,
  maintenance: COLORS.warning,
};

export async function handleScript(message: Message, args: string[]): Promise<void> {
  if (!message.guild) return;

  const name = args.join(" ").trim();
  if (!name) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?script <name>` — show script information" })] });
    return;
  }

  try {
    const results = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.guildId, message.guild.id), eq(scripts.name, name)));

    if (results.length === 0) {
      await message.reply({ embeds: [makeEmbed({ title: "❌ Script Not Found", color: COLORS.error, description: `No script named **${name}** found. Use \`?addscript\` to add it.` })] });
      return;
    }

    const script = results[0]!;
    const emoji = STATUS_EMOJIS[script.status] ?? "⚪";
    const color = STATUS_COLORS[script.status] ?? COLORS.info;

    await message.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`📜 ${script.name}`)
        .setColor(color)
        .setDescription(script.description)
        .addFields(
          { name: "Author", value: script.author, inline: true },
          { name: "Status", value: `${emoji} ${script.status.charAt(0).toUpperCase() + script.status.slice(1)}`, inline: true },
          { name: "Added", value: `<t:${Math.floor(script.createdAt.getTime() / 1000)}:R>`, inline: true },
          { name: "Updated", value: `<t:${Math.floor(script.updatedAt.getTime() / 1000)}:R>`, inline: true },
        )
        .setTimestamp()],
    });
  } catch (err) {
    logger.error({ err }, "script command failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to fetch script info." })] });
  }
}

export async function handleStatus(message: Message, args: string[]): Promise<void> {
  if (!message.guild) return;

  const name = args.join(" ").trim();
  if (!name) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?status <name>` — show script status" })] });
    return;
  }

  try {
    const results = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.guildId, message.guild.id), eq(scripts.name, name)));

    if (results.length === 0) {
      await message.reply({ embeds: [makeEmbed({ title: "❌ Script Not Found", color: COLORS.error, description: `No script named **${name}** found.` })] });
      return;
    }

    const script = results[0]!;
    const emoji = STATUS_EMOJIS[script.status] ?? "⚪";
    const color = STATUS_COLORS[script.status] ?? COLORS.info;

    await message.reply({
      embeds: [makeEmbed({
        title: `${emoji} ${script.name} — Status`,
        color,
        description: `**${script.status.charAt(0).toUpperCase() + script.status.slice(1)}**`,
        fields: [{ name: "Last Updated", value: `<t:${Math.floor(script.updatedAt.getTime() / 1000)}:R>` }],
      })],
    });
  } catch (err) {
    logger.error({ err }, "status command failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to fetch script status." })] });
  }
}

export async function handleAddScript(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isAdmin(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **admin** and **co owner** can add scripts." })] });
    return;
  }

  const raw = args.join(" ");
  const parts = raw.split("|").map((p) => p.trim());

  if (parts.length < 1 || !parts[0]) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?addscript <name> | <description> | <author>`" })] });
    return;
  }

  const name = parts[0]!;
  const description = parts[1] || "No description";
  const author = parts[2] || message.author.username;

  try {
    const existing = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.guildId, message.guild.id), eq(scripts.name, name)))
      .limit(1);

    if (existing.length > 0) {
      await db.update(scripts)
        .set({ description, author, updatedAt: new Date() })
        .where(and(eq(scripts.guildId, message.guild.id), eq(scripts.name, name)));
      saveGuildDataNow(message.guild.id).catch(() => {});

      await message.reply({ embeds: [makeEmbed({ title: "✅ Script Updated", color: COLORS.success, description: `**${name}** has been updated.`, fields: [{ name: "Description", value: description }, { name: "Author", value: author }] })] });
    } else {
      await db.insert(scripts).values({
        guildId: message.guild.id,
        name,
        description,
        author,
        status: "online",
      });
      saveGuildDataNow(message.guild.id).catch(() => {});

      await message.reply({ embeds: [makeEmbed({ title: "✅ Script Added", color: COLORS.success, description: `**${name}** has been added.`, fields: [{ name: "Description", value: description }, { name: "Author", value: author }, { name: "Status", value: "🟢 Online" }] })] });
    }
  } catch (err) {
    logger.error({ err }, "addscript failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to add/update script." })] });
  }
}

export async function handleSetStatus(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isAdmin(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **admin** and **co owner** can set script status." })] });
    return;
  }

  const raw = args.join(" ");
  const pipeIdx = raw.lastIndexOf("|");

  if (pipeIdx === -1) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?setstatus <name> | <status>`\nStatus options: `online`, `offline`, `maintenance`" })] });
    return;
  }

  const name = raw.slice(0, pipeIdx).trim();
  const newStatus = raw.slice(pipeIdx + 1).trim().toLowerCase();

  if (!["online", "offline", "maintenance"].includes(newStatus)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Invalid Status", color: COLORS.error, description: "Status must be `online`, `offline`, or `maintenance`." })] });
    return;
  }

  try {
    const existing = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.guildId, message.guild.id), eq(scripts.name, name)))
      .limit(1);

    if (existing.length === 0) {
      await message.reply({ embeds: [makeEmbed({ title: "❌ Script Not Found", color: COLORS.error, description: `No script named **${name}** found.` })] });
      return;
    }

    await db.update(scripts)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(and(eq(scripts.guildId, message.guild.id), eq(scripts.name, name)));
    saveGuildDataNow(message.guild.id).catch(() => {});

    const emoji = STATUS_EMOJIS[newStatus] ?? "⚪";
    const color = STATUS_COLORS[newStatus] ?? COLORS.info;

    await message.reply({ embeds: [makeEmbed({ title: `${emoji} Status Updated`, color, description: `**${name}** is now **${newStatus}**.` })] });
  } catch (err) {
    logger.error({ err }, "setstatus failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to update script status." })] });
  }
}
