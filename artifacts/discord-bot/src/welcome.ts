import {
  type GuildMember,
  type Guild,
  type TextChannel,
  type Collection,
  type Invite,
  EmbedBuilder,
  Client,
} from "discord.js";
import { sendLog, makeEmbed } from "./logging.js";
import { COLORS } from "./permissions.js";
import { logger } from "./logger.js";

const WELCOME_CHANNEL = "welcome";
const inviteCache = new Map<string, Map<string, number>>();

export async function cacheInvites(guild: Guild): Promise<void> {
  try {
    const invites = await guild.invites.fetch();
    const cache = new Map<string, number>();
    invites.forEach((inv) => { if (inv.code) cache.set(inv.code, inv.uses ?? 0); });
    inviteCache.set(guild.id, cache);
  } catch {
    // Invite tracking requires MANAGE_GUILD permission
  }
}

export function setupInviteTracking(client: Client): void {
  client.on("inviteCreate", async (invite) => {
    if (!invite.guild) return;
    const cache = inviteCache.get(invite.guild.id) ?? new Map();
    cache.set(invite.code, invite.uses ?? 0);
    inviteCache.set(invite.guild.id, cache);
  });

  client.on("inviteDelete", async (invite) => {
    if (!invite.guild) return;
    const cache = inviteCache.get(invite.guild.id);
    if (cache) cache.delete(invite.code);
  });
}

async function findInviter(member: GuildMember): Promise<string | null> {
  try {
    const guild = member.guild;
    const oldCache = inviteCache.get(guild.id) ?? new Map<string, number>();
    const currentInvites = await guild.invites.fetch();

    let inviterId: string | null = null;
    currentInvites.forEach((inv) => {
      const oldUses = oldCache.get(inv.code) ?? 0;
      if ((inv.uses ?? 0) > oldUses && inv.inviter) {
        inviterId = inv.inviter.id;
      }
    });

    const newCache = new Map<string, number>();
    currentInvites.forEach((inv) => { if (inv.code) newCache.set(inv.code, inv.uses ?? 0); });
    inviteCache.set(guild.id, newCache);

    return inviterId;
  } catch {
    return null;
  }
}

// The exact autorole name — the leading "- " is intentional
const AUTOROLE_NAME = "- members";

async function assignAutorole(member: GuildMember): Promise<void> {
  // Never assign autorole to bots
  if (member.user.bot) return;

  const guild = member.guild;

  // Look up the role by exact name (case-sensitive to match "- members" exactly)
  const role = guild.roles.cache.find((r) => r.name === AUTOROLE_NAME);

  if (!role) {
    logger.warn(
      { guildId: guild.id, roleName: AUTOROLE_NAME },
      "Autorole: role not found"
    );
    await sendLog(
      guild,
      makeEmbed({
        title: "⚠️ Autorole Failed",
        color: COLORS.error,
        description: `Could not find the role **\`${AUTOROLE_NAME}\`** to assign to <@${member.id}>.\n\nPlease create a role with that exact name.`,
        fields: [
          { name: "User", value: `<@${member.id}> (${member.user.tag})`, inline: true },
        ],
      })
    );
    return;
  }

  try {
    await member.roles.add(role, "Autorole on join");
    logger.info(
      { guildId: guild.id, userId: member.id, roleId: role.id, roleName: role.name },
      "Autorole assigned"
    );
    await sendLog(
      guild,
      makeEmbed({
        title: "✅ Autorole Assigned",
        color: COLORS.success,
        description: `<@&${role.id}> was automatically given to <@${member.id}>.`,
        fields: [
          { name: "User", value: `<@${member.id}> (${member.user.tag})`, inline: true },
          { name: "Role", value: `\`${role.name}\``, inline: true },
        ],
      })
    );
  } catch (err) {
    logger.error({ err, guildId: guild.id, userId: member.id }, "Autorole assignment failed");
    await sendLog(
      guild,
      makeEmbed({
        title: "❌ Autorole Error",
        color: COLORS.error,
        description: `Failed to assign **\`${AUTOROLE_NAME}\`** to <@${member.id}>.\n\nMake sure the bot's role is **above** the \`${AUTOROLE_NAME}\` role in Server Settings → Roles.`,
        fields: [
          { name: "User", value: `<@${member.id}> (${member.user.tag})`, inline: true },
          { name: "Error", value: err instanceof Error ? err.message : String(err) },
        ],
      })
    );
  }
}

export async function handleMemberJoin(member: GuildMember): Promise<void> {
  const guild = member.guild;

  // Assign autorole immediately on join (runs in parallel with welcome message)
  assignAutorole(member).catch((err) =>
    logger.error({ err }, "Unexpected autorole error")
  );

  const welcomeChannel = guild.channels.cache.find(
    (c) => c.name.toLowerCase() === WELCOME_CHANNEL && c.isTextBased()
  ) as TextChannel | undefined;

  if (!welcomeChannel) return;

  const inviterId = await findInviter(member);
  const memberCount = guild.memberCount;
  const joinedAt = Math.floor(member.joinedTimestamp! / 1000);
  const createdAt = Math.floor(member.user.createdTimestamp / 1000);

  try {
    const embed = new EmbedBuilder()
      .setColor(COLORS.welcome)
      .setTitle(`👋 Welcome to ${guild.name}!`)
      .setDescription(`welcome! <@${member.id}>\n\nplease read the rules to avoid being banned!`)
      .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: "Member", value: `<@${member.id}> (${member.user.tag})`, inline: true },
        { name: "Member #", value: String(memberCount), inline: true },
        { name: "Account Created", value: `<t:${createdAt}:R>`, inline: true },
        { name: "Joined Server", value: `<t:${joinedAt}:F>`, inline: false },
        ...(inviterId ? [{ name: "Invited By", value: `<@${inviterId}>`, inline: true }] : []),
      )
      .setTimestamp();

    await welcomeChannel.send({ content: `<@${member.id}>`, embeds: [embed] });
  } catch (err) {
    logger.warn({ err }, "Failed to send welcome message");
  }

  await sendLog(guild, makeEmbed({
    title: "📥 Member Joined",
    color: COLORS.info,
    fields: [
      { name: "User", value: `<@${member.id}> (${member.user.tag})`, inline: true },
      { name: "Account Age", value: `<t:${createdAt}:R>`, inline: true },
      { name: "Member Count", value: String(memberCount), inline: true },
      ...(inviterId ? [{ name: "Invited By", value: `<@${inviterId}>`, inline: true }] : []),
    ],
  }));
}

export async function handleMemberLeave(member: GuildMember): Promise<void> {
  const guild = member.guild;

  await sendLog(guild, makeEmbed({
    title: "📤 Member Left",
    color: COLORS.mod,
    fields: [
      { name: "User", value: `${member.user.tag} (${member.id})`, inline: true },
      { name: "Joined", value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : "Unknown", inline: true },
    ],
  }));
}
