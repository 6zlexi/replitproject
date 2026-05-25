import type { GuildMember } from "discord.js";
import { isGrantedAdminCached } from "./adminManager.js";

export const COLORS = {
  info: 0x000000,
  success: 0x000000,
  warning: 0x000000,
  error: 0x000000,
  mute: 0x000000,
  mod: 0x000000,
  brain: 0x000000,
  antinuke: 0x000000,
  welcome: 0x000000,
} as const;

// Exact role names — the "-" is part of the real role name
const ROLE_OWNER = "- owner";
const ROLE_CO_OWNER = "- co owner";
const ROLE_ADMIN = "- admin";

// Slur-learning bypass: ONLY these three exact roles
const PRIVILEGED_SLUR_ROLES = [ROLE_OWNER, ROLE_CO_OWNER, ROLE_ADMIN] as const;

function hasExactRole(member: GuildMember, ...exactNames: string[]): boolean {
  return member.roles.cache.some((role) => exactNames.includes(role.name));
}

export function isGuildOwner(member: GuildMember): boolean {
  return member.id === member.guild.ownerId;
}

export function isBotOwner(userId: string): boolean {
  return userId === process.env.OWNER_ID;
}

// Highest tier: Discord guild owner, bot owner, or "- owner" / "- co owner" role
export function isCoOwner(member: GuildMember): boolean {
  return (
    isGuildOwner(member) ||
    isBotOwner(member.id) ||
    hasExactRole(member, ROLE_OWNER, ROLE_CO_OWNER)
  );
}

// Admin tier: co-owner chain OR "- admin" role OR owner-granted admin
export function isAdmin(member: GuildMember): boolean {
  return (
    isCoOwner(member) ||
    hasExactRole(member, ROLE_ADMIN) ||
    isGrantedAdminCached(member.guild.id, member.id)
  );
}

// Mod tier: admin chain OR a role named "- mod", "mod", or "moderator"
export function isMod(member: GuildMember): boolean {
  return (
    isAdmin(member) ||
    member.roles.cache.some((r) =>
      r.name.toLowerCase() === "- mod" ||
      r.name.toLowerCase() === "mod" ||
      r.name.toLowerCase() === "moderator"
    )
  );
}

export function canModerate(member: GuildMember): boolean {
  return isMod(member);
}

export function canLock(member: GuildMember): boolean {
  return isAdmin(member);
}

export function canManageWhitelist(member: GuildMember): boolean {
  return isCoOwner(member);
}

export function canManageBrain(member: GuildMember): boolean {
  return isGuildOwner(member) || isBotOwner(member.id);
}

export function canBulkDelete(member: GuildMember): boolean {
  return isMod(member);
}

// SLUR LEARNING BYPASS — only "- owner", "- co owner", "- admin" (exact names with dash)
// Guild owner and bot owner do NOT bypass by default — only staff with these exact roles do
export function isPrivileged(member: GuildMember): boolean {
  return hasExactRole(member, ...PRIVILEGED_SLUR_ROLES);
}
