import { db } from "@workspace/db";
import {
  brainPhrases,
  brainPatterns,
  brainMessages,
  brainBlacklist,
  brainUserProfiles,
  brainGuildStats,
} from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { checkLearning, sanitizeForLearning, isSpam } from "./safety.js";
import { saveGuildDataNow } from "./persistence.js";
import { logger } from "./logger.js";

const MAX_MESSAGES_PER_GUILD = 5000;
const MAX_PHRASES_PER_GUILD = 2000;
const MAX_PATTERNS_PER_GUILD = 1000;
const RECENT_MSG_WINDOW = 20;

const recentMessageCache = new Map<string, string[]>();

export async function learnFromMessage(
  guildId: string,
  channelId: string,
  authorId: string,
  content: string,
  privileged: boolean = false
): Promise<void> {
  const safety = checkLearning(content, privileged);
  if (!safety.safe) return;

  const cacheKey = `${guildId}:${channelId}`;
  const recent = recentMessageCache.get(cacheKey) ?? [];
  const cleanContent = sanitizeForLearning(content);

  if (!cleanContent || cleanContent.length < 3) return;
  if (isSpam(cleanContent, recent)) return;

  const blacklisted = await isBlacklisted(guildId, cleanContent);
  if (blacklisted) return;

  recent.push(cleanContent);
  if (recent.length > RECENT_MSG_WINDOW) recent.shift();
  recentMessageCache.set(cacheKey, recent);

  await Promise.all([
    storeMessage(guildId, channelId, authorId, cleanContent),
    extractAndStorePhrases(guildId, cleanContent),
    extractAndStorePatterns(guildId, cleanContent),
    updateUserProfile(guildId, authorId, cleanContent),
    updateGuildStats(guildId),
  ]);
}

async function storeMessage(
  guildId: string,
  channelId: string,
  authorId: string,
  content: string
): Promise<void> {
  try {
    await db.insert(brainMessages).values({
      guildId,
      channelId,
      authorId,
      content,
    });

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(brainMessages)
      .where(eq(brainMessages.guildId, guildId));

    const count = Number(countResult[0]?.count ?? 0);
    if (count > MAX_MESSAGES_PER_GUILD) {
      const oldest = await db
        .select({ id: brainMessages.id })
        .from(brainMessages)
        .where(eq(brainMessages.guildId, guildId))
        .orderBy(brainMessages.createdAt)
        .limit(Math.floor(MAX_MESSAGES_PER_GUILD * 0.1));

      if (oldest.length > 0) {
        const ids = oldest.map((r) => r.id);
        await db.delete(brainMessages).where(
          and(
            eq(brainMessages.guildId, guildId),
            sql`${brainMessages.id} = ANY(${sql.raw(`ARRAY[${ids.join(",")}]`)})`
          )
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to store message");
  }
}

async function extractAndStorePhrases(
  guildId: string,
  content: string
): Promise<void> {
  try {
    const words = content.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    const phrases: string[] = [];

    for (const word of words) {
      if (word.length >= 3) phrases.push(word);
    }
    for (let i = 0; i < words.length - 1; i++) {
      phrases.push(`${words[i]} ${words[i + 1]}`);
    }
    for (let i = 0; i < words.length - 2; i++) {
      phrases.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }

    const toUpsert = phrases.slice(0, 20);
    for (const phrase of toUpsert) {
      if (!phrase || phrase.trim().length < 3) continue;
      await db
        .insert(brainPhrases)
        .values({ guildId, phrase, frequency: 1 })
        .onConflictDoNothing();

      await db
        .update(brainPhrases)
        .set({
          frequency: sql`${brainPhrases.frequency} + 1`,
          lastSeen: new Date(),
        })
        .where(
          and(
            eq(brainPhrases.guildId, guildId),
            eq(brainPhrases.phrase, phrase)
          )
        );
    }

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(brainPhrases)
      .where(eq(brainPhrases.guildId, guildId));

    const count = Number(countResult[0]?.count ?? 0);
    if (count > MAX_PHRASES_PER_GUILD) {
      await db
        .delete(brainPhrases)
        .where(
          and(
            eq(brainPhrases.guildId, guildId),
            sql`${brainPhrases.id} IN (
              SELECT id FROM brain_phrases
              WHERE guild_id = ${guildId}
              ORDER BY frequency ASC, last_seen ASC
              LIMIT ${Math.floor(MAX_PHRASES_PER_GUILD * 0.1)}
            )`
          )
        );
    }
  } catch (err) {
    logger.warn({ err }, "Failed to store phrases");
  }
}

async function extractAndStorePatterns(
  guildId: string,
  content: string
): Promise<void> {
  try {
    const patterns: string[] = [];

    if (content.endsWith("?")) patterns.push("question_style");
    if (content.endsWith("!") || content.endsWith("!!")) patterns.push("exclamation_style");
    if (content === content.toLowerCase()) patterns.push("lowercase_style");
    if (content.length < 20) patterns.push("short_message");
    if (content.length > 100) patterns.push("long_message");
    if (/lol|lmao|lmfao|haha|hehe|xd/i.test(content)) patterns.push("humor_style");
    if (/bruh|bro|fam|ngl|imo|tbh|fr|nah|yea|yep|nope/i.test(content)) patterns.push("casual_slang");
    if (/\.\.\./.test(content)) patterns.push("ellipsis_style");

    for (const pattern of patterns) {
      await db
        .insert(brainPatterns)
        .values({ guildId, pattern, frequency: 1 })
        .onConflictDoNothing();

      await db
        .update(brainPatterns)
        .set({
          frequency: sql`${brainPatterns.frequency} + 1`,
          lastSeen: new Date(),
        })
        .where(
          and(
            eq(brainPatterns.guildId, guildId),
            eq(brainPatterns.pattern, pattern)
          )
        );
    }
  } catch (err) {
    logger.warn({ err }, "Failed to store patterns");
  }
}

async function updateUserProfile(
  guildId: string,
  userId: string,
  content: string
): Promise<void> {
  try {
    const existing = await db
      .select()
      .from(brainUserProfiles)
      .where(
        and(
          eq(brainUserProfiles.guildId, guildId),
          eq(brainUserProfiles.userId, userId)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(brainUserProfiles).values({
        guildId,
        userId,
        messageCount: 1,
        avgMessageLength: content.length,
        topicsJson: "[]",
        styleJson: "{}",
        lastActive: new Date(),
        updatedAt: new Date(),
      });
    } else {
      const profile = existing[0]!;
      const newCount = profile.messageCount + 1;
      const newAvg =
        (profile.avgMessageLength * profile.messageCount + content.length) / newCount;

      await db
        .update(brainUserProfiles)
        .set({
          messageCount: newCount,
          avgMessageLength: newAvg,
          lastActive: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(brainUserProfiles.guildId, guildId),
            eq(brainUserProfiles.userId, userId)
          )
        );
    }
  } catch (err) {
    logger.warn({ err }, "Failed to update user profile");
  }
}

async function updateGuildStats(guildId: string): Promise<void> {
  try {
    const [msgCount, phraseCount, patternCount] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(brainMessages).where(eq(brainMessages.guildId, guildId)),
      db.select({ count: sql<number>`count(*)` }).from(brainPhrases).where(eq(brainPhrases.guildId, guildId)),
      db.select({ count: sql<number>`count(*)` }).from(brainPatterns).where(eq(brainPatterns.guildId, guildId)),
    ]);

    await db
      .insert(brainGuildStats)
      .values({
        guildId,
        totalMessagesLearned: Number(msgCount[0]?.count ?? 0),
        totalPhrases: Number(phraseCount[0]?.count ?? 0),
        totalPatterns: Number(patternCount[0]?.count ?? 0),
        lastLearnedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();

    await db
      .update(brainGuildStats)
      .set({
        totalMessagesLearned: Number(msgCount[0]?.count ?? 0),
        totalPhrases: Number(phraseCount[0]?.count ?? 0),
        totalPatterns: Number(patternCount[0]?.count ?? 0),
        lastLearnedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(brainGuildStats.guildId, guildId));
  } catch (err) {
    logger.warn({ err }, "Failed to update guild stats");
  }
}

async function isBlacklisted(guildId: string, content: string): Promise<boolean> {
  try {
    const blacklist = await db
      .select({ phrase: brainBlacklist.phrase })
      .from(brainBlacklist)
      .where(eq(brainBlacklist.guildId, guildId));

    const lower = content.toLowerCase();
    return blacklist.some((b) => lower.includes(b.phrase.toLowerCase()));
  } catch {
    return false;
  }
}

export async function getContextForReply(guildId: string): Promise<{
  topPhrases: string[];
  topPatterns: string[];
  recentMessages: string[];
  stats: { messages: number; phrases: number; patterns: number };
}> {
  try {
    const [phrases, patterns, recent, stats] = await Promise.all([
      db
        .select({ phrase: brainPhrases.phrase, frequency: brainPhrases.frequency })
        .from(brainPhrases)
        .where(eq(brainPhrases.guildId, guildId))
        .orderBy(desc(brainPhrases.frequency))
        .limit(50),
      db
        .select({ pattern: brainPatterns.pattern, frequency: brainPatterns.frequency })
        .from(brainPatterns)
        .where(eq(brainPatterns.guildId, guildId))
        .orderBy(desc(brainPatterns.frequency))
        .limit(20),
      db
        .select({ content: brainMessages.content })
        .from(brainMessages)
        .where(eq(brainMessages.guildId, guildId))
        .orderBy(desc(brainMessages.createdAt))
        .limit(30),
      db
        .select()
        .from(brainGuildStats)
        .where(eq(brainGuildStats.guildId, guildId))
        .limit(1),
    ]);

    return {
      topPhrases: phrases.map((p) => p.phrase),
      topPatterns: patterns.map((p) => p.pattern),
      recentMessages: recent.map((m) => m.content),
      stats: {
        messages: Number(stats[0]?.totalMessagesLearned ?? 0),
        phrases: Number(stats[0]?.totalPhrases ?? 0),
        patterns: Number(stats[0]?.totalPatterns ?? 0),
      },
    };
  } catch (err) {
    logger.warn({ err }, "Failed to get context");
    return {
      topPhrases: [],
      topPatterns: [],
      recentMessages: [],
      stats: { messages: 0, phrases: 0, patterns: 0 },
    };
  }
}

/**
 * Force-learn a specific phrase/message directly from the owner.
 * Bypasses ALL safety filters, spam checks, and blacklist — owner knows best.
 */
export async function forceLearn(
  guildId: string,
  channelId: string,
  authorId: string,
  content: string
): Promise<void> {
  const clean = content.trim();
  if (!clean || clean.length < 2) return;

  // Update the in-memory recent cache so the AI sees it immediately
  const cacheKey = `${guildId}:${channelId}`;
  const recent = recentMessageCache.get(cacheKey) ?? [];
  recent.push(clean);
  if (recent.length > RECENT_MSG_WINDOW) recent.shift();
  recentMessageCache.set(cacheKey, recent);

  await Promise.all([
    storeMessage(guildId, channelId, authorId, clean),
    extractAndStorePhrases(guildId, clean),
    extractAndStorePatterns(guildId, clean),
    updateUserProfile(guildId, authorId, clean),
    updateGuildStats(guildId),
  ]);

  saveGuildDataNow(guildId).catch(() => {});
}

export async function wipeBrain(guildId: string): Promise<void> {
  await Promise.all([
    db.delete(brainMessages).where(eq(brainMessages.guildId, guildId)),
    db.delete(brainPhrases).where(eq(brainPhrases.guildId, guildId)),
    db.delete(brainPatterns).where(eq(brainPatterns.guildId, guildId)),
    db.delete(brainUserProfiles).where(eq(brainUserProfiles.guildId, guildId)),
    db.delete(brainGuildStats).where(eq(brainGuildStats.guildId, guildId)),
  ]);
  for (const key of recentMessageCache.keys()) {
    if (key.startsWith(`${guildId}:`)) recentMessageCache.delete(key);
  }
}

/**
 * Remove a specific phrase from the brain's phrase store.
 * Matches exact phrase and any messages that are identical to it.
 */
export async function unlearnPhrase(
  guildId: string,
  phrase: string
): Promise<{ phrasesRemoved: number; messagesRemoved: number }> {
  const lower = phrase.toLowerCase().trim();

  const [phraseResult, messageResult] = await Promise.all([
    db
      .delete(brainPhrases)
      .where(and(eq(brainPhrases.guildId, guildId), eq(brainPhrases.phrase, lower)))
      .returning({ id: brainPhrases.id }),
    db
      .delete(brainMessages)
      .where(and(eq(brainMessages.guildId, guildId), eq(brainMessages.content, lower)))
      .returning({ id: brainMessages.id }),
  ]);

  saveGuildDataNow(guildId).catch(() => {});

  return {
    phrasesRemoved: phraseResult.length,
    messagesRemoved: messageResult.length,
  };
}

export async function addBlacklistPhrase(
  guildId: string,
  phrase: string,
  addedBy: string
): Promise<void> {
  await db
    .insert(brainBlacklist)
    .values({ guildId, phrase: phrase.toLowerCase(), addedBy })
    .onConflictDoNothing();
  saveGuildDataNow(guildId).catch(() => {});
}

export async function getMemorySize(guildId: string): Promise<{
  messages: number;
  phrases: number;
  patterns: number;
  blacklist: number;
  userProfiles: number;
  estimatedKB: number;
}> {
  const [msgs, phrases, patterns, blacklist, profiles] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(brainMessages).where(eq(brainMessages.guildId, guildId)),
    db.select({ count: sql<number>`count(*)` }).from(brainPhrases).where(eq(brainPhrases.guildId, guildId)),
    db.select({ count: sql<number>`count(*)` }).from(brainPatterns).where(eq(brainPatterns.guildId, guildId)),
    db.select({ count: sql<number>`count(*)` }).from(brainBlacklist).where(eq(brainBlacklist.guildId, guildId)),
    db.select({ count: sql<number>`count(*)` }).from(brainUserProfiles).where(eq(brainUserProfiles.guildId, guildId)),
  ]);

  const msgCount = Number(msgs[0]?.count ?? 0);
  const phraseCount = Number(phrases[0]?.count ?? 0);
  const patternCount = Number(patterns[0]?.count ?? 0);
  const blacklistCount = Number(blacklist[0]?.count ?? 0);
  const profileCount = Number(profiles[0]?.count ?? 0);

  const estimatedKB = Math.round(
    msgCount * 0.2 + phraseCount * 0.05 + patternCount * 0.02 + profileCount * 0.1
  );

  return {
    messages: msgCount,
    phrases: phraseCount,
    patterns: patternCount,
    blacklist: blacklistCount,
    userProfiles: profileCount,
    estimatedKB,
  };
}

export async function getBrainStats(guildId: string) {
  return getMemorySize(guildId);
}
