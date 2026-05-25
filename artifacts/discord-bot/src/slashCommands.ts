/**
 * slashCommands.ts — Slash command definitions, registration, and dispatch.
 *
 * Architecture:
 *   - SLASH_COMMANDS defines all slash commands with their options.
 *   - createMessageProxy() adapts a ChatInputCommandInteraction into the
 *     Message-like shape that existing handlers already accept — no handler
 *     files need to change.
 *   - routeSlashCommand() maps each slash command name to its handler,
 *     extracting typed options and converting them to the string[] args format
 *     the handlers already understand.
 *   - registerSlashCommands() registers all commands as guild commands
 *     (instant propagation) via the Discord REST API.
 *
 * HOW TO ADD A NEW SLASH COMMAND:
 *   1. Add its SlashCommandBuilder entry to SLASH_COMMANDS below.
 *   2. Add a case in routeSlashCommand() calling the same handler as the
 *      prefix version in commands.ts.
 *   3. That's it — no other file needs to change.
 */

import {
  SlashCommandBuilder,
  REST,
  Routes,
  ChatInputCommandInteraction,
  type Message,
  type Guild,
  type GuildMember,
  type TextChannel,
  type Client,
  EmbedBuilder,
} from "discord.js";

import { handleWarn, handleUnwarn, handleMute, handleUnmute, handleKick, handleBan, handleWarnHistory } from "./moderation.js";
import { handleLock1, handleLock2, handleUnlock, handlePurge } from "./channels.js";
import { handlePing, handleServerInfo, handleUserInfo, handleAvatar, handleCommandsList } from "./utility.js";
import { handleScript, handleStatus, handleAddScript, handleSetStatus } from "./scripts-registry.js";
import { handleWhitelistBot, handleUnwhitelistBot, handleWhitelistedBots } from "./antinuke.js";
import { handleExport, handleBackupBot } from "./export.js";
import { handleTicketPanel } from "./tickets.js";
import { handleSetMood, handleMoodCheck, handleRate } from "./mood.js";
import { handleIQ, handleShip, handleSimp } from "./fun.js";
import { handleBalance, handleDaily, handleWork, handleCrime, handleLeaderboard, handleStreak } from "./economy.js";
import { handleWordGame, handleHint, handleExtraHeart } from "./wordgame.js";
import { isAIEnabled, getAIDisabledReason, getProviderSummary } from "./ai.js";
import { isBotOwner, canManageBrain, COLORS } from "./permissions.js";
import { makeEmbed, sendLog } from "./logging.js";
import { logger } from "./logger.js";
import {
  getBrainStats, getMemorySize, wipeBrain,
  addBlacklistPhrase, forceLearn, unlearnPhrase,
} from "./brain.js";

// ── Message proxy ─────────────────────────────────────────────────────────────
/**
 * Wraps a deferred ChatInputCommandInteraction so it looks like a Message.
 * Handlers call message.reply() — the proxy routes that to editReply() /
 * followUp() transparently. The real channel/guild/member objects are passed
 * through unchanged so all guild logic still works.
 */
function createMessageProxy(interaction: ChatInputCommandInteraction): Message {
  let firstReply = true;

  const fakeReply = async (options: unknown): Promise<{
    edit(opts: unknown): Promise<void>;
    delete(): Promise<void>;
  }> => {
    try {
      if (firstReply) {
        firstReply = false;
        await interaction.editReply(options as Parameters<typeof interaction.editReply>[0]);
      } else {
        await interaction.followUp(options as Parameters<typeof interaction.followUp>[0]);
      }
    } catch { /* swallow — handler already sent a reply */ }
    return {
      edit:   async (opts: unknown) => { try { await interaction.editReply(opts as Parameters<typeof interaction.editReply>[0]); } catch {} },
      delete: async () =>              { try { await interaction.deleteReply(); } catch {} },
    };
  };

  return {
    guild:     interaction.guild as Guild,
    member:    interaction.member as GuildMember,
    author:    interaction.user,
    channelId: interaction.channelId,
    channel:   interaction.channel as TextChannel,
    client:    interaction.client,
    content:   "",
    id:        interaction.id,
    partial:   false,
    reference: null,
    reply:     fakeReply,
    delete:    async () => {},
    mentions:  {
      users:              new Map(),
      roles:              new Map(),
      members:            new Map(),
      channels:           new Map(),
      crosspostedChannels:new Map(),
      everyone:           false,
      has:                () => false,
      toJSON:             () => ({}),
      _parsedUsers:       null,
    },
  } as unknown as Message;
}

// ── Slash command definitions ─────────────────────────────────────────────────
export const SLASH_COMMANDS = [

  // ── Utility ──────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check bot latency"),
  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Server information"),
  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("User information")
    .addUserOption((o) => o.setName("user").setDescription("User to look up")),
  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Show a user's avatar")
    .addUserOption((o) => o.setName("user").setDescription("User whose avatar to show")),
  new SlashCommandBuilder()
    .setName("commands")
    .setDescription("Show all bot commands"),
  new SlashCommandBuilder()
    .setName("aistatus")
    .setDescription("Check AI system status"),

  // ── Moderation ────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member")
    .addUserOption((o) => o.setName("user").setDescription("Member to warn").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason for the warn")),
  new SlashCommandBuilder()
    .setName("unwarn")
    .setDescription("Remove the latest warn from a member")
    .addUserOption((o) => o.setName("user").setDescription("Member to unwarn").setRequired(true)),
  new SlashCommandBuilder()
    .setName("history")
    .setDescription("View warn history for a member")
    .addUserOption((o) => o.setName("user").setDescription("Member to check").setRequired(true)),
  new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Mute/timeout a member")
    .addUserOption((o) => o.setName("user").setDescription("Member to mute").setRequired(true))
    .addIntegerOption((o) => o.setName("duration").setDescription("Duration in minutes (default: 10)").setMinValue(1).setMaxValue(10080))
    .addStringOption((o) => o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Remove timeout from a member")
    .addUserOption((o) => o.setName("user").setDescription("Member to unmute").setRequired(true)),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .addUserOption((o) => o.setName("user").setDescription("Member to kick").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason")),
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .addUserOption((o) => o.setName("user").setDescription("Member to ban").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason")),

  // ── Channel Management ────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("lock1")
    .setDescription("Lock channel — co-owner + admin only"),
  new SlashCommandBuilder()
    .setName("lock2")
    .setDescription("Lock channel — co-owner + admin + mod only"),
  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock channel"),
  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete 1–100 messages in this channel")
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Number of messages to delete").setRequired(true).setMinValue(1).setMaxValue(100)
    ),

  // ── Script Registry ───────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("script")
    .setDescription("Show info for a script")
    .addStringOption((o) => o.setName("name").setDescription("Script name").setRequired(true)),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show status of a script")
    .addStringOption((o) => o.setName("name").setDescription("Script name").setRequired(true)),
  new SlashCommandBuilder()
    .setName("addscript")
    .setDescription("Add or update a script entry")
    .addStringOption((o) => o.setName("name").setDescription("Script name").setRequired(true))
    .addStringOption((o) => o.setName("description").setDescription("Short description").setRequired(true))
    .addStringOption((o) => o.setName("author").setDescription("Author (defaults to your username)")),
  new SlashCommandBuilder()
    .setName("setstatus")
    .setDescription("Set a script's status")
    .addStringOption((o) => o.setName("name").setDescription("Script name").setRequired(true))
    .addStringOption((o) =>
      o.setName("status").setDescription("New status").setRequired(true)
        .addChoices(
          { name: "online",       value: "online"       },
          { name: "offline",      value: "offline"      },
          { name: "maintenance",  value: "maintenance"  }
        )
    ),

  // ── Anti-Nuke ─────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("whitelistbot")
    .setDescription("Whitelist a bot from anti-nuke")
    .addUserOption((o) => o.setName("bot").setDescription("Bot user to whitelist").setRequired(true)),
  new SlashCommandBuilder()
    .setName("unwhitelistbot")
    .setDescription("Remove a bot from the anti-nuke whitelist")
    .addUserOption((o) => o.setName("bot").setDescription("Bot user to remove").setRequired(true)),
  new SlashCommandBuilder()
    .setName("whitelistedbots")
    .setDescription("Show all whitelisted bots"),

  // ── AI Brain ──────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("brainstats")
    .setDescription("AI brain learning statistics"),
  new SlashCommandBuilder()
    .setName("memorysize")
    .setDescription("Memory breakdown by category"),
  new SlashCommandBuilder()
    .setName("learn")
    .setDescription("Force-teach the bot a phrase or style (owner only)")
    .addStringOption((o) => o.setName("text").setDescription("Text to teach").setRequired(true)),
  new SlashCommandBuilder()
    .setName("unlearn")
    .setDescription("Remove a phrase from the bot's memory (owner only)")
    .addStringOption((o) => o.setName("phrase").setDescription("Phrase to remove").setRequired(true)),
  new SlashCommandBuilder()
    .setName("wipebrain")
    .setDescription("Wipe all learned memory (owner only)"),
  new SlashCommandBuilder()
    .setName("blacklistphrase")
    .setDescription("Blacklist a phrase from being learned (owner only)")
    .addStringOption((o) => o.setName("phrase").setDescription("Phrase to blacklist").setRequired(true)),

  // ── Tickets ───────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Post the ticket panel (staff only)"),

  // ── Mood ──────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("botmood")
    .setDescription("Set the bot's current mood (admin+)")
    .addStringOption((o) =>
      o.setName("mood").setDescription("Mood to set").setRequired(true)
        .addChoices(
          { name: "happy",   value: "happy"   },
          { name: "sad",     value: "sad"     },
          { name: "angry",   value: "angry"   },
          { name: "tired",   value: "tired"   },
          { name: "chaotic", value: "chaotic" },
          { name: "neutral", value: "neutral" }
        )
    ),
  new SlashCommandBuilder()
    .setName("moodcheck")
    .setDescription("Show the bot's current mood"),
  new SlashCommandBuilder()
    .setName("rate")
    .setDescription("Rate a user 1–10 (mood-influenced)")
    .addUserOption((o) => o.setName("user").setDescription("User to rate").setRequired(true)),

  // ── Fun ───────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("iq")
    .setDescription("Get IQ score for a user (consistent per day)")
    .addUserOption((o) => o.setName("user").setDescription("User to check")),
  new SlashCommandBuilder()
    .setName("ship")
    .setDescription("Compatibility % between two users")
    .addUserOption((o) => o.setName("user1").setDescription("First user").setRequired(true))
    .addUserOption((o) => o.setName("user2").setDescription("Second user").setRequired(true)),
  new SlashCommandBuilder()
    .setName("simp")
    .setDescription("Simp meter % for a user")
    .addUserOption((o) => o.setName("user").setDescription("User to check").setRequired(true)),

  // ── Economy ───────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("View coin balance, level, and XP")
    .addUserOption((o) => o.setName("user").setDescription("User to check")),
  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Claim your daily coins (24h cooldown, streak bonus)"),
  new SlashCommandBuilder()
    .setName("work")
    .setDescription("Work for coins (4h cooldown)"),
  new SlashCommandBuilder()
    .setName("crime")
    .setDescription("Risk coins for a bigger reward (8h cooldown, 40% success)"),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Top 10 coin holders"),
  new SlashCommandBuilder()
    .setName("streak")
    .setDescription("Check your daily streak status"),

  // ── Games ─────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("wordgame")
    .setDescription("Start a word game lobby (react ✅ to join)"),
  new SlashCommandBuilder()
    .setName("hint")
    .setDescription("Show a hint for the current word game round (owner/co-owner only)"),
  new SlashCommandBuilder()
    .setName("extraheart")
    .setDescription("Give a player +1 heart during a word game (owner/co-owner only)")
    .addUserOption((o) => o.setName("user").setDescription("Player to give heart to").setRequired(true)),

  // ── Owner / Backup ────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("export")
    .setDescription("Export guild data as a zip (server owner only)"),
  new SlashCommandBuilder()
    .setName("backupbot")
    .setDescription("Full bot backup sent to your DMs (owner/co-owner only)"),
];

// ── Registration ──────────────────────────────────────────────────────────────

/** Registers all slash commands in a single guild via REST (instant propagation). */
async function registerForGuild(rest: REST, clientId: string, guildId: string, commands: ReturnType<typeof SLASH_COMMANDS[number]["toJSON"]>[]): Promise<void> {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
}

/**
 * Registers all slash commands in every guild the bot is currently in.
 * Called from ClientReady. Also logs success to each guild's #logs channel.
 */
export async function registerSlashCommands(client: Client): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logger.warn("DISCORD_TOKEN not set — cannot register slash commands");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const commandData = SLASH_COMMANDS.map((c) => c.toJSON());
  const clientId = client.user!.id;

  let successCount = 0;
  const failedGuildIds: string[] = [];

  for (const guild of client.guilds.cache.values()) {
    try {
      await registerForGuild(rest, clientId, guild.id, commandData);
      successCount++;
    } catch (err) {
      logger.error({ err, guildId: guild.id }, "Failed to register slash commands for guild");
      failedGuildIds.push(guild.id);
    }
  }

  logger.info(
    { success: successCount, failed: failedGuildIds.length, commands: commandData.length },
    `✅ Slash commands registered (${commandData.length} commands, ${successCount}/${successCount + failedGuildIds.length} guilds)`
  );

  // Log success to each guild's #logs channel
  for (const guild of client.guilds.cache.values()) {
    if (failedGuildIds.includes(guild.id)) continue;
    sendLog(guild, makeEmbed({
      title: "✅ Slash Commands Registered",
      color: COLORS.success,
      description: `**${commandData.length}** slash commands are now active. Use \`/command\` or \`?command\` — both work.`,
    })).catch(() => {});
  }
}

/**
 * Registers slash commands in a single guild — called when the bot joins a new server.
 */
export async function registerSlashCommandsForGuild(client: Client, guild: Guild): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return;

  try {
    const rest = new REST({ version: "10" }).setToken(token);
    await registerForGuild(rest, client.user!.id, guild.id, SLASH_COMMANDS.map((c) => c.toJSON()));
    logger.info({ guildId: guild.id }, "Slash commands registered for new guild");
    sendLog(guild, makeEmbed({
      title: "✅ Slash Commands Ready",
      color: COLORS.success,
      description: `**${SLASH_COMMANDS.length}** slash commands registered. Use \`/command\` or \`?command\`.`,
    })).catch(() => {});
  } catch (err) {
    logger.error({ err, guildId: guild.id }, "Failed to register slash commands for new guild");
  }
}

// ── Main slash interaction handler ────────────────────────────────────────────

/** Entry point called from the InteractionCreate event in index.ts. */
export async function handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "This bot only works in servers.", ephemeral: true });
    return;
  }

  // Defer immediately — gives handlers time to respond
  await interaction.deferReply();

  const name = interaction.commandName;
  const msg  = createMessageProxy(interaction);

  try {
    await routeSlashCommand(interaction, msg, name);
  } catch (err) {
    logger.error({ err, command: name }, "Slash command handler threw");

    try {
      await interaction.editReply({
        embeds: [makeEmbed({ title: "❌ Error", color: COLORS.error, description: "Something went wrong. Try the `?` prefix version if this keeps happening." })],
      });
    } catch { /* already replied */ }

    sendLog(interaction.guild, makeEmbed({
      title:  "❌ Slash Command Error",
      color:  COLORS.error,
      fields: [
        { name: "Command", value: `\`/${name}\``,                             inline: true  },
        { name: "User",    value: `<@${interaction.user.id}>`,                inline: true  },
        { name: "Error",   value: `\`\`\`${String(err).slice(0, 200)}\`\`\`` },
      ],
    })).catch(() => {});
  }
}

// ── Command router ────────────────────────────────────────────────────────────

async function routeSlashCommand(
  interaction: ChatInputCommandInteraction,
  msg: Message,
  name: string
): Promise<void> {
  const opts    = interaction.options;
  const guildId = interaction.guild!.id;

  /** Raw user ID from a user option. */
  const uid = (key: string, required?: true): string =>
    (required ? opts.getUser(key, true) : opts.getUser(key))!.id;

  /** "<@id>" format — for handlers that only accept mention patterns. */
  const mention = (key: string, required?: true) => `<@${uid(key, required)}>`;

  /** String option value. */
  const str = (key: string, required?: true): string =>
    required ? opts.getString(key, true) : (opts.getString(key) ?? "");

  /** Integer option value. */
  const num = (key: string): number => opts.getInteger(key) ?? 0;

  switch (name) {

    // ── Utility ────────────────────────────────────────────────────────────
    case "ping":       await handlePing(msg); break;
    case "serverinfo": await handleServerInfo(msg); break;
    case "userinfo":   await handleUserInfo(msg, opts.getUser("user") ? [uid("user")] : []); break;
    case "avatar":     await handleAvatar(msg,    opts.getUser("user") ? [uid("user")] : []); break;
    case "commands":   await handleCommandsList(msg); break;
    case "aistatus":   await handleAIStatusSlash(interaction); break;

    // ── Moderation ─────────────────────────────────────────────────────────
    case "warn": {
      const args = [uid("user", true)];
      const reason = str("reason");
      if (reason) args.push(reason);
      await handleWarn(msg, args);
      break;
    }
    case "unwarn":  await handleUnwarn(msg,       [uid("user", true)]); break;
    case "history": await handleWarnHistory(msg,  [uid("user", true)]); break;
    case "mute": {
      const args = [uid("user", true), String(num("duration") || 10)];
      const reason = str("reason");
      if (reason) args.push(reason);
      await handleMute(msg, args);
      break;
    }
    case "unmute": await handleUnmute(msg, [uid("user", true)]); break;
    case "kick": {
      const args = [uid("user", true)];
      const reason = str("reason");
      if (reason) args.push(reason);
      await handleKick(msg, args);
      break;
    }
    case "ban": {
      const args = [uid("user", true)];
      const reason = str("reason");
      if (reason) args.push(reason);
      await handleBan(msg, args);
      break;
    }

    // ── Channel Management ─────────────────────────────────────────────────
    case "lock1":  await handleLock1(msg); break;
    case "lock2":  await handleLock2(msg); break;
    case "unlock": await handleUnlock(msg); break;
    case "purge":  await handlePurge(msg, [String(num("amount"))]); break;

    // ── Script Registry ────────────────────────────────────────────────────
    case "script": await handleScript(msg, [str("name", true)]); break;
    case "status": await handleStatus(msg, [str("name", true)]); break;
    case "addscript": {
      // Handler joins args then splits by "|" — pass as single pipe-joined string
      const name   = str("name", true);
      const desc   = str("description", true);
      const author = str("author") || interaction.user.username;
      await handleAddScript(msg, [`${name} | ${desc} | ${author}`]);
      break;
    }
    case "setstatus": {
      await handleSetStatus(msg, [`${str("name", true)} | ${str("status", true)}`]);
      break;
    }

    // ── Anti-Nuke ──────────────────────────────────────────────────────────
    case "whitelistbot":   await handleWhitelistBot(msg,   [uid("bot", true)]); break;
    case "unwhitelistbot": await handleUnwhitelistBot(msg, [uid("bot", true)]); break;
    case "whitelistedbots": await handleWhitelistedBots(msg); break;

    // ── AI Brain ───────────────────────────────────────────────────────────
    // These handlers are private to commands.ts, so we call the underlying
    // brain.ts functions directly with the same permission checks.
    case "brainstats":      await brainStatsSlash(interaction, guildId); break;
    case "memorysize":      await memorySizeSlash(interaction, guildId); break;
    case "learn":           await learnSlash(interaction, msg, guildId, str("text", true)); break;
    case "unlearn":         await unlearnSlash(interaction, msg, guildId, str("phrase", true)); break;
    case "wipebrain":       await wipeBrainSlash(interaction, msg, guildId); break;
    case "blacklistphrase": await blacklistSlash(interaction, msg, guildId, str("phrase", true)); break;

    // ── Tickets ────────────────────────────────────────────────────────────
    case "ticket": await handleTicketPanel(msg); break;

    // ── Mood ───────────────────────────────────────────────────────────────
    case "botmood":   await handleSetMood(msg, [str("mood", true)]); break;
    case "moodcheck": await handleMoodCheck(msg); break;
    case "rate":      await handleRate(msg, [mention("user", true)]); break;

    // ── Fun ────────────────────────────────────────────────────────────────
    case "iq":   await handleIQ(msg,   opts.getUser("user") ? [uid("user")] : []); break;
    case "ship": await handleShip(msg, [mention("user1", true), mention("user2", true)]); break;
    case "simp": await handleSimp(msg, [mention("user", true)]); break;

    // ── Economy ────────────────────────────────────────────────────────────
    case "balance":     await handleBalance(msg, opts.getUser("user") ? [uid("user")] : []); break;
    case "daily":       await handleDaily(msg); break;
    case "work":        await handleWork(msg); break;
    case "crime":       await handleCrime(msg); break;
    case "leaderboard": await handleLeaderboard(msg); break;
    case "streak":      await handleStreak(msg); break;

    // ── Games ──────────────────────────────────────────────────────────────
    case "wordgame":   await handleWordGame(msg); break;
    case "hint":       await handleHint(msg); break;
    case "extraheart": await handleExtraHeart(msg, [mention("user", true)]); break;

    // ── Owner ──────────────────────────────────────────────────────────────
    case "export":    await handleExport(msg); break;
    case "backupbot": await handleBackupBot(msg); break;

    default:
      await interaction.editReply({ content: "Unknown slash command." });
  }
}

// ── Inline handlers for commands whose logic lives in commands.ts ─────────────
// (brain handlers are private there — we call brain.ts directly with the same logic)

async function handleAIStatusSlash(interaction: ChatInputCommandInteraction): Promise<void> {
  const working       = isAIEnabled();
  const summary       = getProviderSummary();
  const activeCount   = summary.split("\n").filter((l) => l.startsWith("✅")).length;
  const totalCount    = summary.split("\n").length;

  await interaction.editReply({
    embeds: [makeEmbed({
      title: working ? "✅ AI is working" : "❌ AI is not working",
      color: working ? COLORS.success : COLORS.error,
      description: working
        ? `${activeCount}/${totalCount} provider${totalCount !== 1 ? "s" : ""} active.`
        : "All AI providers are currently unavailable.",
    })],
  });

  const ownerId = process.env.OWNER_ID;
  if (!ownerId) return;
  try {
    const owner = await interaction.client.users.fetch(ownerId);
    const disabled = !working ? `\n**Why:**\n\`\`\`\n${getAIDisabledReason()}\n\`\`\`` : "";
    await owner.send(
      `${working ? "✅" : "🚨"} **AI Status Check** — triggered by ${interaction.user.username} via slash\n\n` +
      `**Breakdown:**\n\`\`\`\n${summary}\n\`\`\`` + disabled
    );
  } catch { /* DM failed — owner has DMs closed */ }
}

async function brainStatsSlash(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const stats = await getBrainStats(guildId);
  await interaction.editReply({
    embeds: [makeEmbed({
      title: "🧠 Brain Stats",
      color: COLORS.brain,
      fields: [
        { name: "📚 Messages Learned", value: stats.messages.toLocaleString(),    inline: true },
        { name: "💬 Phrases Stored",   value: stats.phrases.toLocaleString(),     inline: true },
        { name: "🔎 Patterns",         value: stats.patterns.toLocaleString(),    inline: true },
        { name: "🚫 Blacklisted",      value: stats.blacklist.toLocaleString(),   inline: true },
        { name: "👥 User Profiles",    value: stats.userProfiles.toLocaleString(),inline: true },
        { name: "💾 Estimated Size",   value: `~${stats.estimatedKB} KB`,         inline: true },
      ],
    })],
  });
}

async function memorySizeSlash(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const size = await getMemorySize(guildId);
  await interaction.editReply({
    embeds: [makeEmbed({
      title: "💾 Memory Usage",
      color: COLORS.brain,
      fields: [
        { name: "Estimated Size", value: `~${size.estimatedKB} KB`,                  inline: true },
        { name: "Messages",       value: `${size.messages.toLocaleString()} / 5,000`, inline: true },
        { name: "Phrases",        value: `${size.phrases.toLocaleString()} / 2,000`,  inline: true },
        { name: "Patterns",       value: `${size.patterns.toLocaleString()} / 1,000`, inline: true },
        { name: "Blacklist",      value: String(size.blacklist),                       inline: true },
        { name: "User Profiles",  value: String(size.userProfiles),                   inline: true },
      ],
    })],
  });
}

async function learnSlash(interaction: ChatInputCommandInteraction, msg: Message, guildId: string, text: string): Promise<void> {
  if (!canManageBrain(msg.member!)) {
    await interaction.editReply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only the server owner can use `/learn`." })] });
    return;
  }
  if (text.length > 500) {
    await interaction.editReply({ embeds: [makeEmbed({ title: "❌ Too Long", color: COLORS.error, description: "Keep it under 500 characters." })] });
    return;
  }
  await forceLearn(guildId, interaction.channelId, interaction.user.id, text);
  await interaction.editReply({
    embeds: [makeEmbed({
      title: "🧠 Learned",
      color: COLORS.brain,
      description: `Got it. Incorporated **"${text.slice(0, 100)}${text.length > 100 ? "…" : ""}"** into how I talk.`,
    })],
  });
}

async function unlearnSlash(interaction: ChatInputCommandInteraction, msg: Message, guildId: string, phrase: string): Promise<void> {
  if (!canManageBrain(msg.member!)) {
    await interaction.editReply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only the server owner can use `/unlearn`." })] });
    return;
  }
  const result = await unlearnPhrase(guildId, phrase.toLowerCase());
  const total  = result.phrasesRemoved + result.messagesRemoved;
  if (total === 0) {
    await interaction.editReply({ embeds: [makeEmbed({ title: "🔍 Not Found", color: COLORS.info, description: `**"${phrase}"** wasn't found in the brain.` })] });
  } else {
    await interaction.editReply({ embeds: [makeEmbed({ title: "🗑️ Unlearned", color: COLORS.brain, description: `Removed **"${phrase}"** from the brain.`, fields: [{ name: "Phrases Removed", value: String(result.phrasesRemoved), inline: true }, { name: "Messages Removed", value: String(result.messagesRemoved), inline: true }] })] });
  }
}

async function wipeBrainSlash(interaction: ChatInputCommandInteraction, msg: Message, guildId: string): Promise<void> {
  if (!canManageBrain(msg.member!)) {
    await interaction.editReply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only the server owner can wipe the brain." })] });
    return;
  }
  await wipeBrain(guildId);
  await interaction.editReply({ embeds: [makeEmbed({ title: "🧠 Brain Wiped", color: COLORS.brain, description: "All learned memory cleared. Starting fresh." })] });
}

async function blacklistSlash(interaction: ChatInputCommandInteraction, msg: Message, guildId: string, phrase: string): Promise<void> {
  if (!canManageBrain(msg.member!)) {
    await interaction.editReply({ embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only the server owner can blacklist phrases." })] });
    return;
  }
  if (phrase.length < 2 || phrase.length > 100) {
    await interaction.editReply({ embeds: [makeEmbed({ title: "❌ Invalid", color: COLORS.error, description: "Phrase must be 2–100 characters." })] });
    return;
  }
  await addBlacklistPhrase(guildId, phrase, interaction.user.id);
  await interaction.editReply({ embeds: [makeEmbed({ title: "🚫 Phrase Blacklisted", color: COLORS.brain, description: `**${phrase}** will no longer be learned.` })] });
}
