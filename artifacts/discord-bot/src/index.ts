import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  Events,
  type GuildMember,
} from "discord.js";
import { handleCommand } from "./commands.js";
import { handleTicketInteraction } from "./tickets.js";
import {
  registerSlashCommands,
  registerSlashCommandsForGuild,
  handleSlashCommand,
} from "./slashCommands.js";
import { learnFromMessage } from "./brain.js";
import {
  generateReply,
  addToConversationHistory,
  getChannelHistory,
  checkAIHealth,
  isAIEnabled,
  setDiscordClient,
  type ReplyContext,
} from "./ai.js";
import { isPrivileged } from "./permissions.js";
import { initAntiNuke } from "./antinuke.js";
import { handleMemberJoin, handleMemberLeave, cacheInvites, setupInviteTracking } from "./welcome.js";
import { initPersistence } from "./persistence.js";
import { sendLog, makeEmbed } from "./logging.js";
import { COLORS } from "./permissions.js";
import { logger } from "./logger.js";

// ── Dedup guard: each message ID processed at most once ──────────────────────
const processingMessages = new Set<string>();

// ── Bot trigger words — case-insensitive, word-boundary matched ───────────────
// "santo" is treated as a possible reference to the bot; context is verified.
const BOT_TRIGGER_WORDS = ["santo"];

// Phrases where the trigger word clearly isn't about this bot
const FALSE_POSITIVE_PATTERNS = [
  /\btodos los santos\b/i,
  /\bdía de (los )?muertos\b/i,
  /\bpatron saint\b/i,
  /\bsanto domingo\b/i,
  /\bsanto tom[aá]s\b/i,
  /\bel santo\b/i,
  /\bla santa\b/i,
];

// ── Context-based trigger analysis ───────────────────────────────────────────
interface ContextAnalysis {
  triggered: boolean;
  reason: string;
}

/**
 * Decides if a message is likely directed at or about the bot using context.
 *
 * Priority:
 *   1. Trigger word ("santo") — always fires unless a false-positive pattern matches
 *   2. Pronoun ("he" / "him") — only fires if the bot was named in the last 3 messages
 *
 * No cooldown is applied to context triggers.
 */
function analyzeMessageContext(
  content: string,
  channelId: string,
  botId: string,
  historyBeforeThisMessage: { username: string; content: string; ts: number }[]
): ContextAnalysis {
  const lower = content.toLowerCase().trim();

  // 1. Trigger word check
  const hasTriggerWord = BOT_TRIGGER_WORDS.some((w) =>
    new RegExp(`\\b${w}\\b`, "i").test(lower)
  );

  if (hasTriggerWord) {
    if (FALSE_POSITIVE_PATTERNS.some((rx) => rx.test(lower))) {
      return { triggered: false, reason: "trigger_word_false_positive" };
    }
    return { triggered: true, reason: "trigger_word" };
  }

  // 2. Pronoun check — only if bot was recently named
  if (/\b(he|him|his)\b/i.test(lower)) {
    const last3 = historyBeforeThisMessage.slice(-3);
    const botRecentlyMentioned = last3.some(
      (m) =>
        BOT_TRIGGER_WORDS.some((w) =>
          new RegExp(`\\b${w}\\b`, "i").test(m.content)
        ) || m.content.includes(`<@${botId}>`)
    );
    if (botRecentlyMentioned) {
      return { triggered: true, reason: "pronoun_after_bot_reference" };
    }
  }

  return { triggered: false, reason: "no_trigger" };
}

// ── Direct @mention check ─────────────────────────────────────────────────────
function isBotMentioned(message: Message, botId: string): boolean {
  if (message.mentions.users.has(botId)) return true;
  const raw = message.content ?? "";
  return raw.includes(`<@${botId}>`) || raw.includes(`<@!${botId}>`);
}

// ── Reply-to-bot resolution ───────────────────────────────────────────────────
async function resolveReplyContext(
  message: Message,
  botId: string
): Promise<{ isReplyToBot: boolean; context?: ReplyContext }> {
  const ref = message.reference;
  if (!ref?.messageId) return { isReplyToBot: false };
  try {
    const replied = await message.channel.messages.fetch(ref.messageId);
    if (replied.author.id !== botId) return { isReplyToBot: false };
    return {
      isReplyToBot: true,
      context: {
        authorUsername: replied.author.username,
        content: replied.content?.slice(0, 400) ?? "",
      },
    };
  } catch (err) {
    logger.warn({ err, messageId: ref.messageId }, "Could not fetch referenced message");
    return { isReplyToBot: false };
  }
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN is required");

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildInvites,
      GatewayIntentBits.GuildBans,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  });

  initAntiNuke(client);
  setupInviteTracking(client);

  client.once(Events.ClientReady, async (c) => {
    try {
      logger.info({ tag: c.user.tag, guilds: c.guilds.cache.size }, "Bot online");
      for (const guild of c.guilds.cache.values()) {
        await cacheInvites(guild).catch((err) =>
          logger.warn({ err, guildId: guild.id }, "Failed to cache invites")
        );
      }
      await initPersistence(client);
      setDiscordClient(client);
      checkAIHealth().catch((err) =>
        logger.warn({ err }, "AI health check threw unexpectedly")
      );
      // Register slash commands after client is ready and guilds are cached
      registerSlashCommands(client).catch((err) =>
        logger.error({ err }, "Slash command registration failed")
      );
    } catch (err) {
      logger.error({ err }, "ClientReady handler error");
    }
  });

  client.on(Events.GuildCreate, async (guild) => {
    try {
      await cacheInvites(guild);
    } catch (err) {
      logger.warn({ err, guildId: guild.id }, "GuildCreate: failed to cache invites");
    }
    // Register slash commands in the new guild immediately
    registerSlashCommandsForGuild(client, guild).catch((err) =>
      logger.warn({ err, guildId: guild.id }, "GuildCreate: slash registration failed")
    );
  });

  client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    try {
      await handleMemberJoin(member);
    } catch (err) {
      logger.error({ err }, "GuildMemberAdd handler error");
    }
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    try {
      if (member instanceof Object && "guild" in member && "user" in member) {
        await handleMemberLeave(member as GuildMember);
      }
    } catch (err) {
      logger.error({ err }, "GuildMemberRemove handler error");
    }
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore bots (including ourselves) and DMs
    if (message.author.bot) return;
    if (!message.guild) return;

    // Fetch partial messages so content is always available
    if (message.partial) {
      try {
        await message.fetch();
      } catch (err) {
        logger.warn({ err }, "Failed to fetch partial message — skipping");
        return;
      }
    }

    // Dedup: reject if we're already handling this message ID
    if (processingMessages.has(message.id)) return;
    processingMessages.add(message.id);
    setTimeout(() => processingMessages.delete(message.id), 15_000);

    try {
      const botId = client.user!.id;
      const content = message.content?.trim() ?? "";
      const guildId = message.guild.id;
      const guildName = message.guild.name;

      // ── Step 1: Commands — highest priority ────────────────────────────────
      const isCommand = await handleCommand(message).catch((err) => {
        logger.error({ err }, "Command handler error");
        return false;
      });
      if (isCommand) return;

      // ── Step 2: Snapshot history BEFORE adding this message ────────────────
      const historySnapshot = getChannelHistory(message.channelId);

      // ── Step 3: Learn + update history ────────────────────────────────────
      if (content) {
        const privileged = message.member ? isPrivileged(message.member) : false;
        learnFromMessage(guildId, message.channelId, message.author.id, content, privileged)
          .catch((err) => logger.warn({ err }, "Learn error"));
        addToConversationHistory(message.channelId, message.author.username, content);
      }

      // ── Step 4: Determine trigger conditions ───────────────────────────────
      const mentioned = isBotMentioned(message, botId);
      const { isReplyToBot, context: replyContext } = await resolveReplyContext(
        message, botId
      ).catch(() => ({ isReplyToBot: false, context: undefined }));

      // Context trigger — "santo" or pronoun after bot reference
      // Per design: NO cooldown on context triggers
      const contextAnalysis = analyzeMessageContext(
        content, message.channelId, botId, historySnapshot
      );

      const isDirectTrigger = mentioned || isReplyToBot;
      const isTriggered = isDirectTrigger || contextAnalysis.triggered;

      if (!isTriggered) return;

      // ── Step 5: Check AI is operational ───────────────────────────────────
      if (!isAIEnabled()) {
        logger.warn(
          { guildId, userId: message.author.id },
          "AI trigger received but AI is disabled — ignoring"
        );
        return;
      }

      logger.info(
        {
          guildId,
          userId: message.author.id,
          mentioned,
          isReplyToBot,
          contextReason: contextAnalysis.reason,
        },
        "AI trigger detected"
      );

      // ── Step 6: Clean message for AI ──────────────────────────────────────
      const cleanMessage = content.replace(/<@!?\d+>/g, "").trim();
      const messageForAI = cleanMessage.length > 0 ? cleanMessage : "hey";

      // ── Step 7: Generate and send reply ───────────────────────────────────
      const reply = await generateReply(
        guildId,
        guildName,
        message.channelId,
        messageForAI,
        message.author.username,
        replyContext
      );

      if (reply) {
        await message.reply(reply);
        addToConversationHistory(message.channelId, "bot", reply);
        logger.info(
          {
            guildId,
            trigger: mentioned
              ? "mention"
              : isReplyToBot
              ? "reply_to_bot"
              : contextAnalysis.reason,
          },
          "AI replied"
        );
      } else {
        // All providers failed
        if (isDirectTrigger) {
          await message.reply("ai is temporarily unavailable");
        }
        logger.warn({ guildId, userId: message.author.id }, "All AI providers failed");

        // Log failure to #logs channel
        sendLog(message.guild, makeEmbed({
          title: "❌ AI Failure",
          color: COLORS.error,
          description: "All Groq keys failed — no AI response could be generated.",
          fields: [
            { name: "Triggered by", value: `<@${message.author.id}>`, inline: true },
            { name: "Trigger",      value: mentioned ? "mention" : isReplyToBot ? "reply" : contextAnalysis.reason, inline: true },
          ],
        })).catch(() => {});
      }
    } catch (err) {
      logger.error({ err }, "MessageCreate handler error");
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        // Slash commands
        await handleSlashCommand(interaction);
      } else {
        // Buttons, select menus, modals (e.g. ticket panel)
        await handleTicketInteraction(interaction);
      }
    } catch (err) {
      logger.error({ err }, "InteractionCreate handler error");
    }
  });

  // ── Global safety net — keeps the process alive on unexpected errors ────────
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
  });

  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception");
  });

  await client.login(token);
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
