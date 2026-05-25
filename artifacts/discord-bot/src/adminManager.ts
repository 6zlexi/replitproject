/**
 * adminManager.ts — Persistent per-guild admin list.
 *
 * Admins are stored in data/guilds/<guildId>/admins.json and mirrored in an
 * in-memory cache so permission checks can remain synchronous (no await needed
 * inside isAdmin()). The cache is loaded at startup and updated on every change.
 */

import { promises as fs } from "fs";
import path from "path";
import { DIRS } from "./persistence.js";
import { logger } from "./logger.js";

// ── In-memory cache ──────────────────────────────────────────────────────────
const cache = new Map<string, Set<string>>(); // guildId → Set<userId>

function adminFilePath(guildId: string): string {
  return path.join(DIRS.guilds, guildId, "admins.json");
}

async function readFromDisk(guildId: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(adminFilePath(guildId), "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data)
      ? data.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

async function writeToDisk(guildId: string, admins: string[]): Promise<void> {
  const file = adminFilePath(guildId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify([...new Set(admins)], null, 2), "utf8");
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load (or reload) the admin list from disk into the in-memory cache.
 * Call this at startup for every guild and whenever a guild is joined.
 */
export async function loadAdminCache(guildId: string): Promise<void> {
  const admins = await readFromDisk(guildId);
  cache.set(guildId, new Set(admins));
}

/**
 * Synchronous permission check — safe to call inside isAdmin() without await.
 * Returns false for guilds whose cache hasn't been loaded yet (safe fallback).
 */
export function isGrantedAdminCached(guildId: string, userId: string): boolean {
  return cache.get(guildId)?.has(userId) ?? false;
}

/** Grant admin to a user. Updates disk + in-memory cache atomically. */
export async function addAdmin(guildId: string, userId: string): Promise<void> {
  const admins = await readFromDisk(guildId);
  if (!admins.includes(userId)) admins.push(userId);
  await writeToDisk(guildId, admins);
  cache.set(guildId, new Set(admins));
  logger.info({ guildId, userId }, "Admin granted");
}

/**
 * Revoke admin from a user.
 * Returns false if the user wasn't in the admin list.
 */
export async function removeAdmin(guildId: string, userId: string): Promise<boolean> {
  const admins = await readFromDisk(guildId);
  const idx = admins.indexOf(userId);
  if (idx === -1) return false;
  admins.splice(idx, 1);
  await writeToDisk(guildId, admins);
  cache.set(guildId, new Set(admins));
  logger.info({ guildId, userId }, "Admin revoked");
  return true;
}

/** Return all granted admin user IDs for a guild. */
export async function getAdmins(guildId: string): Promise<string[]> {
  return readFromDisk(guildId);
}
