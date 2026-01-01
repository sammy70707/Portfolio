import './server.js';
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField
} from 'discord.js';

const {
  DISCORD_TOKEN,
  VERIFY_CHANNEL_ID,
  REVIEW_CHANNEL_ID,
  NSFW_ROLE_ID
} = process.env;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// State
const submittedUsers = new Set();            // one reply per request
const declineStatus = new Map();             // userId -> { count, lastDecline }
const declinedActive = new Set();            // users who must restart after decline
const reviewMessageByUser = new Map();       // userId -> reviewMessageId

function reviewButtonRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_${userId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`decline_${userId}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger)
  );
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const verifyChannel = await client.channels.fetch(VERIFY_CHANNEL_ID).catch(() => null);
  if (!verifyChannel) {
    console.error('Verify channel not found. Check VERIFY_CHANNEL_ID.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('NSFW Age Verification')
    .setDescription(
      'Click the button below to request NSFW access.\n\n' +
      'You will be asked to confirm via DM, and our staff will review your request.'
    )
    .setColor(0x5865F2);

  await verifyChannel.send({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('verify_request')
          .setLabel('Verify age for NSFW')
          .setStyle(ButtonStyle.Primary)
      )
    ]
  }).catch(err => console.error('Failed to send verify message:', err));
});

// ---------- Interaction handler ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // User clicks Verify
    if (interaction.isButton() && interaction.customId === 'verify_request') {
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member) {
        await interaction.reply({ content: 'Could not fetch your member data. Try again later.', ephemeral: true });
        return;
      }

      if (member.roles.cache.has(NSFW_ROLE_ID)) {
        await interaction.reply({ content: 'You are already verified.', ephemeral: true });
        return;
      }

      const status = declineStatus.get(interaction.user.id);
      if (status && status.count >= 2) {
        const elapsed = Date.now() - status.lastDecline;
        if (elapsed < 24 * 60 * 60 * 1000) {
          const remaining = 24 * 60 * 60 * 1000 - elapsed;
          const hours = Math.floor(remaining / (1000 * 60 * 60));
          const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
          await interaction.reply({
            content: `You must wait ${hours}h ${minutes}m before trying again.`,
            ephemeral: true
          });
          return;
        } else {
          declineStatus.set(interaction.user.id, { count: 0, lastDecline: 0 });
        }
      }

      submittedUsers.delete(interaction.user.id);
      declinedActive.delete(interaction.user.id);

      await interaction.reply({
        content: 'Your verification request has been submitted. Please check your DMs.',
        ephemeral: true
      });

      try {
        await interaction.user.send(
          `✨ **NSFW Age Verification** ✨\n\n` +
          `🔞 Please confirm you are **18+** by replying with:\n\n` +
          `• A short statement (Telling about reason to give you the role)\n` +
          `• Or evidence like a **Video/Photo**\n` +
          `• Or a **Government ID** (with all crucial info hidden)\n\n` +
          `🛡️ Moderators will carefully review your request.`
        );
      } catch {
        await interaction.followUp({ content: 'Unable to DM you. Please enable DMs to continue.', ephemeral: true });
      }
    }

    // Staff clicks Accept
    if (interaction.isButton() && interaction.customId.startsWith('accept_')) {
      await interaction.deferUpdate();

      const [, userId] = interaction.customId.split('_');

      // Validate role existence and hierarchy
      const nsfwRole = interaction.guild.roles.cache.get(NSFW_ROLE_ID) ||
                       await interaction.guild.roles.fetch(NSFW_ROLE_ID).catch(() => null);
      if (!nsfwRole) {
        await interaction.followUp({ content: 'NSFW role not found. Check NSFW_ROLE_ID.', ephemeral: true });
        return;
      }

      const me = await interaction.guild.members.fetch(client.user.id);
      if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        await interaction.followUp({ content: 'I need the Manage Roles permission to assign NSFW role.', ephemeral: true });
        return;
      }
      if (nsfwRole.position >= me.roles.highest.position) {
        await interaction.followUp({ content: 'Move the NSFW role below my top role in Server Settings → Roles.', ephemeral: true });
        return;
      }

      const targetMember = await interaction.guild.members.fetch(userId).catch(() => null);
      if (!targetMember) {
        await interaction.followUp({ content: 'Could not fetch the target member.', ephemeral: true });
        return;
      }

      try {
        await targetMember.roles.add(nsfwRole);
      } catch (err) {
        console.error('Role add failed:', err);
        await interaction.followUp({
          content: `Failed to assign role: ${err?.code || err?.message || 'unknown error'}`,
          ephemeral: true
        });
        return;
      }

      submittedUsers.delete(userId);
      declinedActive.delete(userId);
      reviewMessageByUser.delete(userId);

      // Delete the ticket message
      await interaction.message.delete().catch(err => console.error('Failed to delete ticket message:', err));

      // Post celebratory message
      const reviewChannel = await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);
      if (reviewChannel) {
        await reviewChannel.send({
          content: `🔞💦 ${targetMember} has been successfully verified and provided the NSFW role!`
        }).catch(err => console.error('Failed to send celebratory message:', err));
      }

      try {
        await targetMember.send('✅ Your request was accepted. You now have access to NSFW channels.');
      } catch {}
    }

    // Staff clicks Decline → show modal (do NOT deferUpdate here)
    if (interaction.isButton() && interaction.customId.startsWith('decline_')) {
      const [, userId] = interaction.customId.split('_');

      const modal = new ModalBuilder()
        .setCustomId(`declineModal_${userId}`)
        .setTitle('Decline Reason');

      const reasonInput = new TextInputBuilder()
        .setCustomId('decline_reason')
        .setLabel('Enter reason for decline')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal);
    }

    // Handle Decline modal submission
    if (interaction.isModalSubmit() && interaction.customId.startsWith('declineModal_')) {
      const [, userId] = interaction.customId.split('_');
      const reason = interaction.fields.getTextInputValue('decline_reason');

      const status = declineStatus.get(userId) || { count: 0, lastDecline: 0 };
      status.count += 1;
      status.lastDecline = Date.now();
      declineStatus.set(userId, status);
      declinedActive.add(userId);
      submittedUsers.delete(userId);

      await interaction.reply({ content: 'Decline recorded.', ephemeral: true });

      // Delete ticket via stored message ID (if available) and post a summary
      const reviewChannel = await client.channels.fetch(REVIEW_CHANNEL_ID).catch(() => null);
      if (reviewChannel) {
        const reviewMsgId = reviewMessageByUser.get(userId);
        if (reviewMsgId) {
          const msg = await reviewChannel.messages.fetch(reviewMsgId).catch(() => null);
          if (msg) await msg.delete().catch(err => console.error('Failed to delete review message:', err));
          reviewMessageByUser.delete(userId);
        }

        const targetUser = await interaction.guild.members.fetch(userId).catch(() => null);
        const tag = targetUser ? `${targetUser}` : `User ID ${userId}`;
        await reviewChannel.send({
          content: `❌ Request from ${tag} has been declined.\n**Reason:** ${reason}`
        }).catch(() => {});
      }

      const targetMember = await interaction.guild.members.fetch(userId).catch(() => null);
      if (targetMember) {
        try {
          if (status.count === 1) {
            await targetMember.send(`❌ Your request was declined. Reason: ${reason}\nYou may submit a new request immediately by clicking Verify again.`);
          } else {
            await targetMember.send(`❌ Your request was declined again. Reason: ${reason}\nYou must wait 24 hours before trying again.`);
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'An error occurred handling that interaction.', ephemeral: true });
      }
    } catch {}
  }
});

// ---------- DM reply listener ----------
client.on('messageCreate', async (message) => {
  if (message.channel.type === ChannelType.DM) {
    const user = message.author;
    if (user.bot) return;

    if (declinedActive.has(user.id)) {
      await user.send('Your last request was declined. Please click Verify again in the server to start a new request.').catch(() => {});
      return;
    }

    if (submittedUsers.has(user.id)) {
      await user.send('You have already submitted your proof for this request. Please wait for staff review.').catch(() => {});
      return;
    }

    submittedUsers.add(user.id);

    try {
      const reviewChannel = await client.channels.fetch(REVIEW_CHANNEL_ID);
      let description = `User: ${user} (${user.tag})\nID: ${user.id}\n`;
      if (message.content?.trim()) description += `Statement: "${message.content}"\n`;
      if (message.attachments.size > 0) description += `Attachment included below.`;
      if (description.trim() === '') description += 'No content provided.';

      const embed = new EmbedBuilder()
        .setTitle('NSFW Verification Request')
        .setDescription(description)
        .setColor(0xFFA500)
        .setFooter({ text: 'Click Accept to assign NSFW role, or Decline to deny.' });

      const firstAttachment = message.attachments.first();
      let filesToSend = [];

      if (firstAttachment) {
        if (firstAttachment.contentType?.startsWith('image/')) {
          // show image inline
          embed.setImage(firstAttachment.url);
          filesToSend = message.attachments.filter(a => a.id !== firstAttachment.id).map(a => a.url);
        } else if (firstAttachment.contentType?.startsWith('video/')) {
          // show video link inside embed instead of sending as file
          embed.addFields({ name: 'Video Proof', value: `[Click to view video](${firstAttachment.url})` });
          filesToSend = message.attachments.filter(a => a.id !== firstAttachment.id).map(a => a.url);
        } else {
          filesToSend = message.attachments.map(a => a.url);
        }
      }

      const reviewMsg = await reviewChannel.send({
        embeds: [embed],
        components: [reviewButtonRow(user.id)],
        files: filesToSend
      });

      reviewMessageByUser.set(user.id, reviewMsg.id);
    } catch (err) {
      console.error('Failed to forward DM to review channel:', err);
    }
  }
});


client.login(DISCORD_TOKEN);
