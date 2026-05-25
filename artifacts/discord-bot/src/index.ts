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
import { loadAdminCache } from "./adminManager.js";
import { initAntiNuke } from "./antinuke.js";
import { handleMemberJoin, handleMemberLeave, cacheInvites, setupInviteTracking } from "./welcome.js";
import { initPersistence } from "./persistence.js";
import { sendLog, makeEmbed } from "./logging.js";
import { COLORS } from "./permissions.js";
import { logger } from "./logger.js";

// ── Dedup guard: each message ID processed at most once ──────────────────────
const processingMessages = new Set<string>();

// ── Context-trigger cooldown — prevents reply spam from "the bot" / "this bot"
const contextCooldowns = new Map<string, number>(); // channelId → expiry timestamp
const CONTEXT_COOLDOWN_MS = 8_000; // 8 s between context-triggered replies per channel

// ── Natural presence — Santo occasionally joins casual conversation unprompted ─
// Per-channel: minimum 25–45 min between spontaneous messages in same channel.
// Global: minimum 5 min across all channels (prevents multi-channel flooding).
const naturalPresenceCooldowns = new Map<string, number>(); // channelId → expiry
let   globalNaturalPresenceExpiry = 0;
const NATURAL_PRESENCE_CHANCE          = 0.09;           // ~9% on a qualifying message
const NATURAL_PRESENCE_CHANNEL_MIN_MS  = 25 * 60_000;   // 25 min per channel base
const NATURAL_PRESENCE_CHANNEL_JITTER  = 20 * 60_000;   // + 0-20 min random jitter
const NATURAL_PRESENCE_GLOBAL_MIN_MS   =  5 * 60_000;   //  5 min global floor

// Short casual messages that Santo might naturally join in on
const CASUAL_OPENER_PATTERNS = [
  /^\b(hi+|hey+|hello+|sup|yo+|yoo+|wassup|wsp|ayy+|ayo+)\b\s*[!.]*\s*$/i,
  /^(what('?s| is) (up|good|going on)|how is everyone|how('?s| is) (everyone|it going))\b/i,
  /^(what are (y'?all|you all|yall) (doing|up to))\b/i,
  /^(this server is (dead|quiet|boring|slow)|bro (this server|it) is (dead|quiet|boring))\b/i,
  /^(anyone (here|active|online|awake|alive)\??|is anyone (here|up|awake)\??)\b/i,
  /^(bro|bruh|bro\.|bruh\.)\s*[!?]*\s*$/i,
  /^(im bored|so bored|this is boring|nothing to do)\b/i,
];

/** Returns true if the message looks like a casual opener Santo can join in on. */
function isCasualOpener(content: string): boolean {
  const t = content.trim();
  if (t.length > 60) return false; // too long to be a simple opener
  return CASUAL_OPENER_PATTERNS.some((rx) => rx.test(t));
}

// ── Solo conversation mode ────────────────────────────────────────────────────
// When only one user has been active in a channel for the past SOLO_WINDOW_MS,
// Santo treats their messages as directed at it (no mention/trigger needed).
// A per-channel cooldown prevents reply spam; resets when a second user speaks.
const channelSpeakers   = new Map<string, Map<string, number>>(); // channelId → userId → lastTs
const soloModeCooldowns = new Map<string, number>();              // channelId → cooldown expiry
const SOLO_WINDOW_MS    = 8 * 60_000; // 8 min window for "solo" detection
const SOLO_COOLDOWN_MS  = 15_000;     // 15 s between solo-mode replies per channel

function trackSpeaker(channelId: string, userId: string): void {
  if (!channelSpeakers.has(channelId)) channelSpeakers.set(channelId, new Map());
  const speakers = channelSpeakers.get(channelId)!;
  speakers.set(userId, Date.now());
  // Prune stale entries (older than 2× the window) to avoid unbounded growth
  const cutoff = Date.now() - SOLO_WINDOW_MS * 2;
  for (const [uid, ts] of speakers) if (ts < cutoff) speakers.delete(uid);
}

/**
 * Returns the userId of the sole active speaker in the channel, or null if
 * zero or multiple users have spoken within SOLO_WINDOW_MS.
 */
function getSoloSpeaker(channelId: string): string | null {
  const speakers = channelSpeakers.get(channelId);
  if (!speakers) return null;
  const now    = Date.now();
  const recent = [...speakers.entries()].filter(([, ts]) => now - ts < SOLO_WINDOW_MS);
  return recent.length === 1 ? recent[0]![0] : null;
}

/**
 * Send a reply, splitting on ||| markers for a natural multi-message feel.
 * Part 1 is sent as a reply; additional parts go to the channel with a delay.
 */
async function sendSplitReply(message: Message, raw: string): Promise<void> {
  const SEPARATOR = "|||";
  const parts = raw
    .split(SEPARATOR)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 2); // max 2 parts

  for (let i = 0; i < parts.length; i++) {
    const text = parts[i]!;
    if (i === 0) {
      await message.reply(text);
    } else {
      // Natural pause before the follow-up message
      const delay = 1_200 + Math.random() * 1_300; // 1.2 – 2.5 s
      await new Promise<void>((r) => setTimeout(r, delay));
      await message.channel.send(text);
    }
  }
}

/** Strip ||| separators for clean history storage. */
function cleanForHistory(text: string): string {
  return text.replace(/\|\|\|/g, " ").replace(/\s{2,}/g, " ").trim();
}

// ── Bot trigger words — case-insensitive, word-boundary matched ───────────────
// "santo" is always checked. "this bot" / "the bot" are context phrases.
const BOT_TRIGGER_WORDS = ["santo"];

// Phrases that explicitly reference a bot (and thus Santo) in context
const BOT_CONTEXT_PHRASES = [
  /\bthis bot\b/i,
  /\bthe bot\b/i,
];

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
 *   2. Context phrase ("this bot", "the bot") — fires unless false-positive
 *   3. Pronoun ("he" / "him") — only fires if the bot was named in the last 3 messages
 *
 * Context-triggered replies are subject to an 8-second per-channel cooldown
 * applied in the caller (not here).
 */
function analyzeMessageContext(
  content: string,
  channelId: string,
  botId: string,
  historyBeforeThisMessage: { username: string; content: string; ts: number }[]
): ContextAnalysis {
  const lower = content.toLowerCase().trim();

  // 1. Trigger word check ("santo")
  const hasTriggerWord = BOT_TRIGGER_WORDS.some((w) =>
    new RegExp(`\\b${w}\\b`, "i").test(lower)
  );

  if (hasTriggerWord) {
    if (FALSE_POSITIVE_PATTERNS.some((rx) => rx.test(lower))) {
      return { triggered: false, reason: "trigger_word_false_positive" };
    }
    return { triggered: true, reason: "trigger_word" };
  }

  // 2. Context phrase check ("this bot", "the bot")
  const hasContextPhrase = BOT_CONTEXT_PHRASES.some((rx) => rx.test(lower));
  if (hasContextPhrase) {
    if (FALSE_POSITIVE_PATTERNS.some((rx) => rx.test(lower))) {
      return { triggered: false, reason: "context_phrase_false_positive" };
    }
    return { triggered: true, reason: "context_phrase" };
  }

  // 3. Pronoun check — only if bot was recently named
  if (/\b(he|him|his)\b/i.test(lower)) {
    const last3 = historyBeforeThisMessage.slice(-3);
    const botRecentlyMentioned = last3.some(
      (m) =>
        BOT_TRIGGER_WORDS.some((w) =>
          new RegExp(`\\b${w}\\b`, "i").test(m.content)
        ) ||
        BOT_CONTEXT_PHRASES.some((rx) => rx.test(m.content)) ||
        m.content.includes(`<@${botId}>`)
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
        await loadAdminCache(guild.id).catch((err) =>
          logger.warn({ err, guildId: guild.id }, "Failed to load admin cache")
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
    loadAdminCache(guild.id).catch((err) =>
      logger.warn({ err, guildId: guild.id }, "GuildCreate: failed to load admin cache")
    );
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

      // Track speaker for solo conversation mode (every message, before trigger check)
      trackSpeaker(message.channelId, message.author.id);

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

      // Solo mode: if this user is the only one active in the last 8 min,
      // treat their messages as directed at Santo (with its own cooldown)
      const soloSpeakerId = getSoloSpeaker(message.channelId);
      const isSoloTrigger =
        soloSpeakerId === message.author.id &&
        Date.now() > (soloModeCooldowns.get(message.channelId) ?? 0);

      const isDirectTrigger = mentioned || isReplyToBot;
      const isTriggered = isDirectTrigger || contextAnalysis.triggered || isSoloTrigger;

      if (!isTriggered) {
        // ── Natural presence — occasionally join casual openers unprompted ────
        if (
          isCasualOpener(content) &&
          isAIEnabled() &&
          Date.now() > globalNaturalPresenceExpiry &&
          Date.now() > (naturalPresenceCooldowns.get(message.channelId) ?? 0) &&
          Math.random() < NATURAL_PRESENCE_CHANCE
        ) {
          // Delay 4-10 s — feels like Santo noticed and decided to say something
          const delay = 4_000 + Math.random() * 6_000;
          setTimeout(async () => {
            try {
              const reply = await generateReply(
                guildId, guildName, message.channelId,
                content, message.author.username,
                undefined, /* replyContext */
                true       /* spontaneous */
              );
              if (reply) {
                const now = Date.now();
                globalNaturalPresenceExpiry =
                  now + NATURAL_PRESENCE_GLOBAL_MIN_MS;
                naturalPresenceCooldowns.set(
                  message.channelId,
                  now + NATURAL_PRESENCE_CHANNEL_MIN_MS + Math.random() * NATURAL_PRESENCE_CHANNEL_JITTER
                );
                await sendSplitReply(message, reply);
                addToConversationHistory(message.channelId, "bot", cleanForHistory(reply));
                logger.info({ guildId, channelId: message.channelId }, "Natural presence triggered");
              }
            } catch (err) {
              logger.warn({ err }, "Natural presence reply failed");
            }
          }, delay);
        }
        return;
      }

      // ── Context-trigger cooldown — prevents reply spam ─────────────────────
      // Direct triggers (@mention, reply-to-bot) bypass the cooldown.
      if (!isDirectTrigger) {
        const now = Date.now();
        const cooldownExpiry = contextCooldowns.get(message.channelId) ?? 0;
        if (now < cooldownExpiry) return;
        contextCooldowns.set(message.channelId, now + CONTEXT_COOLDOWN_MS);
      }

      // ── Solo-mode cooldown — 15 s between solo-triggered replies ───────────
      if (isSoloTrigger && !isDirectTrigger && !contextAnalysis.triggered) {
        soloModeCooldowns.set(message.channelId, Date.now() + SOLO_COOLDOWN_MS);
      }

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
        await sendSplitReply(message, reply);
        addToConversationHistory(message.channelId, "bot", cleanForHistory(reply));
        logger.info(
          {
            guildId,
            trigger: mentioned
              ? "mention"
              : isReplyToBot
              ? "reply_to_bot"
              : isSoloTrigger
              ? "solo_conversation"
              : contextAnalysis.reason,
            split: reply.includes("|||"),
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
