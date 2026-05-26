import {
  type Message,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type Interaction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  type TextChannel,
  type Guild,
} from "discord.js";
import { isMod, COLORS } from "./permissions.js";
import { makeEmbed } from "./logging.js";
import { logger } from "./logger.js";

const STAFF_ROLE_NAMES = ["mod", "moderator", "- admin", "- owner", "- co owner", "staff"];

function staffButtons(disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_claim")
      .setLabel("Claim")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("🙋")
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Close")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🔒")
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("ticket_close_reason")
      .setLabel("Close with Reason")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📝")
      .setDisabled(disabled)
  );
}

export async function handleTicketPanel(message: Message): Promise<void> {
  if (!message.guild || !message.member) return;
  if (!isMod(message.member)) {
    await message.reply({
      embeds: [makeEmbed({ title: "❌ No Permission", color: COLORS.error, description: "Only **staff** can set up the ticket panel." })],
    });
    return;
  }

  const openBtn = new ButtonBuilder()
    .setCustomId("ticket_open")
    .setLabel("Open Ticket")
    .setStyle(ButtonStyle.Success)
    .setEmoji("🎫");

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(openBtn);

  if (message.channel?.isTextBased()) {
    await message.channel.send({
      embeds: [
      new EmbedBuilder()
        .setTitle("🎫 Support Tickets")
        .setColor(COLORS.info)
        .setDescription(
          "Need help? Click the button below to open a private support ticket.\nOur staff will assist you as soon as possible."
        )
        .setFooter({ text: "One ticket per issue • Be respectful" })
        .setTimestamp(),
    ],
    components: [row],
  });

  try { await message.delete(); } catch { /* ignore */ }
}

export async function handleOpenTicket(interaction: ButtonInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;

  await interaction.deferReply({ ephemeral: true });

  const user = interaction.user;
  const safeName = user.username.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 20) || "user";
  const channelName = `ticket-${safeName}`;

  // Check if user already has an open ticket
  const existing = guild.channels.cache.find(
    (c) => c.name === channelName && c.type === ChannelType.GuildText
  );
  if (existing) {
    await interaction.editReply({ content: `You already have an open ticket: <#${existing.id}>` });
    return;
  }

  // Build permission overwrites — deny everyone, allow ticket creator + staff
  const overwrites: Parameters<Guild["channels"]["create"]>[0]["permissionOverwrites"] = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  // Grant access to all staff roles
  for (const role of guild.roles.cache.values()) {
    if (STAFF_ROLE_NAMES.some((n) => role.name.toLowerCase() === n.toLowerCase())) {
      overwrites.push({
        id: role.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
        ],
      });
    }
  }

  try {
    const ticketChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      topic: `Support ticket for ${user.tag} (${user.id})`,
      permissionOverwrites: overwrites,
    }) as TextChannel;

    const ticketEmbed = new EmbedBuilder()
      .setTitle("🎫 Support Ticket")
      .setColor(COLORS.info)
      .setDescription(
        `Hello <@${user.id}>, this is your support ticket.\nPlease describe your issue and staff will assist you.`
      )
      .addFields({ name: "Opened by", value: `<@${user.id}>`, inline: true })
      .setTimestamp();

    await ticketChannel.send({
      embeds: [ticketEmbed],
      components: [staffButtons()],
    });

    await interaction.editReply({ content: `Your ticket has been created: <#${ticketChannel.id}>` });
    logger.info({ guildId: guild.id, userId: user.id, channel: channelName }, "Ticket opened");
  } catch (err) {
    logger.error({ err }, "Failed to create ticket channel");
    await interaction.editReply({ content: "Failed to create your ticket. Make sure I have **Manage Channels** permission." });
  }
}

export async function handleTicketClaim(interaction: ButtonInteraction): Promise<void> {
  const member = interaction.guild?.members.cache.get(interaction.user.id);
  if (!member || !isMod(member)) {
    await interaction.reply({ content: "Only staff can claim tickets.", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  const originalEmbed = interaction.message.embeds[0];
  if (!originalEmbed) return;

  const updated = EmbedBuilder.from(originalEmbed)
    .setColor(COLORS.success)
    .spliceFields(0, originalEmbed.fields.length, ...originalEmbed.fields)
    .addFields({ name: "Claimed by", value: `<@${interaction.user.id}>`, inline: true });

  const disabledRow = staffButtons(true);
  const reopenRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Close")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🔒"),
    new ButtonBuilder()
      .setCustomId("ticket_close_reason")
      .setLabel("Close with Reason")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📝")
  );

  await interaction.message.edit({ embeds: [updated], components: [reopenRow] });
  await (interaction.channel as TextChannel).send({
    embeds: [makeEmbed({ title: "✅ Ticket Claimed", color: COLORS.success, description: `<@${interaction.user.id}> has claimed this ticket.` })],
  });

  logger.info({ guildId: interaction.guildId, staffId: interaction.user.id }, "Ticket claimed");
}

export async function handleTicketClose(interaction: ButtonInteraction): Promise<void> {
  const member = interaction.guild?.members.cache.get(interaction.user.id);
  if (!member || !isMod(member)) {
    await interaction.reply({ content: "Only staff can close tickets.", ephemeral: true });
    return;
  }

  await interaction.reply({
    embeds: [makeEmbed({ title: "🔒 Closing ticket...", color: COLORS.error, description: "This channel will be deleted in 3 seconds." })],
  });

  setTimeout(async () => {
    try {
      await interaction.channel?.delete();
      logger.info({ guildId: interaction.guildId, staffId: interaction.user.id }, "Ticket closed");
    } catch (err) {
      logger.warn({ err }, "Failed to delete ticket channel");
    }
  }, 3000);
}

export async function handleTicketCloseWithReason(interaction: ButtonInteraction): Promise<void> {
  const member = interaction.guild?.members.cache.get(interaction.user.id);
  if (!member || !isMod(member)) {
    await interaction.reply({ content: "Only staff can close tickets.", ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId("ticket_close_modal")
    .setTitle("Close Ticket with Reason");

  const reasonInput = new TextInputBuilder()
    .setCustomId("ticket_reason")
    .setLabel("Reason for closing")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Describe why this ticket is being closed...")
    .setRequired(true)
    .setMaxLength(500);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput));
  await interaction.showModal(modal);
}

export async function handleTicketCloseModal(interaction: ModalSubmitInteraction): Promise<void> {
  const reason = interaction.fields.getTextInputValue("ticket_reason");
  const channel = interaction.channel as TextChannel | null;
  const guild = interaction.guild;

  await interaction.deferReply();

  // Try to DM the ticket opener if we can find them from channel topic
  if (guild && channel?.topic) {
    const match = channel.topic.match(/\((\d+)\)/);
    if (match?.[1]) {
      try {
        const opener = await guild.members.fetch(match[1]);
        const dm = await opener.user.createDM();
        await dm.send({
          embeds: [makeEmbed({
            title: "🔒 Your Ticket Was Closed",
            color: COLORS.mod,
            description: `Your support ticket in **${guild.name}** was closed.`,
            fields: [
              { name: "Closed by", value: `<@${interaction.user.id}>`, inline: true },
              { name: "Reason", value: reason },
            ],
          })],
        });
      } catch { /* DMs may be closed */ }
    }
  }

  await interaction.editReply({
    embeds: [makeEmbed({
      title: "🔒 Ticket Closed",
      color: COLORS.error,
      description: `Closed by <@${interaction.user.id}>\n**Reason:** ${reason}`,
    })],
  });

  logger.info({ guildId: guild?.id, staffId: interaction.user.id, reason }, "Ticket closed with reason");

  setTimeout(async () => {
    try { await channel?.delete(); } catch { /* ignore */ }
  }, 4000);
}

export async function handleTicketInteraction(interaction: Interaction): Promise<boolean> {
  if (interaction.isButton()) {
    switch (interaction.customId) {
      case "ticket_open":
        await handleOpenTicket(interaction);
        return true;
      case "ticket_claim":
        await handleTicketClaim(interaction);
        return true;
      case "ticket_close":
        await handleTicketClose(interaction);
        return true;
      case "ticket_close_reason":
        await handleTicketCloseWithReason(interaction);
        return true;
    }
  }
  if (interaction.isModalSubmit() && interaction.customId === "ticket_close_modal") {
    await handleTicketCloseModal(interaction);
    return true;
  }
  return false;
}
