/**
 * commandRegistry.ts — Single source of truth for all bot commands.
 *
 * HOW TO ADD A NEW COMMAND:
 *   1. Add an entry to COMMAND_REGISTRY below (name, category, description)
 *   2. Add the case to the switch statement in commands.ts
 *   3. That's it — ?commands updates automatically
 */

export interface CommandDef {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  category: string;
  permissionNote?: string;
}

export const COMMAND_REGISTRY: CommandDef[] = [

  // ── Moderation ────────────────────────────────────────────────────────────
  { name: "warn",    category: "Moderation", description: "Warn a member",                     usage: "?warn <@user> [reason]" },
  { name: "unwarn",  category: "Moderation", description: "Remove latest warn",                usage: "?unwarn <@user>" },
  { name: "history", category: "Moderation", description: "View full warn history",            usage: "?history <@user>" },
  { name: "mute",    aliases: ["timeout"],   category: "Moderation", description: "Mute/timeout a member (default 10m)", usage: "?mute <@user> [mins] [reason]" },
  { name: "unmute",  aliases: ["untimeout"], category: "Moderation", description: "Remove timeout",                     usage: "?unmute <@user>" },
  { name: "kick",    category: "Moderation", description: "Kick a member",                     usage: "?kick <@user> [reason]" },
  { name: "ban",     category: "Moderation", description: "Ban a member",                      usage: "?ban <@user> [reason]" },

  // ── Channel Management ────────────────────────────────────────────────────
  { name: "lock1",        category: "Channel Management", description: "Lock — co-owner + admin only" },
  { name: "lock2",        category: "Channel Management", description: "Lock — co-owner + admin + mod only" },
  { name: "unlock",       category: "Channel Management", description: "Unlock channel" },
  { name: "purge",        aliases: ["clear"], category: "Channel Management", description: "Delete N messages or wipe all", usage: "?purge <1-100 | all>" },
  { name: "movemulti",    aliases: ["move"],  category: "Channel Management", description: "Move channels to category",    usage: "?movemulti <category> <#ch1> ..." },
  { name: "deleteemojis", category: "Channel Management", description: "Delete all custom emojis" },

  // ── Utility ───────────────────────────────────────────────────────────────
  { name: "ping",       category: "Utility", description: "Bot latency" },
  { name: "serverinfo", aliases: ["server"], category: "Utility", description: "Server information" },
  { name: "userinfo",   aliases: ["user"],   category: "Utility", description: "User information", usage: "?userinfo [@user]" },
  { name: "avatar",     aliases: ["av"],     category: "Utility", description: "Show user avatar",  usage: "?avatar [@user]" },
  { name: "commands",   aliases: ["commands_list", "help"], category: "Utility", description: "Show this command list" },
  { name: "aistatus",   category: "Utility", description: "Check AI status" },
  { name: "aikeys",     category: "Utility", description: "View AI key statuses", permissionNote: "bot owner only" },

  // ── Script Registry ───────────────────────────────────────────────────────
  { name: "script",    category: "Script Registry", description: "Show script info",       usage: "?script <name>" },
  { name: "status",    category: "Script Registry", description: "Show script status",     usage: "?status <name>" },
  { name: "addscript", category: "Script Registry", description: "Add or update script",   usage: "?addscript <name> | <desc> | <author>" },
  { name: "setstatus", category: "Script Registry", description: "Set script status",      usage: "?setstatus <name> | <online|offline|maintenance>", permissionNote: "admin+" },

  // ── Anti-Nuke ─────────────────────────────────────────────────────────────
  { name: "whitelistbot",   category: "Anti-Nuke", description: "Whitelist a bot",         usage: "?whitelistbot <@bot>" },
  { name: "unwhitelistbot", category: "Anti-Nuke", description: "Remove from whitelist",   usage: "?unwhitelistbot <@bot>" },
  { name: "whitelistedbots",category: "Anti-Nuke", description: "Show all whitelisted bots" },

  // ── AI Brain ──────────────────────────────────────────────────────────────
  { name: "brainstats",      category: "AI Brain", description: "Learning statistics" },
  { name: "memorysize",      category: "AI Brain", description: "Memory breakdown" },
  { name: "learn",           category: "AI Brain", description: "Force-teach the bot a phrase", usage: "?learn <text>",   permissionNote: "owner only" },
  { name: "unlearn",         category: "AI Brain", description: "Remove a phrase from memory",  usage: "?unlearn <phrase>", permissionNote: "owner only" },
  { name: "wipebrain",       category: "AI Brain", description: "Wipe all learned memory",      permissionNote: "owner only" },
  { name: "blacklistphrase", category: "AI Brain", description: "Blacklist a phrase from learning", usage: "?blacklistphrase <phrase>", permissionNote: "owner only" },

  // ── Tickets ───────────────────────────────────────────────────────────────
  { name: "ticket", category: "Tickets", description: "Post the ticket panel", permissionNote: "staff only" },

  // ── Mood ──────────────────────────────────────────────────────────────────
  { name: "botmood",   category: "Mood", description: "Set bot mood", usage: "?botmood <happy|sad|angry|tired|chaotic|neutral>", permissionNote: "admin+" },
  { name: "moodcheck", category: "Mood", description: "Show current bot mood" },
  { name: "rate",      category: "Mood", description: "Rate a user 1–10 (mood-influenced)", usage: "?rate <@user>" },

  // ── Fun ───────────────────────────────────────────────────────────────────
  { name: "iq",   category: "Fun", description: "IQ score (consistent per user per day)", usage: "?iq [@user]" },
  { name: "ship", category: "Fun", description: "Compatibility % with another user",      usage: "?ship <@user>" },
  { name: "simp", category: "Fun", description: "Simp meter %",                           usage: "?simp <@user>" },

  // ── Economy ───────────────────────────────────────────────────────────────
  { name: "balance",     aliases: ["bal"], category: "Economy", description: "View coin balance, level, XP", usage: "?balance [@user]" },
  { name: "daily",       category: "Economy", description: "Claim daily coins (24h cooldown, streak bonus)" },
  { name: "work",        category: "Economy", description: "Work for coins (4h cooldown)" },
  { name: "crime",       category: "Economy", description: "Risk coins for bigger reward (8h cooldown, 40% success)" },
  { name: "leaderboard", aliases: ["lb"], category: "Economy", description: "Top 10 coin holders" },
  { name: "streak",      category: "Economy", description: "Check daily streak status" },

  // ── Games ─────────────────────────────────────────────────────────────────
  { name: "wordgame",   aliases: ["games"], category: "Games", description: "Start a word game lobby (react ✅ to join)" },
  { name: "hint",       category: "Games",  description: "Show hint for current round",        permissionNote: "owner/co-owner only" },
  { name: "extraheart", category: "Games",  description: "Give a player +1 heart during game", usage: "?extraheart <@user>", permissionNote: "owner/co-owner only" },

  // ── Owner / Backup ────────────────────────────────────────────────────────
  { name: "export",    category: "Owner", description: "Export guild data as a zip",      permissionNote: "server owner" },
  { name: "backup",    category: "Owner", description: "Backup guild data via DM",        permissionNote: "bot owner only" },
  { name: "backupbot", category: "Owner", description: "Full bot backup (all files) via DM", permissionNote: "owner/co-owner" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns commands grouped by category (insertion order is preserved). */
export function getCommandsByCategory(): Map<string, CommandDef[]> {
  const map = new Map<string, CommandDef[]>();
  for (const cmd of COMMAND_REGISTRY) {
    if (!map.has(cmd.category)) map.set(cmd.category, []);
    map.get(cmd.category)!.push(cmd);
  }
  return map;
}

/** Returns every command name + alias as a flat Set (useful for validation). */
export function getAllCommandNames(): Set<string> {
  const names = new Set<string>();
  for (const cmd of COMMAND_REGISTRY) {
    names.add(cmd.name);
    for (const alias of cmd.aliases ?? []) names.add(alias);
  }
  return names;
}
