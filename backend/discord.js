// backend/discord.js — Discord bot via REST (no gateway connection).
// Lists guild members filtered to a role (for the party pool) and posts the
// finished roster embed to a channel. Requires a bot token with the
// "Server Members Intent" enabled for member listing.
const axios = require('axios');

const API = 'https://discord.com/api/v10';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ROSTER_CHANNEL_ID = process.env.DISCORD_ROSTER_CHANNEL_ID;
const MEMBER_ROLES = (process.env.DISCORD_MEMBER_ROLE_IDS || process.env.DISCORD_ALLOWED_ROLE_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const botConfigured = Boolean(BOT_TOKEN && GUILD_ID);

const authHeaders = () => ({ Authorization: `Bot ${BOT_TOKEN}` });

// Fetch every guild member (paginated), keep those with a member role.
async function listMembers() {
  if (!botConfigured) {
    throw new Error('Discord bot is not configured (set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID).');
  }

  const members = [];
  let after = '0';
  for (let page = 0; page < 25; page++) { // safety cap (~25k members)
    const res = await axios.get(`${API}/guilds/${GUILD_ID}/members`, {
      headers: authHeaders(),
      params: { limit: 1000, after },
    });
    const batch = res.data || [];
    members.push(...batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }

  const filtered = MEMBER_ROLES.length
    ? members.filter((m) => (m.roles || []).some((r) => MEMBER_ROLES.includes(r)))
    : members;

  return filtered
    .filter((m) => m.user && !m.user.bot)
    .map((m) => ({
      id: m.user.id,
      name: m.nick || m.user.global_name || m.user.username,
      avatar: m.user.avatar
        ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`
        : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Post an embed to the configured roster channel.
async function postEmbed(embed, content) {
  if (!botConfigured) throw new Error('Discord bot is not configured.');
  if (!ROSTER_CHANNEL_ID) throw new Error('DISCORD_ROSTER_CHANNEL_ID is not set.');
  await axios.post(
    `${API}/channels/${ROSTER_CHANNEL_ID}/messages`,
    { content: content || undefined, embeds: [embed] },
    { headers: { ...authHeaders(), 'Content-Type': 'application/json' } }
  );
}

// Post an image file to the configured roster channel.
async function postImage(buffer, filename, content) {
  if (!botConfigured) throw new Error('Discord bot is not configured.');
  if (!ROSTER_CHANNEL_ID) throw new Error('DISCORD_ROSTER_CHANNEL_ID is not set.');
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', buffer, { filename: filename || 'roster.png', contentType: 'image/png' });
  if (content) form.append('payload_json', JSON.stringify({ content }));
  await axios.post(
    `${API}/channels/${ROSTER_CHANNEL_ID}/messages`,
    form,
    { headers: { ...authHeaders(), ...form.getHeaders() } }
  );
}

module.exports = { listMembers, postEmbed, postImage, botConfigured };
