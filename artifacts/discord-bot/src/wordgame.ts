import {
  type Message,
  type TextChannel,
  EmbedBuilder,
} from "discord.js";
import { isCoOwner } from "./permissions.js";
import { makeEmbed } from "./logging.js";
import { addXP } from "./economy.js";
import { logger } from "./logger.js";

const BLACK = 0x000000;

// ── Word list (lazy-loaded on first game) ─────────────────────────────────────
let WORD_SET = new Set<string>();
let WORD_LIST: string[] = [];
let wordListReady = false;

async function initWordList(): Promise<void> {
  if (wordListReady) return;
  const { default: raw } = await import("an-array-of-english-words");
  for (const w of raw as string[]) {
    const lower = w.toLowerCase();
    if (lower.length >= 4 && lower.length <= 9 && /^[a-z]+$/.test(lower)) {
      WORD_SET.add(lower);
      WORD_LIST.push(lower);
    }
  }
  wordListReady = true;
  logger.info({ wordCount: WORD_LIST.length }, "Word list loaded");
}

// ── Game state (exported so ?hint and ?extraheart can read/modify it) ──────────
export interface Player {
  id: string;
  username: string;
  hearts: number;
}

export interface GameRound {
  letters: string[];
  hintWord: string;
  currentPlayerId: string;
}

export interface ActiveGame {
  players: Player[];
  currentRound: GameRound | null;
}

const activeGameStates = new Map<string, ActiveGame>();

export function getActiveGame(guildId: string): ActiveGame | undefined {
  return activeGameStates.get(guildId);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function heartDisplay(hearts: number): string {
  return "❤️".repeat(Math.max(0, hearts)) + "🖤".repeat(Math.max(0, 3 - hearts));
}

function pickRoundChallenge(): { letters: string[]; hintWord: string } {
  const word = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)]!;
  const uniqueLetters = [...new Set(word.split(""))];
  const count = Math.min(Math.random() < 0.4 ? 3 : 2, uniqueLetters.length);
  const shuffled = [...uniqueLetters].sort(() => Math.random() - 0.5);
  const letters = shuffled.slice(0, count);
  return { letters, hintWord: word };
}

function isValidAnswer(word: string, letters: string[]): boolean {
  const lower = word.toLowerCase().trim();
  return (
    lower.length >= 2 &&
    WORD_SET.has(lower) &&
    letters.every((l) => lower.includes(l))
  );
}

// ── ?hint (owner / co-owner only, during active round) ───────────────────────
export async function handleHint(message: Message): Promise<void> {
  if (!message.guild || !message.member) return;

  if (!isCoOwner(message.member)) {
    await message.reply({
      embeds: [makeEmbed({ title: "❌ No Permission", color: BLACK, description: "Only `- owner` and `- co owner` can use `?hint`." })],
    });
    return;
  }

  const game = activeGameStates.get(message.guild.id);
  if (!game || !game.currentRound) {
    await message.reply({
      embeds: [makeEmbed({ title: "❌ No Active Round", color: BLACK, description: "No game round is currently running." })],
    });
    return;
  }

  const { hintWord, letters } = game.currentRound;
  // Pattern: show required letters in position, hide the rest with _
  const pattern = hintWord
    .split("")
    .map((c) => (letters.includes(c) ? c : "_"))
    .join(" ");

  await message.reply({
    embeds: [makeEmbed({
      title: "💡 Hint",
      color: BLACK,
      fields: [
        { name: "Word Length", value: `**${hintWord.length}** letters`, inline: true },
        { name: "Starts With", value: `**${hintWord[0]!.toUpperCase()}**`, inline: true },
        { name: "Pattern",     value: `\`${pattern}\``, inline: false },
      ],
    })],
  });
}

// ── ?extraheart (owner / co-owner only) ──────────────────────────────────────
export async function handleExtraHeart(message: Message, args: string[]): Promise<void> {
  if (!message.guild || !message.member) return;

  if (!isCoOwner(message.member)) {
    await message.reply({
      embeds: [makeEmbed({ title: "❌ No Permission", color: BLACK, description: "Only `- owner` and `- co owner` can give extra hearts." })],
    });
    return;
  }

  const mentionMatch = args[0]?.match(/^<@!?(\d+)>$/);
  if (!mentionMatch) {
    await message.reply({
      embeds: [makeEmbed({ title: "❌ Usage", color: BLACK, description: "`?extraheart <@user>`" })],
    });
    return;
  }

  const targetId = mentionMatch[1]!;
  const game = activeGameStates.get(message.guild.id);

  if (!game) {
    await message.reply({
      embeds: [makeEmbed({ title: "❌ No Active Game", color: BLACK, description: "There is no active game in this server right now." })],
    });
    return;
  }

  const player = game.players.find((p) => p.id === targetId);
  if (!player) {
    await message.reply({
      embeds: [makeEmbed({ title: "❌ Not In Game", color: BLACK, description: `<@${targetId}> is not in the current game.` })],
    });
    return;
  }

  if (player.hearts >= 3) {
    await message.reply({
      embeds: [makeEmbed({ title: "❤️ Already Full", color: BLACK, description: `<@${targetId}> already has the maximum **3** hearts.` })],
    });
    return;
  }

  player.hearts++;
  await message.reply({
    embeds: [makeEmbed({
      title: "❤️ Extra Heart Given!",
      color: BLACK,
      description: `<@${targetId}> received **+1 heart**!\n${heartDisplay(player.hearts)}`,
    })],
  });
}

// ── Main game entry ───────────────────────────────────────────────────────────
export async function handleWordGame(message: Message): Promise<void> {
  if (!message.guild) return;
  const guildId = message.guild.id;
  const channel = message.channel as TextChannel;

  if (activeGameStates.has(guildId)) {
    await message.reply({
      embeds: [makeEmbed({ title: "🎮 Game In Progress", color: BLACK, description: "A word game is already running in this server. Wait for it to finish." })],
    });
    return;
  }

  await initWordList();

  const gameState: ActiveGame = { players: [], currentRound: null };
  activeGameStates.set(guildId, gameState);

  try {
    await runGame(message, channel, guildId, gameState);
  } catch (err) {
    logger.error({ err }, "Word game crashed");
    await channel.send({ embeds: [makeEmbed({ title: "💥 Game Error", color: BLACK, description: "The game crashed unexpectedly." })] }).catch(() => {});
  } finally {
    activeGameStates.delete(guildId);
  }
}

// ── Game loop ─────────────────────────────────────────────────────────────────
async function runGame(
  message: Message,
  channel: TextChannel,
  guildId: string,
  gameState: ActiveGame
): Promise<void> {
  // Lobby phase
  const lobbyEmbed = new EmbedBuilder()
    .setTitle("🎮 Word Game — Lobby")
    .setColor(BLACK)
    .setDescription("React with ✅ to join!\nGame starts in **12 seconds**.")
    .setFooter({ text: "You need at least 1 player to start" })
    .setTimestamp();

  const lobbyMsg = await channel.send({ embeds: [lobbyEmbed] });
  await lobbyMsg.react("✅");

  await new Promise((res) => setTimeout(res, 12_000));

  const updatedMsg = await lobbyMsg.fetch();
  const reaction = updatedMsg.reactions.cache.get("✅");
  const reactedUsers = reaction
    ? [...(await reaction.users.fetch()).values()].filter((u) => !u.bot)
    : [];

  if (reactedUsers.length === 0) {
    await channel.send({ embeds: [makeEmbed({ title: "❌ Game Cancelled", color: BLACK, description: "Nobody joined. Lobby closed." })] });
    return;
  }

  const multiplayer = reactedUsers.length >= 2;
  const players: Player[] = reactedUsers.map((u) => ({ id: u.id, username: u.username, hearts: 3 }));
  gameState.players = players;

  const modeText = multiplayer
    ? `**${players.length} players** — Multiplayer 🏆`
    : "**Solo Mode** — No rewards";

  await channel.send({
    embeds: [makeEmbed({
      title: "🎮 Game Starting!",
      color: BLACK,
      description: `${modeText}\n\n${players.map((p) => `• <@${p.id}>`).join("\n")}\n\n**Rules:** Say a real English word containing ALL listed letters.\nWrong guesses are silently ignored — only valid words count.`,
    })],
  });

  let roundIdx = 0;

  while (players.length > (multiplayer ? 1 : 0)) {
    const player = players[roundIdx % players.length]!;
    const { letters, hintWord } = pickRoundChallenge();
    roundIdx++;

    // Store current round state for ?hint
    gameState.currentRound = { letters, hintWord, currentPlayerId: player.id };

    const roundEmbed = new EmbedBuilder()
      .setTitle(`🔤 Round ${roundIdx}`)
      .setColor(BLACK)
      .setDescription(
        `<@${player.id}> — your turn!\n\n` +
        `Say a **real English word** containing: **${letters.map((l) => `\`${l}\``).join(" + ")}**\n\n` +
        `${heartDisplay(player.hearts)}  ⏱️ 30 seconds`
      )
      .setFooter({ text: "Word must be a real English word containing ALL listed letters" });

    await channel.send({ embeds: [roundEmbed] });

    let answered = false;

    await new Promise<void>((resolve) => {
      const collector = channel.createMessageCollector({
        filter: (m) => m.author.id === player.id && !m.author.bot,
        time: 30_000,
      });

      collector.on("collect", async (m) => {
        const word = m.content.trim().split(/\s+/)[0] ?? "";
        if (!isValidAnswer(word, letters)) return; // not a real word — ignore silently
        answered = true;
        await m.reply("correct ✅");
        collector.stop("correct");
      });

      collector.on("end", () => resolve());
    });

    // Clear round state between rounds
    gameState.currentRound = null;

    if (!answered) {
      player.hearts--;
      if (player.hearts > 0) {
        await channel.send({
          embeds: [makeEmbed({
            title: "💔 Time's Up!",
            color: BLACK,
            description: `<@${player.id}> you have lost a heart — you have **${player.hearts}** heart(s) left\n${heartDisplay(player.hearts)}\n\n*(A valid word for that round was: \`${hintWord}\`)*`,
          })],
        });
      } else {
        await channel.send({
          embeds: [makeEmbed({
            title: "💀 Eliminated!",
            color: BLACK,
            description: `<@${player.id}> has run out of hearts and is out of the game!\n*(A valid word for that round was: \`${hintWord}\`)*`,
          })],
        });
        players.splice(players.indexOf(player), 1);
        if (roundIdx > 0) roundIdx = Math.max(0, roundIdx - 1);
        continue;
      }
    }

    await new Promise((res) => setTimeout(res, 1500));
  }

  // End game
  if (multiplayer && players.length === 1) {
    const winner = players[0]!;
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("🏆 Game Over — We Have a Winner!")
          .setColor(BLACK)
          .setDescription(`<@${winner.id}> wins the word game! 🎉\n**+500 XP** rewarded!`)
          .setTimestamp(),
      ],
    });
    await addXP(guildId, winner.id, 500, channel.client).catch(() => {});
  } else if (!multiplayer) {
    await channel.send({
      embeds: [makeEmbed({
        title: "🎮 Solo Game Over",
        color: BLACK,
        description: "Good run! Solo mode gives no rewards.\nChallenge others for XP 🏆",
      })],
    });
  } else {
    await channel.send({
      embeds: [makeEmbed({
        title: "💀 Everyone Lost!",
        color: BLACK,
        description: "All players ran out of hearts. No winner this time.",
      })],
    });
  }
}
