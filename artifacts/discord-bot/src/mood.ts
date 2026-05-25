import { promises as fs } from "fs";
import path from "path";
import { type Message } from "discord.js";
import { isAdmin, COLORS } from "./permissions.js";
import { makeEmbed } from "./logging.js";
import { DIRS } from "./persistence.js";
import { logger } from "./logger.js";

export type Mood = "happy" | "sad" | "angry" | "tired" | "chaotic" | "neutral";

const MOOD_FILE = path.join(DIRS.configs, "mood.json");

export const MOOD_EMOJIS: Record<Mood, string> = {
  happy: "😄",
  sad: "😢",
  angry: "😡",
  tired: "😴",
  chaotic: "🤪",
  neutral: "😐",
};

const MOOD_COLORS: Record<Mood, number> = {
  happy: 0xFFD700,
  sad: 0x4169E1,
  angry: 0xFF4500,
  tired: 0x808080,
  chaotic: 0xFF00FF,
  neutral: COLORS.info,
};

let currentMood: Mood = "neutral";

async function loadMood(): Promise<void> {
  try {
    const data = await fs.readFile(MOOD_FILE, "utf8");
    const parsed = JSON.parse(data);
    if (parsed.mood) currentMood = parsed.mood as Mood;
  } catch {
    currentMood = "neutral";
  }
}

async function saveMood(): Promise<void> {
  try {
    await fs.mkdir(DIRS.configs, { recursive: true });
    await fs.writeFile(MOOD_FILE, JSON.stringify({ mood: currentMood }, null, 2));
  } catch (err) {
    logger.warn({ err }, "Failed to save mood");
  }
}

loadMood().catch(() => {});

export function getCurrentMood(): Mood {
  return currentMood;
}

export async function handleSetMood(message: Message, args: string[]): Promise<void> {
  if (!message.member || !isAdmin(message.member)) {
    await message.reply({
      embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **admin** and above can set the bot mood." })],
    });
    return;
  }

  const valid: Mood[] = ["happy", "sad", "angry", "tired", "chaotic", "neutral"];
  const moodInput = args[0]?.toLowerCase() as Mood;

  if (!valid.includes(moodInput)) {
    await message.reply({
      embeds: [makeEmbed({
        title: "❌ Invalid Mood",
        color: COLORS.error,
        description: `Choose one: \`${valid.join("`, `")}\``,
      })],
    });
    return;
  }

  currentMood = moodInput;
  await saveMood();

  await message.reply({
    embeds: [makeEmbed({
      title: `${MOOD_EMOJIS[currentMood]} Mood Updated`,
      color: MOOD_COLORS[currentMood],
      description: `Bot mood is now **${currentMood}**.`,
    })],
  });
}

export async function handleMoodCheck(message: Message): Promise<void> {
  await message.reply({
    embeds: [makeEmbed({
      title: `${MOOD_EMOJIS[currentMood]} Current Mood`,
      color: MOOD_COLORS[currentMood],
      description: `I'm feeling **${currentMood}** right now.`,
    })],
  });
}

export async function handleRate(message: Message, args: string[]): Promise<void> {
  const mentionMatch = args[0]?.match(/^<@!?(\d+)>$/);
  if (!mentionMatch) {
    await message.reply({
      embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?rate <@user>`" })],
    });
    return;
  }

  const targetId = mentionMatch[1]!;
  let rating = Math.floor(Math.random() * 10) + 1;

  switch (currentMood) {
    case "happy":   rating = Math.min(10, rating + Math.floor(Math.random() * 2) + 1); break;
    case "sad":     rating = Math.max(1,  rating - Math.floor(Math.random() * 2) - 1); break;
    case "angry":   rating = Math.max(1,  Math.floor(Math.random() * 4) + 1); break;
    case "chaotic": rating = Math.floor(Math.random() * 10) + 1; break;
    case "tired":   rating = Math.min(7,  Math.max(3, rating)); break;
    default: break;
  }

  const emoji = rating >= 8 ? "🔥" : rating >= 5 ? "👍" : rating >= 3 ? "😐" : "💀";
  const moodNote = currentMood !== "neutral" ? ` *(mood: ${currentMood})*` : "";

  await message.reply({
    embeds: [makeEmbed({
      title: `${emoji} Rating`,
      color: COLORS.info,
      description: `<@${targetId}> gets a **${rating}/10**${moodNote}`,
    })],
  });
}
