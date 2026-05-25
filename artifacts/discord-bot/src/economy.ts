import { promises as fs } from "fs";
import path from "path";
import { type Message, type Client, EmbedBuilder, type TextChannel } from "discord.js";
import { COLORS } from "./permissions.js";
import { makeEmbed } from "./logging.js";
import { DIRS } from "./persistence.js";
import { logger } from "./logger.js";

interface UserEconomy {
  coins: number;
  lastDaily: string | null;
  lastWork: number;
  lastCrime: number;
  streak: number;
  xp: number;
  level: number;
}

type GuildEconomy = Record<string, UserEconomy>;

function econPath(guildId: string): string {
  return path.join(DIRS.guilds, guildId, "economy.json");
}

async function loadEcon(guildId: string): Promise<GuildEconomy> {
  try {
    return JSON.parse(await fs.readFile(econPath(guildId), "utf8"));
  } catch {
    return {};
  }
}

async function saveEcon(guildId: string, data: GuildEconomy): Promise<void> {
  try {
    await fs.mkdir(path.dirname(econPath(guildId)), { recursive: true });
    await fs.writeFile(econPath(guildId), JSON.stringify(data, null, 2));
  } catch (err) {
    logger.warn({ err }, "Failed to save economy");
  }
}

function getUser(econ: GuildEconomy, userId: string): UserEconomy {
  if (!econ[userId]) {
    econ[userId] = { coins: 0, lastDaily: null, lastWork: 0, lastCrime: 0, streak: 0, xp: 0, level: 1 };
  }
  return econ[userId]!;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function xpForLevel(level: number): number {
  return 500 * level;
}

function levelFromXP(xp: number): number {
  let level = 1;
  let needed = 0;
  while (xp >= needed + xpForLevel(level)) {
    needed += xpForLevel(level);
    level++;
  }
  return level;
}

function xpInCurrentLevel(xp: number, level: number): number {
  let total = 0;
  for (let l = 1; l < level; l++) total += xpForLevel(l);
  return xp - total;
}

export async function addXP(
  guildId: string,
  userId: string,
  xpGain: number,
  client?: Client
): Promise<void> {
  const econ = await loadEcon(guildId);
  const user = getUser(econ, userId);
  const oldLevel = user.level;
  user.xp += xpGain;
  user.level = levelFromXP(user.xp);
  await saveEcon(guildId, econ);

  if (client && user.level > oldLevel) {
    try {
      const guild = client.guilds.cache.get(guildId);
      const ch = guild?.channels.cache.find(
        (c) => c.name.toLowerCase() === "levels" && c.isTextBased()
      ) as TextChannel | undefined;

      if (ch) {
        const member = await guild?.members.fetch(userId).catch(() => null);
        const current = xpInCurrentLevel(user.xp, user.level);
        const needed = xpForLevel(user.level);

        await ch.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("🎉 Level Up!")
              .setColor(COLORS.success)
              .setThumbnail(member?.user.displayAvatarURL({ size: 256 }) ?? null)
              .setDescription(`<@${userId}> has leveled up to **Level ${user.level}**!`)
              .addFields(
                { name: "New Level",          value: `**${user.level}**`,        inline: true },
                { name: "XP to Next Level",   value: `${current} / ${needed}`,   inline: true }
              )
              .setTimestamp(),
          ],
        });
      }
    } catch (err) {
      logger.warn({ err }, "Level-up announcement failed");
    }
  }
}

export async function handleBalance(message: Message, args: string[]): Promise<void> {
  if (!message.guild) return;
  const mentionMatch = args[0]?.match(/^<@!?(\d+)>$/);
  const targetId = mentionMatch ? mentionMatch[1]! : message.author.id;

  const econ = await loadEcon(message.guild.id);
  const user = getUser(econ, targetId);
  const current = xpInCurrentLevel(user.xp, user.level);
  const needed = xpForLevel(user.level);

  await message.reply({
    embeds: [makeEmbed({
      title: "💰 Balance",
      color: COLORS.info,
      fields: [
        { name: "User",    value: `<@${targetId}>`,                      inline: true },
        { name: "Coins",   value: `**${user.coins.toLocaleString()}** 🪙`, inline: true },
        { name: "Level",   value: `**${user.level}**`,                    inline: true },
        { name: "XP",      value: `${current} / ${needed}`,               inline: true },
        { name: "Streak",  value: `${user.streak} days 🔥`,               inline: true },
      ],
    })],
  });
}

const WORK_CD = 4 * 60 * 60 * 1000;
const CRIME_CD = 8 * 60 * 60 * 1000;

export async function handleDaily(message: Message): Promise<void> {
  if (!message.guild) return;

  const econ = await loadEcon(message.guild.id);
  const user = getUser(econ, message.author.id);
  const today = todayStr();
  const yesterday = yesterdayStr();

  if (user.lastDaily === today) {
    await message.reply({
      embeds: [makeEmbed({ title: "⏰ Already Claimed", color: COLORS.warning, description: "Come back tomorrow for your next daily reward." })],
    });
    return;
  }

  user.streak = user.lastDaily === yesterday ? user.streak + 1 : 1;
  const reward = 200 + user.streak * 10;
  user.coins += reward;
  user.lastDaily = today;

  await saveEcon(message.guild.id, econ);

  await message.reply({
    embeds: [makeEmbed({
      title: "💰 Daily Reward",
      color: COLORS.success,
      fields: [
        { name: "Earned",  value: `**+${reward}** 🪙 *(200 base + ${user.streak * 10} streak)*` },
        { name: "Balance", value: `**${user.coins.toLocaleString()}** 🪙`, inline: true },
        { name: "Streak",  value: `**${user.streak}** days 🔥`,            inline: true },
      ],
    })],
  });
}

export async function handleWork(message: Message): Promise<void> {
  if (!message.guild) return;

  const econ = await loadEcon(message.guild.id);
  const user = getUser(econ, message.author.id);
  const now = Date.now();

  if (now - user.lastWork < WORK_CD) {
    const rem = WORK_CD - (now - user.lastWork);
    const h = Math.floor(rem / 3600000);
    const m = Math.floor((rem % 3600000) / 60000);
    await message.reply({
      embeds: [makeEmbed({ title: "⏰ Still Working", color: COLORS.warning, description: `Too tired. Come back in **${h}h ${m}m**.` })],
    });
    return;
  }

  const jobs = ["delivered packages", "washed dishes", "walked dogs", "coded a website",
    "drove a taxi", "bagged groceries", "fixed a computer", "mowed lawns", "tutored a student"];
  const job = jobs[Math.floor(Math.random() * jobs.length)]!;
  const reward = Math.floor(Math.random() * 101) + 50;
  user.coins += reward;
  user.lastWork = now;

  await saveEcon(message.guild.id, econ);

  await message.reply({
    embeds: [makeEmbed({
      title: "💼 Work",
      color: COLORS.success,
      description: `You **${job}** and earned **+${reward}** 🪙`,
      fields: [{ name: "Balance", value: `**${user.coins.toLocaleString()}** 🪙`, inline: true }],
    })],
  });
}

export async function handleCrime(message: Message): Promise<void> {
  if (!message.guild) return;

  const econ = await loadEcon(message.guild.id);
  const user = getUser(econ, message.author.id);
  const now = Date.now();

  if (now - user.lastCrime < CRIME_CD) {
    const rem = CRIME_CD - (now - user.lastCrime);
    const h = Math.floor(rem / 3600000);
    const m = Math.floor((rem % 3600000) / 60000);
    await message.reply({
      embeds: [makeEmbed({ title: "⏰ Laying Low", color: COLORS.warning, description: `Staying hidden. Back in **${h}h ${m}m**.` })],
    });
    return;
  }

  user.lastCrime = now;
  const success = Math.random() < 0.4;

  if (success) {
    const reward = Math.floor(Math.random() * 201) + 100;
    user.coins += reward;
    await saveEcon(message.guild.id, econ);
    await message.reply({
      embeds: [makeEmbed({
        title: "🦹 Crime Pays",
        color: COLORS.success,
        description: `You pulled it off and got away with **+${reward}** 🪙`,
        fields: [{ name: "Balance", value: `**${user.coins.toLocaleString()}** 🪙`, inline: true }],
      })],
    });
  } else {
    const fine = Math.min(user.coins, Math.floor(Math.random() * 101) + 50);
    user.coins -= fine;
    await saveEcon(message.guild.id, econ);
    await message.reply({
      embeds: [makeEmbed({
        title: "🚔 Caught",
        color: COLORS.error,
        description: `You got caught and were fined **-${fine}** 🪙`,
        fields: [{ name: "Balance", value: `**${user.coins.toLocaleString()}** 🪙`, inline: true }],
      })],
    });
  }
}

export async function handleLeaderboard(message: Message): Promise<void> {
  if (!message.guild) return;

  const econ = await loadEcon(message.guild.id);
  const sorted = Object.entries(econ)
    .sort(([, a], [, b]) => b.coins - a.coins)
    .slice(0, 10);

  if (sorted.length === 0) {
    await message.reply({ embeds: [makeEmbed({ title: "💰 Leaderboard", color: COLORS.info, description: "No economy data yet. Use `?daily` to get started!" })] });
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = sorted.map(([userId, data], i) =>
    `${medals[i] ?? `**${i + 1}.**`} <@${userId}> — **${data.coins.toLocaleString()}** 🪙`
  ).join("\n");

  await message.reply({
    embeds: [makeEmbed({ title: "💰 Coin Leaderboard", color: COLORS.info, description: lines })],
  });
}

export async function handleStreak(message: Message): Promise<void> {
  if (!message.guild) return;

  const econ = await loadEcon(message.guild.id);
  const user = getUser(econ, message.author.id);
  const today = todayStr();
  const yesterday = yesterdayStr();
  const active = user.lastDaily === today || user.lastDaily === yesterday;

  await message.reply({
    embeds: [makeEmbed({
      title: "🔥 Daily Streak",
      color: active ? COLORS.success : COLORS.warning,
      fields: [
        { name: "Streak", value: `**${user.streak}** days`, inline: true },
        { name: "Status", value: active ? "✅ Active" : "⚠️ Use `?daily` to keep it!", inline: true },
      ],
    })],
  });
}
