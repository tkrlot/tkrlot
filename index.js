require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
  ActivityType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
} = require('discord.js');

const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  UPDATES_CHANNEL_IDS,
  FOOTER_ICON_URL,
  FOOTER_TEXT,
  AUTO_ROLE_ID,
  ACTIVITY_MODE,
  ACTIVITY_NAME,
  STREAM_URL,
  STATUS,
  SESSION_STYLE,
  SELLAPP_API_KEY,
  VERIFY_ROLE_ID,
  SQLITE_PATH,
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('[ERROR] Missing DISCORD_TOKEN or CLIENT_ID in .env');
  process.exit(1);
}
if (!SELLAPP_API_KEY) {
  console.warn('[WARN] SELLAPP_API_KEY not set. Verification will fail until provided.');
}

const EMBED_COLOR = 0x3336fc;
const DEFAULT_FOOTER_TEXT = 'Copyright 2025 © ICE R6S';
const MAX_IMAGES = 3;
const MODAL_MAX_COMPONENTS = 5;
const BUTTON_COOLDOWN_MS = 15_000;
const buttonCooldown = new Map();

function logInfo(msg) { console.log(`[INFO] ${msg}`); }
function logError(msg, err) { console.error(`[ERROR] ${msg}`, err || ''); }
function parseChannelIds(csv) {
  if (!csv || !csv.trim()) return [];
  return csv.split(',').map(s => s.trim()).filter(s => /^\d{17,20}$/.test(s));
}
const UPDATES_IDS = parseChannelIds(UPDATES_CHANNEL_IDS);

function resolveActivityType(mode) {
  switch ((mode || '').toLowerCase()) {
    case 'streaming': return ActivityType.Streaming;
    case 'playing': return ActivityType.Playing;
    case 'watching': return ActivityType.Watching;
    case 'listening': return ActivityType.Listening;
    case 'competing': return ActivityType.Competing;
    default: return ActivityType.Watching;
  }
}
function resolveStatus(status) {
  switch ((status || '').toLowerCase()) {
    case 'online': case 'idle': case 'dnd': case 'invisible': return status.toLowerCase();
    default: return 'online';
  }
}
function sessionPrefix(style) {
  const s = (style || '').toLowerCase();
  if (s === 'mobile') return '📱';
  if (s === 'desktop') return '🖥️';
  return '';
}

function buildEmbed({ title, description, imageUrl }) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setFooter({ text: FOOTER_TEXT && FOOTER_TEXT.trim() ? FOOTER_TEXT : DEFAULT_FOOTER_TEXT, iconURL: FOOTER_ICON_URL || null });
  if (title && title.trim()) embed.setTitle(title.trim());
  if (description && description.trim()) embed.setDescription(description);
  if (imageUrl && imageUrl.trim()) embed.setImage(imageUrl.trim());
  return embed;
}
function looksLikeUrl(s) {
  if (!s) return false;
  const t = s.trim();
  return /^https?:\/\/\S+\.\S+/.test(t);
}

const DB_PATH = SQLITE_PATH && SQLITE_PATH.trim() ? SQLITE_PATH.trim() : path.join(__dirname, 'data', 'bot.sqlite');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) { console.error('Failed to open SQLite DB:', err); process.exit(1); }
  logInfo(`SQLite DB opened at ${DB_PATH}`);
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL UNIQUE,
      discord_id TEXT NOT NULL,
      product_id TEXT,
      role_id TEXT,
      status TEXT NOT NULL,
      used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS role_mappings (
      product_id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL
    )
  `);
});

function extractInvoiceStatus(invoice) {
  if (!invoice) return null;
  if (typeof invoice.status === 'string' && invoice.status.trim()) return invoice.status.trim();
  if (invoice.status && typeof invoice.status === 'object') {
    const s = invoice.status;
    if (typeof s.status === 'string' && s.status.trim()) return s.status.trim();
    if (s.status && typeof s.status === 'object' && typeof s.status.status === 'string' && s.status.status.trim()) return s.status.status.trim();
    if (Array.isArray(s.history) && s.history.length > 0) {
      for (let i = s.history.length - 1; i >= 0; i--) {
        const h = s.history[i];
        if (h && typeof h.status === 'string' && h.status.trim()) return h.status.trim();
      }
    }
  }
  if (Array.isArray(invoice.history) && invoice.history.length > 0) {
    for (let i = invoice.history.length - 1; i >= 0; i--) {
      const h = invoice.history[i];
      if (h && typeof h.status === 'string' && h.status.trim()) return h.status.trim();
    }
  }
  const altKeys = ['state', 'payment_status', 'status_text'];
  for (const k of altKeys) {
    if (typeof invoice[k] === 'string' && invoice[k].trim()) return invoice[k].trim();
    if (invoice[k] && typeof invoice[k] === 'object' && typeof invoice[k].status === 'string' && invoice[k].status.trim()) return invoice[k].status.trim();
  }
  if (invoice.items && Array.isArray(invoice.items)) {
    for (const it of invoice.items) {
      if (it && typeof it.status === 'string' && it.status.trim()) return it.status.trim();
    }
  }
  return null;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
  partials: [Partials.GuildMember],
});

const updatesCommand = new SlashCommandBuilder().setName('updates').setDescription('Post an update (modal, sends to configured UPDATES channel).');
const embedCommand = new SlashCommandBuilder()
  .setName('embed')
  .setDescription('Send a custom embed via modal to a chosen channel.')
  .addChannelOption(opt => opt.setName('channel').setDescription('Channel to send the embed to').addChannelTypes(ChannelType.GuildText).setRequired(true));
const editembedCommand = new SlashCommandBuilder()
  .setName('editembed')
  .setDescription('Edit an existing bot embed message (admin only).')
  .addChannelOption(opt => opt.setName('channel').setDescription('Channel containing the message').addChannelTypes(ChannelType.GuildText).setRequired(true))
  .addStringOption(opt => opt.setName('message_id').setDescription('Message ID to edit').setRequired(true));
const verifyEmbCommand = new SlashCommandBuilder()
  .setName('verifyemb')
  .setDescription('Send the invoice verification embed to this channel (Admin only)')
  .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator);

const purgeCommand = new SlashCommandBuilder().setName('purge').setDescription('Delete messages in bulk (admin only).')
  .addIntegerOption(opt => opt.setName('count').setDescription('Number of messages to delete (1-100)').setRequired(true))
  .addChannelOption(opt => opt.setName('channel').setDescription('Channel to purge (defaults to current)').addChannelTypes(ChannelType.GuildText).setRequired(false));

const timeoutCommand = new SlashCommandBuilder().setName('timeout').setDescription('Timeout a user for a duration in minutes (admin only).')
  .addUserOption(opt => opt.setName('user').setDescription('User to timeout').setRequired(true))
  .addIntegerOption(opt => opt.setName('minutes').setDescription('Duration in minutes (1-40320)').setRequired(true))
  .addStringOption(opt => opt.setName('reason').setDescription('Reason for timeout').setRequired(false));

const untimeoutCommand = new SlashCommandBuilder().setName('untimeout').setDescription('Remove timeout from a user (admin only).')
  .addUserOption(opt => opt.setName('user').setDescription('User to remove timeout').setRequired(true));

const banCommand = new SlashCommandBuilder().setName('ban').setDescription('Ban a user (admin only).')
  .addUserOption(opt => opt.setName('user').setDescription('User to ban').setRequired(true))
  .addStringOption(opt => opt.setName('reason').setDescription('Reason for ban').setRequired(false))
  .addIntegerOption(opt => opt.setName('delete_days').setDescription('Delete message history in days (0-7)').setRequired(false));

const unbanCommand = new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID (admin only).')
  .addStringOption(opt => opt.setName('user_id').setDescription('User ID to unban').setRequired(true))
  .addStringOption(opt => opt.setName('reason').setDescription('Reason for unban').setRequired(false));

const commands = [
  updatesCommand, embedCommand, editembedCommand, purgeCommand, timeoutCommand, untimeoutCommand, banCommand, unbanCommand, verifyEmbCommand
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    logInfo('Registering global commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    logInfo('Global commands registered.');
  } catch (err) {
    logError('Failed to register commands', err);
  }
})();

client.once(Events.ClientReady, () => {
  logInfo(`Logged in as ${client.user.tag}`);
  try {
    const type = resolveActivityType(ACTIVITY_MODE);
    const status = resolveStatus(STATUS);
    const prefix = sessionPrefix(SESSION_STYLE);
    const nameBase = ACTIVITY_NAME && ACTIVITY_NAME.trim() ? ACTIVITY_NAME.trim() : 'ICE R6S';
    const activity = { name: prefix ? `${prefix} ${nameBase}` : nameBase, type };
    if (type === ActivityType.Streaming && STREAM_URL && STREAM_URL.trim()) activity.url = STREAM_URL.trim();
    client.user.setPresence({ status, activities: [activity] });
  } catch (e) { }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'editembed') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'Admin permissions required.', flags: 64 });
        }

        const targetChannel = interaction.options.getChannel('channel', true);
        const messageId = interaction.options.getString('message_id', true);

        const channel = targetChannel;
        if (!channel || channel.type !== ChannelType.GuildText) {
          return interaction.reply({ content: 'Invalid channel.', flags: 64 });
        }

        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) return interaction.reply({ content: 'Message not found.', flags: 64 });

        if (message.author?.id !== client.user.id) return interaction.reply({ content: 'I can only edit embeds that I sent.', flags: 64 });
        if (!message.embeds || message.embeds.length === 0) return interaction.reply({ content: 'Message has no embeds to edit.', flags: 64 });

        const embed = message.embeds[0];
        const title = embed.title || '';
        const description = embed.description || '';
        const imageUrl = embed.image?.url || '';
        const extraImages = [];
        for (let i = 1; i < Math.min(message.embeds.length, 1 + MAX_IMAGES); i++) {
          const e = message.embeds[i];
          if (e.image?.url) extraImages.push(e.image.url);
        }

        const modal = new ModalBuilder().setCustomId(`editembedModal:${channel.id}:${message.id}`).setTitle('Edit Embed');

        const titleInput = new TextInputBuilder()
          .setCustomId('edit_title')
          .setLabel('Title (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);
        if (title && title.length <= 4000) titleInput.setValue(title);

        const descriptionInput = new TextInputBuilder()
          .setCustomId('edit_description')
          .setLabel('Description (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false);
        if (description && description.length <= 4000) descriptionInput.setValue(description);

        const rows = [new ActionRowBuilder().addComponents(titleInput), new ActionRowBuilder().addComponents(descriptionInput)];

        for (let i = 0; i < MAX_IMAGES; i++) {
          const val = extraImages[i] || (i === 0 ? imageUrl : '');
          const input = new TextInputBuilder()
            .setCustomId(`edit_image_${i + 1}`)
            .setLabel(`Image URL ${i + 1} (optional)`)
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('https://...');
          if (val && val.length <= 4000) input.setValue(val);
          rows.push(new ActionRowBuilder().addComponents(input));
        }

        modal.addComponents(...rows.slice(0, MODAL_MAX_COMPONENTS));
        await interaction.showModal(modal);
        return;
      }

      if (commandName === 'verifyemb') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'Admin permissions required.', flags: 64 });
        }

        const descriptionText = [
          'Click the button below to verify your Sell.app invoice and receive your role.',
          '',
          'How it works: Click Verify → enter your invoice ID → if paid you will receive the role.',
          '',
          'Privacy: Invoice IDs are stored securely for verification and reassigning roles on rejoin.'
        ].join('\n');

        const embed = new EmbedBuilder()
          .setTitle('🔒 Invoice Verification')
          .setDescription(descriptionText)
          .setColor(0x00AE86)
          .setFooter({ text: FOOTER_TEXT && FOOTER_TEXT.trim() ? FOOTER_TEXT : DEFAULT_FOOTER_TEXT, iconURL: FOOTER_ICON_URL || null })
          .addFields(
            { name: 'Need help?', value: 'Contact staff if verification fails.' },
            { name: 'Find invoice ID', value: 'Use the invoice number from your Sell.app order (e.g., 2711846).' }
          );

        const button = new ButtonBuilder().setCustomId('verify_invoice_button').setLabel('Verify Invoice').setStyle(ButtonStyle.Primary).setEmoji('🔎');
        const row = new ActionRowBuilder().addComponents(button);

        try {
          await interaction.channel.send({ embeds: [embed], components: [row] });
          await interaction.reply({ content: '✅ Verification embed sent to this channel.', flags: 64 });
        } catch (err) {
          logError('Failed to send verification embed', err);
          await interaction.reply({ content: '❌ Failed to send verification embed. Check bot permissions.', flags: 64 });
        }
        return;
      }

      if (commandName === 'updates') {
        if (UPDATES_IDS.length === 0) {
          await interaction.reply({ content: 'UPDATES_CHANNEL_IDS is not configured in .env.', flags: 64 });
          return;
        }
        const modal = new ModalBuilder().setCustomId('updatesModal').setTitle('🔔 Updates');
        const descriptionInput = new TextInputBuilder().setCustomId('updates_description').setLabel('Update content').setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('Type your updates here.');
        const imageInput = new TextInputBuilder().setCustomId('updates_image').setLabel('Image URL (optional)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('https://...');
        modal.addComponents(new ActionRowBuilder().addComponents(descriptionInput), new ActionRowBuilder().addComponents(imageInput));
        await interaction.showModal(modal);
        return;
      }

      if (commandName === 'embed') {
        const targetChannel = interaction.options.getChannel('channel', true);
        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
          await interaction.reply({ content: 'Please choose a text channel.', flags: 64 });
          return;
        }
        const remainingSlots = MODAL_MAX_COMPONENTS - 2;
        const imageInputsToShow = Math.min(remainingSlots, MAX_IMAGES);
        const modal = new ModalBuilder().setCustomId(`embedModal:${targetChannel.id}`).setTitle('Create Embed');
        const titleInput = new TextInputBuilder().setCustomId('embed_title').setLabel('Title (optional)').setStyle(TextInputStyle.Short).setRequired(false);
        const descriptionInput = new TextInputBuilder().setCustomId('embed_description').setLabel('Description (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false);
        const rows = [new ActionRowBuilder().addComponents(titleInput), new ActionRowBuilder().addComponents(descriptionInput)];
        for (let i = 1; i <= imageInputsToShow; i++) {
          const img = new TextInputBuilder().setCustomId(`embed_image_${i}`).setLabel(`Image URL ${i} (optional)`).setStyle(TextInputStyle.Short).setRequired(false);
          rows.push(new ActionRowBuilder().addComponents(img));
        }
        modal.addComponents(...rows.slice(0, MODAL_MAX_COMPONENTS));
        await interaction.showModal(modal);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const id = interaction.customId;

      if (id.startsWith('editembedModal:')) {
        const parts = id.split(':');
        const channelId = parts[1];
        const messageId = parts[2];

        await interaction.deferReply({ flags: 64 });

        const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) {
          return interaction.editReply({ content: 'Target channel not found or not a text channel.' });
        }

        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) return interaction.editReply({ content: 'Message not found.' });
        if (message.author?.id !== client.user.id) return interaction.editReply({ content: 'I can only edit embeds that I sent.' });
        if (!message.embeds || message.embeds.length === 0) return interaction.editReply({ content: 'Message has no embeds to edit.' });

        const newTitle = (interaction.fields.getTextInputValue('edit_title') || '').trim();
        const newDescription = (interaction.fields.getTextInputValue('edit_description') || '').trim();

        const images = [];
        for (let i = 1; i <= MAX_IMAGES; i++) {
          try {
            const v = (interaction.fields.getTextInputValue(`edit_image_${i}`) || '').trim();
            if (v && looksLikeUrl(v)) images.push(v);
          } catch (e) { }
        }

        const newEmbeds = [];
        const mainImage = images.length >= 1 ? images[0] : null;
        newEmbeds.push(buildEmbed({ title: newTitle, description: newDescription, imageUrl: mainImage }));

        if (images.length > 1) {
          for (let i = 1; i < images.length; i++) {
            const e = new EmbedBuilder().setColor(EMBED_COLOR).setImage(images[i]).setFooter({ text: FOOTER_TEXT && FOOTER_TEXT.trim() ? FOOTER_TEXT : DEFAULT_FOOTER_TEXT, iconURL: FOOTER_ICON_URL || null });
            newEmbeds.push(e);
          }
        }

        try {
          await message.edit({ embeds: newEmbeds });
          return interaction.editReply({ content: '✅ Embed edited successfully.' });
        } catch (err) {
          logError('Failed to edit message embed', err);
          return interaction.editReply({ content: '❌ Failed to edit embed. Check permissions and message state.' });
        }
      }

      if (id.startsWith('embedModal:')) {
        const channelId = id.split(':')[1];
        const title = (interaction.fields.getTextInputValue('embed_title') || '').trim();
        const description = (interaction.fields.getTextInputValue('embed_description') || '').replace(/\\n/g, '\n') || '';
        const images = [];
        for (let i = 1; i <= MAX_IMAGES; i++) {
          try {
            const v = (interaction.fields.getTextInputValue(`embed_image_${i}`) || '').trim();
            if (v && looksLikeUrl(v)) images.push(v);
          } catch (e) {}
        }

        const targetChannel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
          return interaction.reply({ content: 'Target channel not found or not a text channel.', flags: 64 });
        }

        await interaction.deferReply({ flags: 64 });

        try {
          const embedsToSend = [];
          if (images.length === 0) embedsToSend.push(buildEmbed({ title, description, imageUrl: null }));
          else if (images.length === 1) embedsToSend.push(buildEmbed({ title, description, imageUrl: images[0] }));
          else {
            embedsToSend.push(buildEmbed({ title, description, imageUrl: null }));
            for (const img of images) {
              const imageOnlyEmbed = new EmbedBuilder().setColor(EMBED_COLOR).setImage(img).setFooter({ text: FOOTER_TEXT && FOOTER_TEXT.trim() ? FOOTER_TEXT : DEFAULT_FOOTER_TEXT, iconURL: FOOTER_ICON_URL || null });
              embedsToSend.push(imageOnlyEmbed);
            }
          }

          const chunkSize = 10;
          for (let i = 0; i < embedsToSend.length; i += chunkSize) {
            const chunk = embedsToSend.slice(i, i + chunkSize);
            await targetChannel.send({ embeds: chunk, allowedMentions: { parse: [] } });
          }

          logInfo(`Embed(s) sent to #${targetChannel.name} (${targetChannel.id}) by ${interaction.user.tag}`);
          return interaction.editReply({ content: `Embed posted to ${targetChannel}.` });
        } catch (err) {
          logError('Failed to send embed(s)', err);
          return interaction.editReply({ content: 'Failed to send embed(s).' });
        }
      }

      if (id === 'updatesModal') {
        const description = interaction.fields.getTextInputValue('updates_description') || '';
        const imageUrl = (interaction.fields.getTextInputValue('updates_image') || '').trim();
        if (UPDATES_IDS.length === 0) {
          return interaction.reply({ content: 'UPDATES_CHANNEL_IDS is not configured in .env.', flags: 64 });
        }
        await interaction.deferReply({ flags: 64 });
        const embed = buildEmbed({ title: '🔔 Updates', description, imageUrl: looksLikeUrl(imageUrl) ? imageUrl : null });
        const cid = UPDATES_IDS[0];
        try {
          const channel = interaction.guild.channels.cache.get(cid) || await interaction.guild.channels.fetch(cid).catch(() => null);
          if (!channel || channel.type !== ChannelType.GuildText) {
            logError(`Invalid or non-text channel: ${cid}`);
            return interaction.editReply({ content: 'Configured updates channel not found.' });
          }
          await channel.send({ content: '@everyone', embeds: [embed], allowedMentions: { parse: ['everyone'] } });
          return interaction.editReply({ content: `Update posted to ${channel}.` });
        } catch (err) {
          logError('Failed to send update', err);
          return interaction.editReply({ content: 'Failed to send update.' });
        }
      }

      if (id === 'invoice_modal') {
        const invoiceId = (interaction.fields.getTextInputValue('invoice_id') || '').trim();
        if (!invoiceId) {
          return interaction.reply({ content: '❌ Invoice ID is required.', flags: 64 });
        }

        await interaction.deferReply({ flags: 64 });

        db.get(`SELECT discord_id, status FROM verifications WHERE invoice_id = ?`, [invoiceId], async (err, row) => {
          if (err) {
            logError('DB error checking invoice reuse', err);
            return interaction.editReply({ content: '❌ Internal error while checking invoice. Try again later.' });
          }
          if (row) {
            return interaction.editReply({ content: `❌ Invoice ID ${invoiceId} is already used by another discord account.` });
          }

          try {
            const url = `https://sell.app/api/v2/invoices/${encodeURIComponent(invoiceId)}`;
            const resp = await axios.get(url, { headers: { Authorization: `Bearer ${SELLAPP_API_KEY}` }, timeout: 10000 });
            const invoice = resp.data?.data ?? resp.data ?? null;

            console.log('DEBUG: full invoice object for', invoiceId, '\n', JSON.stringify(invoice, null, 2));

            if (!invoice) return interaction.editReply({ content: '❌ Invoice not found or invalid response from Sell.app.' });

            let currentStatus = extractInvoiceStatus(invoice);
            if (currentStatus) currentStatus = String(currentStatus).toUpperCase();
            logInfo(`Invoice ${invoiceId} status extracted: ${currentStatus}`);

            const validStatuses = ['PAID', 'COMPLETED', 'FULFILLED', 'SUCCESS'];
            if (!currentStatus || !validStatuses.includes(currentStatus)) {
              return interaction.editReply({ content: `❌ Invoice status is ${currentStatus || 'UNKNOWN'}. Not eligible.` });
            }

            let productId = null;
            if (invoice.product_id) productId = String(invoice.product_id);
            else if (invoice.items && Array.isArray(invoice.items) && invoice.items.length > 0) {
              const it = invoice.items[0];
              productId = it.product_id || it.id || it.sku || null;
            }

            function assignRoleAndPersist(roleIdToUse) {
              const roleIdStr = String(roleIdToUse);
              db.run(
                `INSERT INTO verifications (invoice_id, discord_id, product_id, role_id, status) VALUES (?, ?, ?, ?, ?)`,
                [invoiceId, String(interaction.user.id), productId, roleIdStr, currentStatus],
                async function (dbErr) {
                  if (dbErr) {
                    if (dbErr.code === 'SQLITE_CONSTRAINT') {
                      return interaction.editReply({ content: `❌ Invoice ID ${invoiceId} was just used by another account.` });
                    }
                    logError('DB insert error for verification', dbErr);
                    return interaction.editReply({ content: '❌ Internal error while saving verification.' });
                  }

                  try {
                    const guild = interaction.guild;
                    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
                    if (!member) return interaction.editReply({ content: '✅ Invoice verified but could not find your guild member to assign role. Contact staff.' });

                    const me = guild.members.me;
                    if (!me || !me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
                      return interaction.editReply({ content: '✅ Invoice verified but bot lacks Manage Roles to assign role. Contact staff.' });
                    }

                    const role = guild.roles.cache.get(roleIdStr) || await guild.roles.fetch(roleIdStr).catch(() => null);
                    if (!role) return interaction.editReply({ content: '✅ Invoice verified but configured role not found in this server. Contact staff.' });

                    if (me.roles.highest.position <= role.position) {
                      return interaction.editReply({ content: '✅ Invoice verified but bot role is not high enough to assign the verification role. Contact staff.' });
                    }

                    await member.roles.add(role, `Verified invoice ${invoiceId}`);
                    return interaction.editReply({ content: `✅ Invoice verified! Status: ${currentStatus}. Role <@&${roleIdStr}> assigned.` });
                  } catch (assignErr) {
                    logError('Failed to assign role after verification', assignErr);
                    return interaction.editReply({ content: '✅ Invoice verified but failed to assign role. Contact staff.' });
                  }
                }
              );
            }

            if (productId) {
              db.get(`SELECT role_id FROM role_mappings WHERE product_id = ?`, [productId], (mapErr, mapRow) => {
                if (mapErr) {
                  logError('DB error fetching role mapping', mapErr);
                  if (VERIFY_ROLE_ID) assignRoleAndPersist(VERIFY_ROLE_ID);
                  else return interaction.editReply({ content: '✅ Invoice verified but no role mapping and no VERIFY_ROLE_ID configured.' });
                  return;
                }
                if (mapRow && mapRow.role_id) assignRoleAndPersist(mapRow.role_id);
                else if (VERIFY_ROLE_ID) assignRoleAndPersist(VERIFY_ROLE_ID);
                else return interaction.editReply({ content: '✅ Invoice verified but no role mapping found and VERIFY_ROLE_ID not configured.' });
              });
            } else {
              if (VERIFY_ROLE_ID) assignRoleAndPersist(VERIFY_ROLE_ID);
              else return interaction.editReply({ content: '✅ Invoice verified but no product info and VERIFY_ROLE_ID not configured.' });
            }
          } catch (apiErr) {
            if (apiErr.response) {
              logError('Sell.app API error', apiErr.response.status, apiErr.response.data);
              if (apiErr.response.status === 401) return interaction.editReply({ content: '❌ Sell.app API unauthorized (invalid API key).' });
              if (apiErr.response.status === 404) return interaction.editReply({ content: '❌ Invoice not found.' });
            } else {
              logError('Sell.app request failed', apiErr.message);
            }
            return interaction.editReply({ content: '❌ Could not verify invoice. Please try again later.' });
          }
        });
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'verify_invoice_button') {
        const now = Date.now();
        const last = buttonCooldown.get(interaction.user.id) || 0;
        const diff = now - last;
        if (diff < BUTTON_COOLDOWN_MS) {
          const wait = Math.ceil((BUTTON_COOLDOWN_MS - diff) / 1000);
          return interaction.reply({ content: `Please wait ${wait}s before trying again.`, flags: 64 });
        }
        buttonCooldown.set(interaction.user.id, now);

        const modal = new ModalBuilder()
          .setCustomId('invoice_modal')
          .setTitle('Verify Invoice');

        const invoiceInput = new TextInputBuilder()
          .setCustomId('invoice_id')
          .setLabel('Invoice ID')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('e.g., 2711846');

        const row = new ActionRowBuilder().addComponents(invoiceInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
      }
    }
  } catch (err) {
    logError('Interaction error', err);
    try {
      if (interaction && (interaction.deferred || interaction.replied)) {
        await interaction.followUp({ content: 'Something went wrong while processing your action.', flags: 64 }).catch(() => {});
      } else if (interaction) {
        await interaction.reply({ content: 'Something went wrong while processing your action.', flags: 64 }).catch(() => {});
      }
    } catch (e) { }
  }
});

client.login(DISCORD_TOKEN);
