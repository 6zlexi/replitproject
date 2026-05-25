import { EmbedBuilder, type Message, type TextChannel } from "discord.js";
import { wipeBrain, addBlacklistPhrase, getMemorySize, getBrainStats, forceLearn, unlearnPhrase } from "./brain.js";
import { handleWarn, handleUnwarn, handleMute, handleUnmute, handleKick, handleBan, handleWarnHistory } from "./moderation.js";
import { handleLock1, handleLock2, handleUnlock, handlePurge, handleMoveMulti, handleDeleteEmojis } from "./channels.js";
import { handlePing, handleServerInfo, handleUserInfo, handleAvatar, handleCommandsList } from "./utility.js";
import { handleScript, handleStatus, handleAddScript, handleSetStatus } from "./scripts-registry.js";
import { handleWhitelistBot, handleUnwhitelistBot, handleWhitelistedBots } from "./antinuke.js";
import { handleExport, handleBackup, handleBackupBot } from "./export.js";
import { handleTicketPanel } from "./tickets.js";
import { handleSetMood, handleMoodCheck, handleRate } from "./mood.js";
import { handleIQ, handleShip, handleSimp } from "./fun.js";
import { handleBalance, handleDaily, handleWork, handleCrime, handleLeaderboard, handleStreak } from "./economy.js";
import { handleWordGame, handleHint, handleExtraHeart } from "./wordgame.js";
import { isAIEnabled, getAIDisabledReason, getProviderSummary, getKeyStatuses } from "./ai.js";
import { isBotOwner, canManageBrain, isMod, COLORS } from "./permissions.js";
import { makeEmbed, sendLog } from "./logging.js";
import { logger } from "./logger.js";

const PREFIX = "?";

// ── Per-user command cooldown (prevents rapid-fire command spam) ──────────────
const userCooldowns = new Map<string, number>();
const USER_COOLDOWN_MS = 3_000;

function isUserOnCooldown(userId: string): boolean {
  const last = userCooldowns.get(userId) ?? 0;
  return Date.now() - last < USER_COOLDOWN_MS;
}

function markUserUsedCommand(userId: string): void {
  userCooldowns.set(userId, Date.now());
  if (userCooldowns.size > 500) {
    const cutoff = Date.now() - USER_COOLDOWN_MS * 20;
    for (const [id, ts] of userCooldowns) {
      if (ts < cutoff) userCooldowns.delete(id);
    }
  }
}

// ── Log command usage to the #logs Discord channel (fire-and-forget) ──────────
function logCommandUse(message: Message, command: string): void {
  if (!message.guild) return;
  sendLog(message.guild, makeEmbed({
    title: "📝 Command Used",
    color: COLORS.mod,
    fields: [
      { name: "Command", value: `\`?${command}\``, inline: true },
      { name: "User",    value: `<@${message.author.id}>`, inline: true },
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
    ],
  })).catch(() => {});
}

const TIME_ESTIMATES: Record<string, string> = {
  ping: "< 1 second",
  serverinfo: "2–3 seconds",
  server: "2–3 seconds",
  userinfo: "2–3 seconds",
  user: "2–3 seconds",
  avatar: "1–2 seconds",
  av: "1–2 seconds",
  commands_list: "1 second",
  commands: "1 second",
  help: "1 second",
  history: "2–3 seconds",
  warn: "2–3 seconds",
  unwarn: "2–3 seconds",
  mute: "2–3 seconds",
  timeout: "2–3 seconds",
  unmute: "2–3 seconds",
  untimeout: "2–3 seconds",
  kick: "2–3 seconds",
  ban: "2–3 seconds",
  lock1: "2–3 seconds",
  lock2: "2–3 seconds",
  unlock: "2–3 seconds",
  purge: "3–8 seconds",
  clear: "3–8 seconds",
  movemulti: "3–5 seconds",
  move: "3–5 seconds",
  deleteemojis: "10–30 seconds (depends on emoji count)",
  script: "2 seconds",
  status: "2 seconds",
  addscript: "2–3 seconds",
  setstatus: "2–3 seconds",
  whitelistbot: "2 seconds",
  unwhitelistbot: "2 seconds",
  whitelistedbots: "2 seconds",
  brainstats: "2–3 seconds",
  wipebrain: "3–5 seconds",
  blacklistphrase: "2 seconds",
  memorysize: "2–3 seconds",
  learn: "1–2 seconds",
  unlearn: "1–2 seconds",
  export: "5–15 seconds (depends on data size)",
};

async function sendEstimate(message: Message, command: string): Promise<Message | null> {
  const estimate = TIME_ESTIMATES[command] ?? "a few seconds";
  try {
    return await (message.channel as TextChannel).send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.info)
          .setDescription(`⏱️ **\`?${command}\`** — Estimated time: **${estimate}**`),
      ],
    });
  } catch {
    return null;
  }
}

async function withEstimate(
  message: Message,
  command: string,
  fn: () => Promise<void>
): Promise<void> {
  const notice = await sendEstimate(message, command);
  try {
    await fn();
  } finally {
    setTimeout(() => notice?.delete().catch(() => {}), 3000);
  }
}

export async function handleCommand(message: Message): Promise<boolean> {
  const content = message.content.trim();
  if (!content.startsWith(PREFIX)) return false;

  const parts = content.slice(PREFIX.length).trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  if (!command) return false;
  if (!message.guild) return false;

  // Global permission gate — only staff roles can use any command
  if (!message.member || !isMod(message.member)) {
    await message.reply("you dont have permission");
    return true;
  }

  // Per-user cooldown — bot owner is exempt
  if (!isBotOwner(message.author.id) && isUserOnCooldown(message.author.id)) {
    return true; // silently ignore rapid-fire commands
  }
  markUserUsedCommand(message.author.id);

  // Log to #logs channel (non-blocking)
  logCommandUse(message, command);

  switch (command) {

    // ── AI Status ─────────────────────────────────────────
    case "aistatus":
      await handleAIStatus(message);
      return true;

    case "aikeys":
      await handleAIKeys(message);
      return true;

    // ── Utility ──────────────────────────────────────────
    case "ping":
      await withEstimate(message, command, () => handlePing(message));
      return true;

    case "serverinfo":
    case "server":
      await withEstimate(message, command, () => handleServerInfo(message));
      return true;

    case "userinfo":
    case "user":
      await withEstimate(message, command, () => handleUserInfo(message, args));
      return true;

    case "avatar":
    case "av":
      await withEstimate(message, command, () => handleAvatar(message, args));
      return true;

    case "commands_list":
    case "commands":
    case "help":
      await withEstimate(message, command, () => handleCommandsList(message));
      return true;

    case "history":
      await withEstimate(message, command, () => handleWarnHistory(message, args));
      return true;

    // ── Moderation ────────────────────────────────────────
    case "warn":
      await withEstimate(message, command, () => handleWarn(message, args));
      return true;

    case "unwarn":
      await withEstimate(message, command, () => handleUnwarn(message, args));
      return true;

    case "mute":
    case "timeout":
      await withEstimate(message, command, () => handleMute(message, args));
      return true;

    case "unmute":
    case "untimeout":
      await withEstimate(message, command, () => handleUnmute(message, args));
      return true;

    case "kick":
      await withEstimate(message, command, () => handleKick(message, args));
      return true;

    case "ban":
      await withEstimate(message, command, () => handleBan(message, args));
      return true;

    // ── Channel Management ────────────────────────────────
    case "lock1":
      await withEstimate(message, command, () => handleLock1(message));
      return true;

    case "lock2":
      await withEstimate(message, command, () => handleLock2(message));
      return true;

    case "unlock":
      await withEstimate(message, command, () => handleUnlock(message));
      return true;

    case "purge":
    case "clear":
      await withEstimate(message, command, () => handlePurge(message, args));
      return true;

    case "movemulti":
    case "move":
      await withEstimate(message, command, () => handleMoveMulti(message, args));
      return true;

    case "deleteemojis":
      await withEstimate(message, command, () => handleDeleteEmojis(message));
      return true;

    // ── Script Registry ───────────────────────────────────
    case "script":
      await withEstimate(message, command, () => handleScript(message, args));
      return true;

    case "status":
      await withEstimate(message, command, () => handleStatus(message, args));
      return true;

    case "addscript":
      await withEstimate(message, command, () => handleAddScript(message, args));
      return true;

    case "setstatus":
      await withEstimate(message, command, () => handleSetStatus(message, args));
      return true;

    // ── Anti-Nuke ─────────────────────────────────────────
    case "whitelistbot":
      await withEstimate(message, command, () => handleWhitelistBot(message, args));
      return true;

    case "unwhitelistbot":
      await withEstimate(message, command, () => handleUnwhitelistBot(message, args));
      return true;

    case "whitelistedbots":
      await withEstimate(message, command, () => handleWhitelistedBots(message));
      return true;

    // ── AI Brain ──────────────────────────────────────────
    case "brainstats":
      await withEstimate(message, command, () => handleBrainStats(message));
      return true;

    case "wipebrain":
      await withEstimate(message, command, () => handleWipeBrain(message));
      return true;

    case "blacklistphrase":
      await withEstimate(message, command, () => handleBlacklistPhrase(message, args));
      return true;

    case "memorysize":
      await withEstimate(message, command, () => handleMemorySize(message));
      return true;

    case "learn":
      await withEstimate(message, command, () => handleLearn(message, args));
      return true;

    case "unlearn":
      await withEstimate(message, command, () => handleUnlearn(message, args));
      return true;

    // ── Export / Backup ───────────────────────────────────
    case "export":
      await withEstimate(message, command, () => handleExport(message));
      return true;

    case "backup":
      await withEstimate(message, command, () => handleBackup(message));
      return true;

    case "backupbot":
      await withEstimate(message, command, () => handleBackupBot(message));
      return true;

    // ── Tickets ───────────────────────────────────────────
    case "ticket":
      await handleTicketPanel(message);
      return true;

    // ── Mood ──────────────────────────────────────────────
    case "botmood":
      await withEstimate(message, command, () => handleSetMood(message, args));
      return true;

    case "moodcheck":
      await handleMoodCheck(message);
      return true;

    case "rate":
      await withEstimate(message, command, () => handleRate(message, args));
      return true;

    // ── Fun ───────────────────────────────────────────────
    case "iq":
      await withEstimate(message, command, () => handleIQ(message, args));
      return true;

    case "ship":
      await withEstimate(message, command, () => handleShip(message, args));
      return true;

    case "simp":
      await withEstimate(message, command, () => handleSimp(message, args));
      return true;

    // ── Economy ───────────────────────────────────────────
    case "balance":
    case "bal":
      await withEstimate(message, command, () => handleBalance(message, args));
      return true;

    case "daily":
      await withEstimate(message, command, () => handleDaily(message));
      return true;

    case "work":
      await withEstimate(message, command, () => handleWork(message));
      return true;

    case "crime":
      await withEstimate(message, command, () => handleCrime(message));
      return true;

    case "leaderboard":
    case "lb":
      await withEstimate(message, command, () => handleLeaderboard(message));
      return true;

    case "streak":
      await withEstimate(message, command, () => handleStreak(message));
      return true;

    // ── Word Game ─────────────────────────────────────────
    case "wordgame":
    case "games":
      await handleWordGame(message);
      return true;

    case "hint":
      await handleHint(message);
      return true;

    case "extraheart":
      await handleExtraHeart(message, args);
      return true;

    default:
      return false;
  }
}

async function handleBrainStats(message: Message): Promise<void> {
  try {
    const guildId = message.guild!.id;
    const stats = await getBrainStats(guildId);
    await message.reply({
      embeds: [makeEmbed({
        title: "🧠 Brain Stats",
        color: COLORS.brain,
        fields: [
          { name: "📚 Messages Learned", value: stats.messages.toLocaleString(), inline: true },
          { name: "💬 Phrases Stored", value: stats.phrases.toLocaleString(), inline: true },
          { name: "🔎 Patterns Detected", value: stats.patterns.toLocaleString(), inline: true },
          { name: "🚫 Blacklisted", value: stats.blacklist.toLocaleString(), inline: true },
          { name: "👥 User Profiles", value: stats.userProfiles.toLocaleString(), inline: true },
          { name: "💾 Estimated Size", value: `~${stats.estimatedKB} KB`, inline: true },
        ],
      })],
    });
  } catch (err) {
    logger.error({ err }, "brainstats failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to fetch brain stats." })] });
  }
}

async function handleWipeBrain(message: Message): Promise<void> {
  if (!message.member || !canManageBrain(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only the server owner can wipe the brain." })] });
    return;
  }
  try {
    await wipeBrain(message.guild!.id);
    await message.reply({ embeds: [makeEmbed({ title: "🧠 Brain Wiped", color: COLORS.brain, description: "All learned memory has been cleared. Starting fresh." })] });
    logger.info({ guildId: message.guild!.id }, "Brain wiped");
  } catch (err) {
    logger.error({ err }, "wipebrain failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to wipe brain." })] });
  }
}

async function handleBlacklistPhrase(message: Message, args: string[]): Promise<void> {
  if (!message.member || !canManageBrain(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only the server owner can blacklist phrases." })] });
    return;
  }
  const phrase = args.join(" ").trim();
  if (!phrase || phrase.length < 2 || phrase.length > 100) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?blacklistphrase <phrase>` (2–100 characters)" })] });
    return;
  }
  try {
    await addBlacklistPhrase(message.guild!.id, phrase, message.author.id);
    await message.reply({ embeds: [makeEmbed({ title: "🚫 Phrase Blacklisted", color: COLORS.brain, description: `**${phrase}** will no longer be learned.` })] });
  } catch (err) {
    logger.error({ err }, "blacklistphrase failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to blacklist phrase." })] });
  }
}

async function handleUnlearn(message: Message, args: string[]): Promise<void> {
  if (!message.member || !canManageBrain(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only the server owner can use `?unlearn`." })] });
    return;
  }

  const phrase = args.join(" ").trim().toLowerCase();
  if (!phrase || phrase.length < 2) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?unlearn <phrase>` — remove a specific phrase from the brain." })] });
    return;
  }

  try {
    const result = await unlearnPhrase(message.guild!.id, phrase);
    const total = result.phrasesRemoved + result.messagesRemoved;

    if (total === 0) {
      await message.reply({
        embeds: [makeEmbed({
          title: "🔍 Not Found",
          color: COLORS.info,
          description: `**"${phrase}"** wasn't found in the brain. It may have already been removed or was never learned as an exact phrase.`,
        })],
      });
    } else {
      await message.reply({
        embeds: [makeEmbed({
          title: "🗑️ Unlearned",
          color: COLORS.brain,
          description: `Removed **"${phrase}"** from the brain.`,
          fields: [
            { name: "Phrases Removed", value: String(result.phrasesRemoved), inline: true },
            { name: "Messages Removed", value: String(result.messagesRemoved), inline: true },
          ],
        })],
      });
    }
    logger.info({ guildId: message.guild!.id, phrase, ...result }, "Unlearn applied");
  } catch (err) {
    logger.error({ err }, "unlearn command failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to unlearn that phrase. Try again." })] });
  }
}

async function handleLearn(message: Message, args: string[]): Promise<void> {
  if (!message.member || !canManageBrain(message.member)) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only the server owner can use `?learn`." })] });
    return;
  }

  const text = args.join(" ").trim();
  if (!text || text.length < 2) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Usage", color: COLORS.error, description: "`?learn <anything>` — teach the bot a phrase, slang, sentence, or style." })] });
    return;
  }
  if (text.length > 500) {
    await message.reply({ embeds: [makeEmbed({ title: "❌ Too Long", color: COLORS.error, description: "Keep it under 500 characters per `?learn` call." })] });
    return;
  }

  try {
    await forceLearn(message.guild!.id, message.channelId, message.author.id, text);
    await message.reply({
      embeds: [makeEmbed({
        title: "🧠 Learned",
        color: COLORS.brain,
        description: `Got it. I'll incorporate **"${text.slice(0, 100)}${text.length > 100 ? "…" : ""}"** into how I talk.`,
      })],
    });
    logger.info({ guildId: message.guild!.id, text }, "Force-learn applied");
  } catch (err) {
    logger.error({ err }, "learn command failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to save that. Try again." })] });
  }
}

async function handleMemorySize(message: Message): Promise<void> {
  try {
    const size = await getMemorySize(message.guild!.id);
    await message.reply({
      embeds: [makeEmbed({
        title: "💾 Memory Usage",
        color: COLORS.brain,
        fields: [
          { name: "Estimated Size", value: `~${size.estimatedKB} KB`, inline: true },
          { name: "Messages", value: `${size.messages.toLocaleString()} / 5,000`, inline: true },
          { name: "Phrases", value: `${size.phrases.toLocaleString()} / 2,000`, inline: true },
          { name: "Patterns", value: `${size.patterns.toLocaleString()} / 1,000`, inline: true },
          { name: "Blacklist", value: String(size.blacklist), inline: true },
          { name: "User Profiles", value: String(size.userProfiles), inline: true },
        ],
      })],
    });
  } catch (err) {
    logger.error({ err }, "memorysize failed");
    await message.reply({ embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Failed to check memory size." })] });
  }
}

async function handleAIStatus(message: Message): Promise<void> {
  const working = isAIEnabled();
  const providerSummary = getProviderSummary();

  // Count active providers for the channel embed subtitle
  const activeCount = providerSummary.split("\n").filter((l) => l.startsWith("✅")).length;
  const totalCount = providerSummary.split("\n").length;

  // ── Channel reply: working / not working + provider count only ──
  await message.reply({
    embeds: [
      makeEmbed({
        title: working ? "✅ AI is working" : "❌ AI is not working",
        color: working ? COLORS.success : COLORS.error,
        description: working
          ? `${activeCount}/${totalCount} provider${totalCount !== 1 ? "s" : ""} active. The bot owner has the full breakdown.`
          : "All AI providers are currently unavailable. The bot owner has been notified.",
      }),
    ],
  });

  // ── DM owner: always send full per-provider breakdown ──
  const ownerId = process.env.OWNER_ID;
  if (!ownerId) return;

  try {
    const owner = await message.client.users.fetch(ownerId);
    const triggeredBy = isBotOwner(message.author.id)
      ? "you (owner)"
      : `${message.author.username} in #${(message.channel as import("discord.js").TextChannel).name ?? "unknown"}`;

    const statusIcon = working ? "✅" : "🚨";
    const statusLabel = working ? "AI Status Check" : "AI Status Check — All Providers Down";

    const disabledReason = !working ? `\n**Why all providers failed:**\n\`\`\`\n${getAIDisabledReason()}\n\`\`\`\n` : "";

    await owner.send(
      `${statusIcon} **${statusLabel}**\n` +
      `Triggered by: **${triggeredBy}**\n\n` +
      `**Provider breakdown:**\n\`\`\`\n${providerSummary}\n\`\`\`` +
      disabledReason
    );
  } catch (err) {
    logger.warn({ err }, "Could not DM owner from ?aistatus");
  }
}

async function handleAIKeys(message: Message): Promise<void> {
  // Owner-only — never expose key details to others
  if (!isBotOwner(message.author.id)) {
    await message.reply({
      embeds: [makeEmbed({
        title: "❌ No Permission",
        color: COLORS.error,
        description: "Only the **bot owner** can view AI key statuses.",
      })],
    });
    return;
  }

  const statuses = getKeyStatuses();

  if (statuses.length === 0) {
    await message.reply({
      embeds: [makeEmbed({
        title: "⚠️ No Groq Keys Configured",
        color: COLORS.warning,
        description: "No Groq keys are loaded. Set `GROQ_API_KEY_1` … `GROQ_API_KEY_11` in Replit Secrets.",
      })],
    });
    return;
  }

  // Channel: just confirm the DM was sent
  await message.reply({
    embeds: [makeEmbed({
      title: "🔑 AI Key Status",
      color: COLORS.info,
      description: "Full key breakdown sent to your DMs.",
    })],
  });

  // DM owner: full per-key status table
  const STATUS_ICON: Record<string, string> = {
    ok:           "✅",
    rate_limited: "⏳",
    failed:       "❌",
  };
  const STATUS_LABEL: Record<string, string> = {
    ok:           "active",
    rate_limited: "rate-limited (auto-retry in <60s)",
    failed:       "permanently failed (bad key / billing)",
  };

  // Group by provider
  const byProvider = new Map<string, typeof statuses>();
  for (const s of statuses) {
    if (!byProvider.has(s.provider)) byProvider.set(s.provider, []);
    byProvider.get(s.provider)!.push(s);
  }

  const lines: string[] = [];
  for (const [provider, keys] of byProvider) {
    const activeCount = keys.filter((k) => k.status === "ok").length;
    lines.push(`── ${provider} (${activeCount}/${keys.length} active) ──`);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      lines.push(`  Key ${i + 1}  ${k.hint}  ${STATUS_ICON[k.status]} ${STATUS_LABEL[k.status]}`);
    }
  }

  const totalOk = statuses.filter((s) => s.status === "ok").length;
  lines.push("");
  lines.push(`Total: ${totalOk}/${statuses.length} key(s) active`);

  try {
    const owner = await message.client.users.fetch(process.env.OWNER_ID!);
    await owner.send(
      `🔑 **AI Key Status — Live Snapshot**\n\`\`\`\n${lines.join("\n")}\n\`\`\``
    );
  } catch (err) {
    logger.warn({ err }, "Could not DM owner from ?aikeys");
  }
}
