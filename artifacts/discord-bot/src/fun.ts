import { type Message } from "discord.js";
import { COLORS } from "./permissions.js";
import { makeEmbed } from "./logging.js";

function seededRandom(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) / 2147483647;
}

function dateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function handleIQ(message: Message, args: string[]): Promise<void> {
  const mentionMatch = args[0]?.match(/^<@!?(\d+)>$/);
  const targetId = mentionMatch ? mentionMatch[1]! : message.author.id;

  const seed = `iq:${targetId}:${dateKey()}`;
  const iq = Math.floor(seededRandom(seed) * 111) + 50;

  const label =
    iq >= 140 ? "Genius 🧠" :
    iq >= 120 ? "Very Smart 📚" :
    iq >= 100 ? "Average 😐" :
    iq >= 80  ? "Below Average 🐢" :
    "Literally a Rock 🪨";

  await message.reply({
    embeds: [makeEmbed({
      title: "🧠 IQ Test",
      color: COLORS.brain,
      fields: [
        { name: "User",     value: `<@${targetId}>`, inline: true },
        { name: "IQ Score", value: `**${iq}**`,      inline: true },
        { name: "Rating",   value: label,             inline: true },
      ],
    })],
  });
}

export async function handleShip(message: Message, args: string[]): Promise<void> {
  const mentionMatch1 = args[0]?.match(/^<@!?(\d+)>$/);
  const mentionMatch2 = args[1]?.match(/^<@!?(\d+)>$/);

  if (!mentionMatch1 || !mentionMatch2) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?ship <@user1> <@user2>` — provide exactly 2 users" })] });
    return;
  }

  const user1 = mentionMatch1[1]!;
  const user2 = mentionMatch2[1]!;

  if (user1 === user2) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Can't ship someone with themselves." })] });
    return;
  }

  const sorted = [user1, user2].sort().join(":");
  const seed = `ship:${sorted}:${dateKey()}`;
  const pct = Math.floor(seededRandom(seed) * 101);

  const filled = Math.floor(pct / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const label =
    pct >= 90 ? "Perfect Match 💍" :
    pct >= 70 ? "Strong Connection 💕" :
    pct >= 50 ? "Could Work 💛" :
    pct >= 30 ? "Unlikely 😬" :
    "Not a Chance 💔";

  await message.reply({
    embeds: [makeEmbed({
      title: "💘 Ship",
      color: pct >= 70 ? COLORS.success : pct >= 40 ? COLORS.warning : COLORS.error,
      description: `<@${user1}> ❤️ <@${user2}>`,
      fields: [
        { name: "Compatibility", value: `**${pct}%** ${bar}` },
        { name: "Verdict",       value: label, inline: true },
      ],
    })],
  });
}

export async function handleSimp(message: Message, args: string[]): Promise<void> {
  const mentionMatch = args[0]?.match(/^<@!?(\d+)>$/);
  if (!mentionMatch) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?simp <@user>`" })] });
    return;
  }

  const targetId = mentionMatch[1]!;
  const seed = `simp:${message.author.id}:${targetId}:${dateKey()}`;
  const pct = Math.floor(seededRandom(seed) * 101);

  const label =
    pct >= 90 ? "Certified Simp 🛐" :
    pct >= 60 ? "Pretty Simpy 😅" :
    pct >= 30 ? "Kinda Simping 🤔" :
    "Hardly Simping 😎";

  await message.reply({
    embeds: [makeEmbed({
      title: "🛐 Simp Meter",
      color: COLORS.mute,
      description: `<@${message.author.id}> simps for <@${targetId}> at **${pct}%**`,
      fields: [{ name: "Verdict", value: label, inline: true }],
    })],
  });
}
