/**
 * index.js
 *
 * Final full bot code (updated per your requests)
 * - Edit command modal: Title, Description, Image1, Image2, Image3 (all optional).
 *   After editing, the embed description is appended with:
 *     -# Edit By {displayname} | <t:TIMESTAMP:f>
 *   where TIMESTAMP is the edit time.
 * - Moderation commands implemented: purge, timeout, untimeout, ban, unban.
 * - All slash commands are hidden from non-admins (default_member_permissions = Administrator).
 * - Sell.app verification logic is left untouched (no changes to its behavior or DB logic).
 * - Footers removed entirely; appended small lines are added to descriptions instead.
 * - /updates uses title 🧊𝐔𝐩𝐝𝐚𝐭𝐞𝐬🧊 and supports two optional images.
 * - /embed_simple added (one image + thumbnail).
 * - Stability improvements: cooldown pruning, graceful DB close, defensive checks.
 *
 * Make sure to set environment variables in a .env file:
 * DISCORD_TOKEN, CLIENT_ID, SELLAPP_API_KEY, UPDATES_CHANNEL_IDS, VERIFY_ROLE_ID, SQLITE_PATH (optional), etc.
 */

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

const EMBED_COLOR = 0x3336fc; // unified embed color
const MAX_IMAGES = 3;
const MODAL_MAX_COMPONENTS = 5;
const BUTTON_COOLDOWN_MS = 15_000;
const buttonCooldown = new Map();

// Periodically prune old cooldown entries to avoid memory growth
const COOLDOWN_PRUNE_INTERVAL_MS = 60_000; // every minute
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buttonCooldown.entries()) {
    if (now - v > BUTTON_COOLDOWN_MS * 5) buttonCooldown.delete(k);
  }
}, COOLDOWN_PRUNE_INTERVAL_MS);

function logInfo(msg) {
  console.log(`[INFO] ${msg}`);
}

function logError(msg, err) {
  console.error(`[ERROR] ${msg}`, err || '');
}

function parseChannelIds(csv) {
  if (!csv || !csv.trim()) return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{17,20}$/.test(s));
}

const UPDATES_IDS = parseChannelIds(UPDATES_CHANNEL_IDS);

function resolveActivityType(mode) {
  switch ((mode || '').toLowerCase()) {
    case 'streaming':
      return ActivityType.Streaming;
    case 'playing':
      return ActivityType.Playing;
    case 'watching':
      return ActivityType.Watching;
    case 'listening':
      return ActivityType.Listening;
    case 'competing':
      return ActivityType.Competing;
    default:
      return ActivityType.Watching;
  }
}

function resolveStatus(status) {
  switch ((status || '').toLowerCase()) {
    case 'online':
    case 'idle':
    case 'dnd':
    case 'invisible':
      return status.toLowerCase();
    default:
      return 'online';
  }
}

function sessionPrefix(style) {
  const s = (style || '').toLowerCase();
  if (s === 'mobile') return '📱';
  if (s === 'desktop') return '🖥️';
  return '';
}

function looksLikeUrl(s) {
  if (!s) return false;
  const t = s.trim();
  return /^https?:\/\/\S+\.\S+/.test(t);
}

/**
 * buildEmbed
 * - title, description, imageUrl, thumbnailUrl
 * - authorDisplayName: used for Submitted By or Edit By lines
 * - mode:
 *    - 'submit' (default) -> append Submitted By line
 *    - 'updates' -> append All rights reserved line
 *    - 'edit' -> append Edit By line (uses provided timestamp)
 * - timestamp: unix seconds (optional). If not provided, uses current time.
 *
 * Note: This function does NOT set any footer (per request).
 */
function buildEmbed({ title, description, imageUrl, thumbnailUrl, authorDisplayName, mode = 'submit', timestamp = null }) {
  const embed = new EmbedBuilder().setColor(EMBED_COLOR);

  if (title && title.trim()) embed.setTitle(title.trim());
  if (description && description.trim()) embed.setDescription(description.trim());
  if (imageUrl && imageUrl.trim()) embed.setImage(imageUrl.trim());
  if (thumbnailUrl && thumbnailUrl.trim()) embed.setThumbnail(thumbnailUrl.trim());

  const ts = timestamp ? Math.floor(timestamp) : Math.floor(Date.now() / 1000);

  if (mode === 'updates') {
    const rightsLine = `\n\n-# All rights reserved by ICE | <t:${ts}:F>`;
    const existing = embed.data.description || '';
    embed.setDescription(`${existing}${rightsLine}`);
  } else if (mode === 'edit') {
    const display = authorDisplayName || 'Unknown';
    const editLine = `\n\n-# Edit By ${display} | <t:${ts}:f>`;
    const existing = embed.data.description || '';
    embed.setDescription(`${existing}${editLine}`);
  } else {
    // submit
    const display = authorDisplayName || 'Unknown';
    const submitLine = `\n\n-# Submitted By ${display} | <t:${ts}:f>`;
    const existing = embed.data.description || '';
    embed.setDescription(`${existing}${submitLine}`);
  }

  return embed;
}

// SQLite setup
const DB_PATH =
  SQLITE_PATH && SQLITE_PATH.trim()
    ? SQLITE_PATH.trim()
    : path.join(__dirname, 'data', 'bot.sqlite');

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Failed to open SQLite DB:', err);
    process.exit(1);
  }
  logInfo(`SQLite DB opened at ${DB_PATH}`);
});

db.serialize(() => {
  db.run(
    `
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
  `
  );

  db.run(
    `
    CREATE TABLE IF NOT EXISTS role_mappings (
      product_id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL
    )
  `
  );
});

// Helper to safely close DB on exit
function gracefulShutdown() {
  try {
    logInfo('Shutting down, closing DB...');
    db.close((err) => {
      if (err) logError('Error closing DB', err);
      else logInfo('DB closed.');
      process.exit(0);
    });
  } catch (e) {
    process.exit(0);
  }
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Extract invoice status helper (unchanged logic; kept intact)
function extractInvoiceStatus(invoice) {
  if (!invoice) return null;

  if (typeof invoice.status === 'string' && invoice.status.trim())
    return invoice.status.trim();

  if (invoice.status && typeof invoice.status === 'object') {
    const s = invoice.status;

    if (typeof s.status === 'string' && s.status.trim()) return s.status.trim();

    if (
      s.status &&
      typeof s.status === 'object' &&
      typeof s.status.status === 'string' &&
      s.status.status.trim()
    ) {
      return s.status.status.trim();
    }

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
    if (
      invoice[k] &&
      typeof invoice[k] === 'object' &&
      typeof invoice[k].status === 'string' &&
      invoice[k].status.trim()
    ) {
      return invoice[k].status.trim();
    }
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

// --------------------
// Slash commands setup
// All commands are registered with default_member_permissions = Administrator and DM disabled
// --------------------

const baseAdminPerm = PermissionsBitField.Flags.Administrator;

const updatesCommand = new SlashCommandBuilder()
  .setName('updates')
  .setDescription('Post an update (modal, sends to configured UPDATES channel).')
  .setDefaultMemberPermissions(baseAdminPerm)
  .setDMPermission(false);

const embedCommand = new SlashCommandBuilder()
  .setName('embed')
  .setDescription('Send a custom embed via modal to a chosen channel.')
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Channel to send the embed to')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true)
  )
  .setDefaultMemberPermissions(baseAdminPerm)
  .setDMPermission(false);

const embedSimpleCommand = new SlashCommandBuilder()
  .setName('embed_simple')
  .setDescription('Create a simple embed (one image + thumbnail) via modal.')
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Channel to send the embed to')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true)
  )
  .setDefaultMemberPermissions(baseAdminPerm)
  .setDMPermission(false);

const editembedCommand = new SlashCommandBuilder()
  .setName('editembed')
  .setDescription('Edit an existing bot embed message (admin only).')
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Channel containing the message')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName('message_id').setDescription('Message ID to edit').setRequired(true)
  )
  .setDefaultMemberPermissions(baseAdminPerm)
  .setDMPermission(false);

const verifyEmbCommand = new SlashCommandBuilder()
  .setName('verifyemb')
  .setDescription('Send the invoice verification embed to this channel (Admin only)')
  .setDefaultMemberPermissions(baseAdminPerm)
  .setDMPermission(false);

const purgeCommand = new SlashCommandBuilder()
  .setName('purge')
  .setDescription('Delete messages in bulk (admin only).')
  .addIntegerOption((opt) =>
    opt
      .setName('count')
      .setDescription('Number of messages to delete (1-100)')
      .setRequired(true)
  )
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Channel to purge (defaults to current)')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false)
  )
  .setDefaultMemberPermissions(baseAdminPerm)
  .setDMPermission(false);

const timeoutCommand = new SlashCommandBuilder()
  .setName('timeout')
  .setDescription('Timeout a user for a duration in minutes (admin only).')
  .addUserOption((opt) =>
    opt.setName('user').setDescription('User to timeout').setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt
      .setName('minutes')
      .setDescription('Duration in minutes (1-40320)')
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName('reason').setDescription('Reason for timeout').setRequired(false)
  )
  .setDefaultMemberPermissions(baseAdminPerm)
  .setDMPermission(false);

const untimeoutCommand = new SlashCommandBuilder()
  .setName('untimeout')
  .setDescription('Remove timeout from a user (admin only).')
  .addUserOption((opt) =>
    opt.setName('user').setDescription('User to remove timeout').setRequired(true)
  )
  .setDefaultMemberPermissions(baseAdminPerm)
  .setDMPermission(false);

const banCommand = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban a user (admin only).')
  .addUserOption((opt) =>
    opt.setName('user').setDescription('User to ban').setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName('reason').setDescription('Reason for ban').setRequired(false)
  )
  .addIntegerOption((opt) =>
    opt
      .setName('delete_days')
      .setDescription('Delete message history in days (0-7)')
      .setRequired(false)
  )
  .setDefaultMemberPermissions(baseAdminPerm)
  .setDMPermission(false);

const unbanCommand = new SlashCommandBuilder()
  .setName('unban')
  .setDescription('Unban a user by ID (admin only).')
  .addStringOption((opt) =>
    opt.setName('user_id').setDescription('User ID to unban').setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName('reason').setDescription('Reason for unban').setRequired(false)
  )
  .setDefaultMemberPermissions(baseAdminPerm)
  .setDMPermission(false);

const commands = [
  updatesCommand,
  embedCommand,
  embedSimpleCommand,
  editembedCommand,
  purgeCommand,
  timeoutCommand,
  untimeoutCommand,
  banCommand,
  unbanCommand,
  verifyEmbCommand,
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    logInfo('Registering global commands (hidden from non-admins)...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    logInfo('Global commands registered.');
  } catch (err) {
    logError('Failed to register commands', err);
  }
})();

// --------------------
// Client events & interactions
// --------------------

client.once(Events.ClientReady, () => {
  logInfo(`Logged in as ${client.user.tag}`);

  try {
    const type = resolveActivityType(ACTIVITY_MODE);
    const status = resolveStatus(STATUS);
    const prefix = sessionPrefix(SESSION_STYLE);

    const nameBase =
      ACTIVITY_NAME && ACTIVITY_NAME.trim() ? ACTIVITY_NAME.trim() : 'ICE R6S';

    const activity = {
      name: prefix ? `${prefix} ${nameBase}` : nameBase,
      type,
    };

    if (type === ActivityType.Streaming && STREAM_URL && STREAM_URL.trim()) {
      activity.url = STREAM_URL.trim();
    }

    client.user.setPresence({
      status,
      activities: [activity],
    });
  } catch (e) {
    // ignore presence errors
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      // /editembed
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
        if (!message)
          return interaction.reply({ content: 'Message not found.', flags: 64 });

        if (message.author?.id !== client.user.id)
          return interaction.reply({
            content: 'I can only edit embeds that I sent.',
            flags: 64,
          });

        // Build modal with only Title, Description, image1, image2, image3 (all optional)
        const modal = new ModalBuilder()
          .setCustomId(`editembedModal:${channel.id}:${message.id}`)
          .setTitle('Edit Embed (Title, Description, Image1-3)');

        const titleInput = new TextInputBuilder()
          .setCustomId('edit_title')
          .setLabel('Title (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        const descriptionInput = new TextInputBuilder()
          .setCustomId('edit_description')
          .setLabel('Description (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false);

        const img1 = new TextInputBuilder()
          .setCustomId('edit_image_1')
          .setLabel('Image URL 1 (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('https://...');

        const img2 = new TextInputBuilder()
          .setCustomId('edit_image_2')
          .setLabel('Image URL 2 (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('https://...');

        const img3 = new TextInputBuilder()
          .setCustomId('edit_image_3')
          .setLabel('Image URL 3 (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('https://...');

        const rows = [
          new ActionRowBuilder().addComponents(titleInput),
          new ActionRowBuilder().addComponents(descriptionInput),
          new ActionRowBuilder().addComponents(img1),
          new ActionRowBuilder().addComponents(img2),
          new ActionRowBuilder().addComponents(img3),
        ];

        modal.addComponents(...rows.slice(0, MODAL_MAX_COMPONENTS));
        await interaction.showModal(modal);
        return;
      }

      // /verifyemb (DO NOT TOUCH logic; keep text same; color unified)
      if (commandName === 'verifyemb') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'Admin permissions required.', flags: 64 });
        }

        const descriptionText = [
          'Click the button below to verify your Sell.app invoice and receive your role.',
          '',
          'How it works: Click Verify → enter your invoice ID → if paid you will receive the role.',
          '',
          'Privacy: Invoice IDs are stored securely for verification and reassigning roles on rejoin.',
        ].join('\n');

        const embed = new EmbedBuilder()
          .setTitle('🔒 Invoice Verification')
          .setDescription(descriptionText)
          .setColor(EMBED_COLOR);

        const button = new ButtonBuilder()
          .setCustomId('verify_invoice_button')
          .setLabel('Verify Invoice')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🔎');

        const row = new ActionRowBuilder().addComponents(button);

        try {
          await interaction.channel.send({ embeds: [embed], components: [row] });
          await interaction.reply({
            content: '✅ Verification embed sent to this channel.',
            flags: 64,
          });
        } catch (err) {
          logError('Failed to send verification embed', err);
          await interaction.reply({
            content: '❌ Failed to send verification embed. Check bot permissions.',
            flags: 64,
          });
        }

        return;
      }

      // /updates (improved: 2 optional images; special title)
      if (commandName === 'updates') {
        if (UPDATES_IDS.length === 0) {
          await interaction.reply({
            content: 'UPDATES_CHANNEL_IDS is not configured in .env.',
            flags: 64,
          });
          return;
        }

        const modal = new ModalBuilder().setCustomId('updatesModal').setTitle('🔔 Updates');

        const descriptionInput = new TextInputBuilder()
          .setCustomId('updates_description')
          .setLabel('Update content')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder('Type your updates here.');

        const image1Input = new TextInputBuilder()
          .setCustomId('updates_image_1')
          .setLabel('Image URL 1 (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('https://...');

        const image2Input = new TextInputBuilder()
          .setCustomId('updates_image_2')
          .setLabel('Image URL 2 (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('https://...');

        modal.addComponents(
          new ActionRowBuilder().addComponents(descriptionInput),
          new ActionRowBuilder().addComponents(image1Input),
          new ActionRowBuilder().addComponents(image2Input)
        );

        await interaction.showModal(modal);
        return;
      }

      // /embed (original multi-image modal)
      if (commandName === 'embed') {
        const targetChannel = interaction.options.getChannel('channel', true);

        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
          await interaction.reply({
            content: 'Please choose a text channel.',
            flags: 64,
          });
          return;
        }

        const remainingSlots = MODAL_MAX_COMPONENTS - 2;
        const imageInputsToShow = Math.min(remainingSlots, MAX_IMAGES);

        const modal = new ModalBuilder()
          .setCustomId(`embedModal:${targetChannel.id}`)
          .setTitle('Create Embed');

        const titleInput = new TextInputBuilder()
          .setCustomId('embed_title')
          .setLabel('Title (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        const descriptionInput = new TextInputBuilder()
          .setCustomId('embed_description')
          .setLabel('Description (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false);

        const rows = [
          new ActionRowBuilder().addComponents(titleInput),
          new ActionRowBuilder().addComponents(descriptionInput),
        ];

        for (let i = 1; i <= imageInputsToShow; i++) {
          const img = new TextInputBuilder()
            .setCustomId(`embed_image_${i}`)
            .setLabel(`Image URL ${i} (optional)`)
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

          rows.push(new ActionRowBuilder().addComponents(img));
        }

        modal.addComponents(...rows.slice(0, MODAL_MAX_COMPONENTS));
        await interaction.showModal(modal);
        return;
      }

      // /embed_simple (new: one image + thumbnail)
      if (commandName === 'embed_simple') {
        const targetChannel = interaction.options.getChannel('channel', true);

        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
          await interaction.reply({
            content: 'Please choose a text channel.',
            flags: 64,
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(`embedSimpleModal:${targetChannel.id}`)
          .setTitle('Create Simple Embed');

        const titleInput = new TextInputBuilder()
          .setCustomId('simple_title')
          .setLabel('Title (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);

        const descriptionInput = new TextInputBuilder()
          .setCustomId('simple_description')
          .setLabel('Description (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false);

        const imageInput = new TextInputBuilder()
          .setCustomId('simple_image')
          .setLabel('Image URL (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('https://...');

        const thumbInput = new TextInputBuilder()
          .setCustomId('simple_thumbnail')
          .setLabel('Thumbnail URL (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('https://...');

        modal.addComponents(
          new ActionRowBuilder().addComponents(titleInput),
          new ActionRowBuilder().addComponents(descriptionInput),
          new ActionRowBuilder().addComponents(imageInput),
          new ActionRowBuilder().addComponents(thumbInput)
        );

        await interaction.showModal(modal);
        return;
      }

      // /purge implementation
      if (commandName === 'purge') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'Admin permissions required.', flags: 64 });
        }

        const count = interaction.options.getInteger('count', true);
        const channelOption = interaction.options.getChannel('channel', false);
        const targetChannel = channelOption && channelOption.type === ChannelType.GuildText ? channelOption : interaction.channel;

        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
          return interaction.reply({ content: 'Invalid target channel.', flags: 64 });
        }

        if (count < 1 || count > 100) {
          return interaction.reply({ content: 'Count must be between 1 and 100.', flags: 64 });
        }

        await interaction.deferReply({ flags: 64 });

        try {
          // fetch messages and bulk delete
          const fetched = await targetChannel.messages.fetch({ limit: count }).catch(() => null);
          if (!fetched || fetched.size === 0) {
            return interaction.editReply({ content: 'No messages found to delete.' });
          }

          await targetChannel.bulkDelete(fetched, true).catch(async (err) => {
            // fallback: delete individually if bulkDelete fails for older messages
            logError('bulkDelete failed, attempting individual deletes', err);
            for (const msg of fetched.values()) {
              try {
                await msg.delete().catch(() => {});
              } catch (e) {
                // ignore
              }
            }
          });

          return interaction.editReply({ content: `✅ Deleted up to ${fetched.size} messages from ${targetChannel}.` });
        } catch (err) {
          logError('Purge failed', err);
          return interaction.editReply({ content: '❌ Failed to purge messages.' });
        }
      }

      // /timeout implementation
      if (commandName === 'timeout') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'Admin permissions required.', flags: 64 });
        }

        const user = interaction.options.getUser('user', true);
        const minutes = interaction.options.getInteger('minutes', true);
        const reason = interaction.options.getString('reason', false) || 'No reason provided';

        if (minutes < 1 || minutes > 40320) {
          return interaction.reply({ content: 'Minutes must be between 1 and 40320.', flags: 64 });
        }

        await interaction.deferReply({ flags: 64 });

        try {
          const guild = interaction.guild;
          const member = await guild.members.fetch(user.id).catch(() => null);
          if (!member) return interaction.editReply({ content: 'User not found in this guild.' });

          const durationMs = minutes * 60 * 1000;
          await member.timeout(durationMs, reason).catch((err) => { throw err; });

          return interaction.editReply({ content: `✅ ${user.tag} has been timed out for ${minutes} minute(s).` });
        } catch (err) {
          logError('Timeout failed', err);
          return interaction.editReply({ content: '❌ Failed to timeout user. Ensure I have Manage Members permission and role hierarchy.' });
        }
      }

      // /untimeout implementation
      if (commandName === 'untimeout') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'Admin permissions required.', flags: 64 });
        }

        const user = interaction.options.getUser('user', true);
        await interaction.deferReply({ flags: 64 });

        try {
          const guild = interaction.guild;
          const member = await guild.members.fetch(user.id).catch(() => null);
          if (!member) return interaction.editReply({ content: 'User not found in this guild.' });

          await member.timeout(null).catch((err) => { throw err; });

          return interaction.editReply({ content: `✅ Timeout removed for ${user.tag}.` });
        } catch (err) {
          logError('UnTimeout failed', err);
          return interaction.editReply({ content: '❌ Failed to remove timeout. Ensure I have Manage Members permission and role hierarchy.' });
        }
      }

      // /ban implementation
      if (commandName === 'ban') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'Admin permissions required.', flags: 64 });
        }

        const user = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason', false) || 'No reason provided';
        const deleteDays = interaction.options.getInteger('delete_days', false) || 0;

        if (deleteDays < 0 || deleteDays > 7) {
          return interaction.reply({ content: 'delete_days must be between 0 and 7.', flags: 64 });
        }

        await interaction.deferReply({ flags: 64 });

        try {
          const guild = interaction.guild;
          await guild.bans.create(user.id, { days: deleteDays, reason }).catch((err) => { throw err; });

          return interaction.editReply({ content: `✅ ${user.tag} has been banned. Reason: ${reason}` });
        } catch (err) {
          logError('Ban failed', err);
          return interaction.editReply({ content: '❌ Failed to ban user. Ensure I have Ban Members permission and role hierarchy.' });
        }
      }

      // /unban implementation
      if (commandName === 'unban') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'Admin permissions required.', flags: 64 });
        }

        const userId = interaction.options.getString('user_id', true);
        const reason = interaction.options.getString('reason', false) || 'No reason provided';

        await interaction.deferReply({ flags: 64 });

        try {
          const guild = interaction.guild;
          await guild.bans.remove(userId, reason).catch((err) => { throw err; });

          return interaction.editReply({ content: `✅ User ID ${userId} has been unbanned. Reason: ${reason}` });
        } catch (err) {
          logError('Unban failed', err);
          return interaction.editReply({ content: '❌ Failed to unban user. Ensure the ID is correct and I have Ban Members permission.' });
        }
      }

      // Other commands handled above...
    }

    // Handle modals
    if (interaction.isModalSubmit()) {
      const id = interaction.customId;

      // editembedModal (now only Title, Description, image1-3)
      if (id.startsWith('editembedModal:')) {
        const parts = id.split(':');
        const channelId = parts[1];
        const messageId = parts[2];

        await interaction.deferReply({ flags: 64 });

        const channel =
          interaction.guild.channels.cache.get(channelId) ||
          (await interaction.guild.channels.fetch(channelId).catch(() => null));

        if (!channel || channel.type !== ChannelType.GuildText) {
          return interaction.editReply({
            content: 'Target channel not found or not a text channel.',
          });
        }

        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message)
          return interaction.editReply({
            content: 'Message not found.',
          });

        if (message.author?.id !== client.user.id)
          return interaction.editReply({
            content: 'I can only edit embeds that I sent.',
          });

        if (!message.embeds || message.embeds.length === 0)
          return interaction.editReply({
            content: 'Message has no embeds to edit.',
          });

        const newTitle = (interaction.fields.getTextInputValue('edit_title') || '').trim();
        const newDescription = (interaction.fields.getTextInputValue('edit_description') || '').trim();

        const images = [];
        for (let i = 1; i <= 3; i++) {
          try {
            const v = (interaction.fields.getTextInputValue(`edit_image_${i}`) || '').trim();
            if (v && looksLikeUrl(v)) images.push(v);
          } catch (e) {
            // ignore
          }
        }

        // Build new embeds:
        // If no images: single embed with title+description + Edit By line
        // If images: first embed contains title+description+Edit By line, then up to 3 image-only embeds
        const authorDisplayName = (interaction.member && interaction.member.displayName) || interaction.user.username;
        const editTs = Math.floor(Date.now() / 1000);

        const newEmbeds = [];

        // Primary embed (title + description + Edit By)
        newEmbeds.push(
          buildEmbed({
            title: newTitle,
            description: newDescription,
            imageUrl: null,
            thumbnailUrl: null,
            authorDisplayName,
            mode: 'edit',
            timestamp: editTs,
          })
        );

        // Additional image-only embeds (if any)
        for (const img of images) {
          const e = new EmbedBuilder().setColor(EMBED_COLOR).setImage(img);
          newEmbeds.push(e);
        }

        try {
          await message.edit({ embeds: newEmbeds });
          return interaction.editReply({
            content: '✅ Embed edited successfully.',
          });
        } catch (err) {
          logError('Failed to edit message embed', err);
          return interaction.editReply({
            content: '❌ Failed to edit embed. Check permissions and message state.',
          });
        }
      }

      // embedModal (original multi-image)
      if (id.startsWith('embedModal:')) {
        const channelId = id.split(':')[1];

        const title = (interaction.fields.getTextInputValue('embed_title') || '').trim();
        const description =
          (interaction.fields.getTextInputValue('embed_description') || '')
            .replace(/\\n/g, '\n') || '';

        const images = [];
        for (let i = 1; i <= MAX_IMAGES; i++) {
          try {
            const v =
              (interaction.fields.getTextInputValue(`embed_image_${i}`) || '').trim();
            if (v && looksLikeUrl(v)) images.push(v);
          } catch (e) {
            // ignore
          }
        }

        const targetChannel =
          interaction.guild.channels.cache.get(channelId) ||
          (await interaction.guild.channels.fetch(channelId).catch(() => null));

        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
          return interaction.reply({
            content: 'Target channel not found or not a text channel.',
            flags: 64,
          });
        }

        await interaction.deferReply({ flags: 64 });

        try {
          const embedsToSend = [];
          const authorDisplayName = (interaction.member && interaction.member.displayName) || interaction.user.username;

          if (images.length === 0) {
            embedsToSend.push(
              buildEmbed({
                title,
                description,
                imageUrl: null,
                thumbnailUrl: null,
                authorDisplayName,
                mode: 'submit',
              })
            );
          } else if (images.length === 1) {
            embedsToSend.push(
              buildEmbed({
                title,
                description,
                imageUrl: images[0],
                thumbnailUrl: null,
                authorDisplayName,
                mode: 'submit',
              })
            );
          } else {
            // First embed: title + description + appended submitted line
            embedsToSend.push(
              buildEmbed({
                title,
                description,
                imageUrl: null,
                thumbnailUrl: null,
                authorDisplayName,
                mode: 'submit',
              })
            );

            // Additional image-only embeds
            for (const img of images) {
              const imageOnly = new EmbedBuilder().setColor(EMBED_COLOR).setImage(img);
              embedsToSend.push(imageOnly);
            }
          }

          const chunkSize = 10;
          for (let i = 0; i < embedsToSend.length; i += chunkSize) {
            const chunk = embedsToSend.slice(i, i + chunkSize);
            await targetChannel.send({
              embeds: chunk,
              allowedMentions: { parse: [] },
            });
          }

          logInfo(
            `Embed(s) sent to #${targetChannel.name} (${targetChannel.id}) by ${interaction.user.tag}`
          );

          return interaction.editReply({
            content: `Embed posted to ${targetChannel}.`,
          });
        } catch (err) {
          logError('Failed to send embed(s)', err);
          return interaction.editReply({
            content: 'Failed to send embed(s).',
          });
        }
      }

      // embedSimpleModal (new: one image + thumbnail)
      if (id.startsWith('embedSimpleModal:')) {
        const channelId = id.split(':')[1];

        const title = (interaction.fields.getTextInputValue('simple_title') || '').trim();
        const description =
          (interaction.fields.getTextInputValue('simple_description') || '')
            .replace(/\\n/g, '\n') || '';

        const image = (interaction.fields.getTextInputValue('simple_image') || '').trim();
        const thumbnail = (interaction.fields.getTextInputValue('simple_thumbnail') || '').trim();

        const targetChannel =
          interaction.guild.channels.cache.get(channelId) ||
          (await interaction.guild.channels.fetch(channelId).catch(() => null));

        if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
          return interaction.reply({
            content: 'Target channel not found or not a text channel.',
            flags: 64,
          });
        }

        await interaction.deferReply({ flags: 64 });

        try {
          const authorDisplayName = (interaction.member && interaction.member.displayName) || interaction.user.username;

          const embedToSend = buildEmbed({
            title,
            description,
            imageUrl: looksLikeUrl(image) ? image : null,
            thumbnailUrl: looksLikeUrl(thumbnail) ? thumbnail : null,
            authorDisplayName,
            mode: 'submit',
          });

          await targetChannel.send({
            embeds: [embedToSend],
            allowedMentions: { parse: [] },
          });

          logInfo(
            `Simple embed sent to #${targetChannel.name} (${targetChannel.id}) by ${interaction.user.tag}`
          );

          return interaction.editReply({
            content: `Embed posted to ${targetChannel}.`,
          });
        } catch (err) {
          logError('Failed to send simple embed', err);
          return interaction.editReply({
            content: 'Failed to send embed.',
          });
        }
      }

      // updatesModal (improved: 2 optional images; special title 🧊𝐔𝐩𝐝𝐚𝐭𝐞𝐬🧊)
      if (id === 'updatesModal') {
        const description =
          interaction.fields.getTextInputValue('updates_description') || '';
        const image1 =
          (interaction.fields.getTextInputValue('updates_image_1') || '').trim();
        const image2 =
          (interaction.fields.getTextInputValue('updates_image_2') || '').trim();

        if (UPDATES_IDS.length === 0) {
          return interaction.reply({
            content: 'UPDATES_CHANNEL_IDS is not configured in .env.',
            flags: 64,
          });
        }

        await interaction.deferReply({ flags: 64 });

        const authorDisplayName = (interaction.member && interaction.member.displayName) || interaction.user.username;

        // Build primary embed with special title
        const primaryEmbed = buildEmbed({
          title: '🧊𝐔𝐩𝐝𝐚𝐭𝐞𝐬🧊',
          description,
          imageUrl: looksLikeUrl(image1) ? image1 : null,
          thumbnailUrl: looksLikeUrl(image2) ? image2 : null,
          authorDisplayName,
          mode: 'updates',
        });

        const cid = UPDATES_IDS[0];

        try {
          const channel =
            interaction.guild.channels.cache.get(cid) ||
            (await interaction.guild.channels.fetch(cid).catch(() => null));

          if (!channel || channel.type !== ChannelType.GuildText) {
            logError(`Invalid or non-text channel: ${cid}`);
            return interaction.editReply({
              content: 'Configured updates channel not found.',
            });
          }

          await channel.send({
            content: '@everyone',
            embeds: [primaryEmbed],
            allowedMentions: { parse: ['everyone'] },
          });

          return interaction.editReply({
            content: `Update posted to ${channel}.`,
          });
        } catch (err) {
          logError('Failed to send update', err);
          return interaction.editReply({
            content: 'Failed to send update.',
          });
        }
      }

      // invoice_modal (SELL.APP logic left intact; unchanged)
      if (id === 'invoice_modal') {
        const invoiceId =
          (interaction.fields.getTextInputValue('invoice_id') || '').trim();

        if (!invoiceId) {
          return interaction.reply({
            content: '❌ Invoice ID is required.',
            flags: 64,
          });
        }

        await interaction.deferReply({ flags: 64 });

        db.get(
          `SELECT discord_id, status FROM verifications WHERE invoice_id = ?`,
          [invoiceId],
          async (err, row) => {
            if (err) {
              logError('DB error checking invoice reuse', err);
              return interaction.editReply({
                content: '❌ Internal error while checking invoice. Try again later.',
              });
            }

            if (row) {
              return interaction.editReply({
                content: `❌ Invoice ID ${invoiceId} is already used by another discord account.`,
              });
            }

            try {
              const url = `https://sell.app/api/v2/invoices/${encodeURIComponent(
                invoiceId
              )}`;

              const resp = await axios.get(url, {
                headers: { Authorization: `Bearer ${SELLAPP_API_KEY}` },
                timeout: 10000,
              });

              const invoice = resp.data?.data ?? resp.data ?? null;

              console.log(
                'DEBUG: full invoice object for',
                invoiceId,
                '\n',
                JSON.stringify(invoice, null, 2)
              );

              if (!invoice) {
                return interaction.editReply({
                  content:
                    '❌ Invoice not found or invalid response from Sell.app.',
                });
              }

              let currentStatus = extractInvoiceStatus(invoice);
              if (currentStatus) currentStatus = String(currentStatus).toUpperCase();

              logInfo(
                `Invoice ${invoiceId} status extracted: ${currentStatus}`
              );

              const validStatuses = [
                'PAID',
                'COMPLETED',
                'FULFILLED',
                'SUCCESS',
              ];

              if (!currentStatus || !validStatuses.includes(currentStatus)) {
                return interaction.editReply({
                  content: `❌ Invoice status is ${
                    currentStatus || 'UNKNOWN'
                  }. Not eligible.`,
                });
              }

              let productId = null;
              if (invoice.product_id) {
                productId = String(invoice.product_id);
              } else if (
                invoice.items &&
                Array.isArray(invoice.items) &&
                invoice.items.length > 0
              ) {
                const it = invoice.items[0];
                productId = it.product_id || it.id || it.sku || null;
              }

              function assignRoleAndPersist(roleIdToUse) {
                const roleIdStr = String(roleIdToUse);

                db.run(
                  `
                    INSERT INTO verifications
                      (invoice_id, discord_id, product_id, role_id, status)
                    VALUES (?, ?, ?, ?, ?)
                  `,
                  [
                    invoiceId,
                    String(interaction.user.id),
                    productId,
                    roleIdStr,
                    currentStatus,
                  ],
                  async function (dbErr) {
                    if (dbErr) {
                      if (dbErr.code === 'SQLITE_CONSTRAINT') {
                        return interaction.editReply({
                          content: `❌ Invoice ID ${invoiceId} was just used by another account.`,
                        });
                      }

                      logError('DB insert error for verification', dbErr);
                      return interaction.editReply({
                        content: '❌ Internal error while saving verification.',
                      });
                    }

                    try {
                      const guild = interaction.guild;
                      const member = await guild.members
                        .fetch(interaction.user.id)
                        .catch(() => null);

                      if (!member) {
                        return interaction.editReply({
                          content:
                            '✅ Invoice verified but could not find your guild member to assign role. Contact staff.',
                        });
                      }

                      const me = guild.members.me;
                      if (
                        !me ||
                        !me.permissions.has(PermissionsBitField.Flags.ManageRoles)
                      ) {
                        return interaction.editReply({
                          content:
                            '✅ Invoice verified but bot lacks Manage Roles to assign role. Contact staff.',
                        });
                      }

                      const role =
                        guild.roles.cache.get(roleIdStr) ||
                        (await guild.roles.fetch(roleIdStr).catch(() => null));

                      if (!role) {
                        return interaction.editReply({
                          content:
                            '✅ Invoice verified but configured role not found in this server. Contact staff.',
                        });
                      }

                      if (me.roles.highest.position <= role.position) {
                        return interaction.editReply({
                          content:
                            '✅ Invoice verified but bot role is not high enough to assign the verification role. Contact staff.',
                        });
                      }

                      await member.roles.add(
                        role,
                        `Verified invoice ${invoiceId}`
                      );

                      return interaction.editReply({
                        content: `✅ Invoice verified! Status: ${currentStatus}. Role <@&${roleIdStr}> assigned.`,
                      });
                    } catch (assignErr) {
                      logError(
                        'Failed to assign role after verification',
                        assignErr
                      );
                      return interaction.editReply({
                        content:
                          '✅ Invoice verified but failed to assign role. Contact staff.',
                      });
                    }
                  }
                );
              }

              if (productId) {
                db.get(
                  `SELECT role_id FROM role_mappings WHERE product_id = ?`,
                  [productId],
                  (mapErr, mapRow) => {
                    if (mapErr) {
                      logError('DB error fetching role mapping', mapErr);
                      if (VERIFY_ROLE_ID) assignRoleAndPersist(VERIFY_ROLE_ID);
                      else
                        return interaction.editReply({
                          content:
                            '✅ Invoice verified but no role mapping and no VERIFY_ROLE_ID configured.',
                        });
                      return;
                    }

                    if (mapRow && mapRow.role_id) {
                      assignRoleAndPersist(mapRow.role_id);
                    } else if (VERIFY_ROLE_ID) {
                      assignRoleAndPersist(VERIFY_ROLE_ID);
                    } else {
                      return interaction.editReply({
                        content:
                          '✅ Invoice verified but no role mapping found and VERIFY_ROLE_ID not configured.',
                      });
                    }
                  }
                );
              } else {
                if (VERIFY_ROLE_ID) assignRoleAndPersist(VERIFY_ROLE_ID);
                else
                  return interaction.editReply({
                    content:
                      '✅ Invoice verified but no product info and VERIFY_ROLE_ID not configured.',
                  });
              }
            } catch (apiErr) {
              if (apiErr.response) {
                logError(
                  'Sell.app API error',
                  apiErr.response.status,
                  apiErr.response.data
                );

                if (apiErr.response.status === 401) {
                  return interaction.editReply({
                    content: '❌ Sell.app API unauthorized (invalid API key).',
                  });
                }

                if (apiErr.response.status === 404) {
                  return interaction.editReply({
                    content: '❌ Invoice not found.',
                  });
                }
              } else {
                logError('Sell.app request failed', apiErr.message);
              }

              return interaction.editReply({
                content:
                  '❌ Could not verify invoice. Please try again later.',
              });
            }
          }
        );

        return;
      }
    }

    // Buttons
    if (interaction.isButton()) {
      if (interaction.customId === 'verify_invoice_button') {
        const now = Date.now();
        const last = buttonCooldown.get(interaction.user.id) || 0;
        const diff = now - last;

        if (diff < BUTTON_COOLDOWN_MS) {
          const wait = Math.ceil((BUTTON_COOLDOWN_MS - diff) / 1000);
          return interaction.reply({
            content: `Please wait ${wait}s before trying again.`,
            flags: 64,
          });
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
        await interaction
          .followUp({
            content: 'Something went wrong while processing your action.',
            flags: 64,
          })
          .catch(() => {});
      } else if (interaction) {
        await interaction
          .reply({
            content: 'Something went wrong while processing your action.',
            flags: 64,
          })
          .catch(() => {});
      }
    } catch (e) {
      // swallow
    }
  }
});

client.login(DISCORD_TOKEN);
