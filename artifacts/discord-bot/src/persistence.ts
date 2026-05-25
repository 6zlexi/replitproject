import { promises as fs } from "fs";
import path from "path";
import { db } from "@workspace/db";
import {
  modWarns,
  modMuteHistory,
  modUserFlags,
  whitelistedBots,
  scripts,
  brainBlacklist,
  brainPhrases,
  brainPatterns,
  brainMessages,
  brainGuildStats,
  brainUserProfiles,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";
import type { Client } from "discord.js";

const BASE = process.cwd();
export const DIRS = {
  data: path.join(BASE, "data"),
  guilds: path.join(BASE, "data", "guilds"),
  memory: path.join(BASE, "memory"),
  brain: path.join(BASE, "memory", "brain"),
  configs: path.join(BASE, "configs"),
  logs: path.join(BASE, "logs"),
  backups: path.join(BASE, "logs", "backups"),
};

export async function ensureDirectories(): Promise<void> {
  await Promise.all(Object.values(DIRS).map((d) => fs.mkdir(d, { recursive: true })));
  logger.info({ dirs: Object.keys(DIRS) }, "Storage directories ready");
}

async function safeWriteJSON(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    logger.warn({ err, filePath }, "JSON write failed");
    await fs.unlink(tmpPath).catch(() => {});
  }
}

async function safeReadJSON<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function guildDir(guildId: string): string {
  return path.join(DIRS.guilds, guildId);
}

function brainDir(guildId: string): string {
  return path.join(DIRS.brain, guildId);
}

type AnyRow = Record<string, unknown>;

function parseDates(arr: AnyRow[] | null, fields: string[]): AnyRow[] {
  return (arr ?? []).map(({ id: _id, ...rest }) => {
    const obj: AnyRow = { ...rest };
    for (const f of fields) {
      if (obj[f] && typeof obj[f] === "string") {
        obj[f] = new Date(obj[f] as string);
      }
    }
    return obj;
  });
}

export async function backupGuildData(guildId: string): Promise<void> {
  try {
    const [warns, mutes, flags, bots, scriptList, blacklist] = await Promise.all([
      db.select().from(modWarns).where(eq(modWarns.guildId, guildId)),
      db.select().from(modMuteHistory).where(eq(modMuteHistory.guildId, guildId)),
      db.select().from(modUserFlags).where(eq(modUserFlags.guildId, guildId)),
      db.select().from(whitelistedBots).where(eq(whitelistedBots.guildId, guildId)),
      db.select().from(scripts).where(eq(scripts.guildId, guildId)),
      db.select().from(brainBlacklist).where(eq(brainBlacklist.guildId, guildId)),
    ]);

    const [phrases, patterns, messages, stats, profiles] = await Promise.all([
      db.select().from(brainPhrases).where(eq(brainPhrases.guildId, guildId)),
      db.select().from(brainPatterns).where(eq(brainPatterns.guildId, guildId)),
      db.select().from(brainMessages).where(eq(brainMessages.guildId, guildId)),
      db.select().from(brainGuildStats).where(eq(brainGuildStats.guildId, guildId)),
      db.select().from(brainUserProfiles).where(eq(brainUserProfiles.guildId, guildId)),
    ]);

    const gd = guildDir(guildId);
    const bd = brainDir(guildId);

    await Promise.all([
      safeWriteJSON(path.join(gd, "warns.json"), warns),
      safeWriteJSON(path.join(gd, "mutes.json"), mutes),
      safeWriteJSON(path.join(gd, "flags.json"), flags),
      safeWriteJSON(path.join(gd, "whitelist.json"), bots),
      safeWriteJSON(path.join(gd, "scripts.json"), scriptList),
      safeWriteJSON(path.join(gd, "blacklist.json"), blacklist),
      safeWriteJSON(path.join(bd, "phrases.json"), phrases),
      safeWriteJSON(path.join(bd, "patterns.json"), patterns),
      safeWriteJSON(path.join(bd, "messages.json"), messages),
      safeWriteJSON(path.join(bd, "stats.json"), stats),
      safeWriteJSON(path.join(bd, "profiles.json"), profiles),
    ]);
  } catch (err) {
    logger.warn({ err, guildId }, "Guild backup failed");
  }
}

export async function importGuildDataIfEmpty(guildId: string): Promise<void> {
  try {
    const check = await db.select().from(modWarns).where(eq(modWarns.guildId, guildId)).limit(1);
    const brainCheck = await db.select().from(brainPhrases).where(eq(brainPhrases.guildId, guildId)).limit(1);

    const hasModData = check.length > 0;
    const hasBrainData = brainCheck.length > 0;

    if (hasModData && hasBrainData) return;

    const gd = guildDir(guildId);
    const bd = brainDir(guildId);

    try {
      await fs.access(path.join(gd, "warns.json"));
    } catch {
      return; // no backup files
    }

    logger.info({ guildId }, "Importing guild data from backup files");

    const [warns, mutes, flags, bots, scriptList, blacklist] = await Promise.all([
      safeReadJSON<AnyRow[]>(path.join(gd, "warns.json")),
      safeReadJSON<AnyRow[]>(path.join(gd, "mutes.json")),
      safeReadJSON<AnyRow[]>(path.join(gd, "flags.json")),
      safeReadJSON<AnyRow[]>(path.join(gd, "whitelist.json")),
      safeReadJSON<AnyRow[]>(path.join(gd, "scripts.json")),
      safeReadJSON<AnyRow[]>(path.join(gd, "blacklist.json")),
    ]);

    const [phrases, patterns, messages, profiles] = await Promise.all([
      safeReadJSON<AnyRow[]>(path.join(bd, "phrases.json")),
      safeReadJSON<AnyRow[]>(path.join(bd, "patterns.json")),
      safeReadJSON<AnyRow[]>(path.join(bd, "messages.json")),
      safeReadJSON<AnyRow[]>(path.join(bd, "profiles.json")),
    ]);

    const ops: Promise<unknown>[] = [];

    if (!hasModData) {
      if (warns?.length) ops.push(db.insert(modWarns).values(parseDates(warns, ["createdAt"]) as never[]));
      if (mutes?.length) ops.push(db.insert(modMuteHistory).values(parseDates(mutes, ["createdAt", "unmutedAt"]) as never[]));
      if (flags?.length) ops.push(db.insert(modUserFlags).values(parseDates(flags, ["updatedAt"]) as never[]));
      if (bots?.length) ops.push(db.insert(whitelistedBots).values(parseDates(bots, ["createdAt"]) as never[]));
      if (scriptList?.length) ops.push(db.insert(scripts).values(parseDates(scriptList, ["createdAt", "updatedAt"]) as never[]));
      if (blacklist?.length) ops.push(db.insert(brainBlacklist).values(parseDates(blacklist, ["createdAt"]) as never[]));
    }

    if (!hasBrainData) {
      if (phrases?.length) ops.push(db.insert(brainPhrases).values(parseDates(phrases, ["lastSeen", "createdAt"]) as never[]));
      if (patterns?.length) ops.push(db.insert(brainPatterns).values(parseDates(patterns, ["lastSeen", "createdAt"]) as never[]));
      if (profiles?.length) ops.push(db.insert(brainUserProfiles).values(parseDates(profiles, ["lastActive", "updatedAt"]) as never[]));

      if (messages?.length) {
        const CHUNK = 100;
        for (let i = 0; i < messages.length; i += CHUNK) {
          const chunk = parseDates(messages.slice(i, i + CHUNK), ["createdAt"]);
          ops.push(db.insert(brainMessages).values(chunk as never[]));
        }
      }
    }

    await Promise.all(ops);
    logger.info({ guildId }, "Guild data imported from backup files");
  } catch (err) {
    logger.warn({ err, guildId }, "Import from files failed");
  }
}

async function pruneOldBackups(): Promise<void> {
  try {
    const files = (await fs.readdir(DIRS.backups))
      .filter((f) => f.startsWith("backup-") && f.endsWith(".json"))
      .sort();
    const toDelete = files.slice(0, Math.max(0, files.length - 10));
    await Promise.all(toDelete.map((f) => fs.unlink(path.join(DIRS.backups, f)).catch(() => {})));
  } catch {
    // ignore
  }
}

async function createTimestampedBackup(client: Client): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const summary: Record<string, string> = {};

  for (const guild of client.guilds.cache.values()) {
    await backupGuildData(guild.id);
    summary[guild.id] = guild.name;
  }

  await safeWriteJSON(path.join(DIRS.backups, `backup-${ts}.json`), {
    createdAt: new Date().toISOString(),
    guilds: summary,
  });

  await pruneOldBackups();
  logger.info({ guilds: client.guilds.cache.size }, "Backup complete");
}

export async function initPersistence(client: Client): Promise<void> {
  await ensureDirectories();

  for (const guild of client.guilds.cache.values()) {
    await importGuildDataIfEmpty(guild.id);
  }

  // First backup 10s after startup
  setTimeout(() => {
    createTimestampedBackup(client).catch((err) => logger.warn({ err }, "Initial backup failed"));
  }, 10_000);

  // Backup every 30 minutes
  setInterval(() => {
    createTimestampedBackup(client).catch((err) => logger.warn({ err }, "Scheduled backup failed"));
  }, 30 * 60 * 1_000);

  logger.info("Persistence system initialized — backups every 30 minutes");
}

// Instant save — called immediately after any data mutation
export const saveGuildDataNow = backupGuildData;
