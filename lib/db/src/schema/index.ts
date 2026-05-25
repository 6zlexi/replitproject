import { pgTable, text, integer, boolean, timestamp, serial, uniqueIndex, real } from "drizzle-orm/pg-core";

export const modActions = pgTable("mod_actions", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  action: text("action").notNull(),
  userId: text("user_id").notNull(),
  moderatorId: text("moderator_id").notNull(),
  reason: text("reason").notNull().default("No reason provided"),
  extra: text("extra"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const modWarns = pgTable("mod_warns", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  moderatorId: text("moderator_id").notNull(),
  reason: text("reason").notNull().default("No reason provided"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const modMuteHistory = pgTable("mod_mute_history", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  moderatorId: text("moderator_id").notNull(),
  reason: text("reason").notNull().default("No reason provided"),
  durationMinutes: integer("duration_minutes").notNull().default(10),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  unmutedAt: timestamp("unmuted_at"),
});

export const modUserFlags = pgTable("mod_user_flags", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  warnKicked: boolean("warn_kicked").notNull().default(false),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const whitelistedBots = pgTable("whitelisted_bots", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  botId: text("bot_id").notNull(),
  addedBy: text("added_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const scripts = pgTable("scripts", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  author: text("author").notNull(),
  status: text("status").notNull().default("online"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const brainBlacklist = pgTable("brain_blacklist", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  phrase: text("phrase").notNull(),
  addedBy: text("added_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const brainPhrases = pgTable("brain_phrases", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  phrase: text("phrase").notNull(),
  frequency: integer("frequency").notNull().default(1),
  lastSeen: timestamp("last_seen").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("brain_phrases_guild_phrase_idx").on(t.guildId, t.phrase),
]);

export const brainPatterns = pgTable("brain_patterns", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  pattern: text("pattern").notNull(),
  frequency: integer("frequency").notNull().default(1),
  lastSeen: timestamp("last_seen").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("brain_patterns_guild_pattern_idx").on(t.guildId, t.pattern),
]);

export const brainMessages = pgTable("brain_messages", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  authorId: text("author_id").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const brainGuildStats = pgTable("brain_guild_stats", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull().unique(),
  totalMessagesLearned: integer("total_messages_learned").notNull().default(0),
  totalPhrases: integer("total_phrases").notNull().default(0),
  totalPatterns: integer("total_patterns").notNull().default(0),
  lastLearnedAt: timestamp("last_learned_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const brainUserProfiles = pgTable("brain_user_profiles", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  messageCount: integer("message_count").notNull().default(0),
  avgMessageLength: real("avg_message_length").notNull().default(0),
  topicsJson: text("topics_json").notNull().default("[]"),
  styleJson: text("style_json").notNull().default("{}"),
  lastActive: timestamp("last_active").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("brain_user_profiles_guild_user_idx").on(t.guildId, t.userId),
]);
