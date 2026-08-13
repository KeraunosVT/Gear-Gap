// backend/discord.js — Discord bot via REST (no gateway connection).
// Lists guild members filtered to a role (for the party pool) and posts the
// finished roster embed to a channel. Requires a bot token with the
// "Server Members Intent" enabled for member listing.
const axios = require('axios');

const guildConfig = require('./guildConfig');

const API = 'https://discord.com/api/v10';
// Secrets and identity stay in the environment; everything else moved to
// guild_config so Guild Settings can change it without a redeploy.
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

// Getters, deliberately. Hoisting either of these back into a const is the one
// change that would make the settings page silently stop working.
const rosterChannelId = () => guildConfig.get().roster_channel_id;
const memberRoles = () => guildConfig.get().member_role_ids;

const botConfigured = Boolean(BOT_TOKEN && GUILD_ID);

const authHeaders = () => ({ Authorization: `Bot ${BOT_TOKEN}` });

// listMembers() is hit from several routes (roster, players, admin pool,
// awards import), and each uncached call re-paginates the entire guild member
// list — an easy way to trip Discord's rate limits. Cache the result briefly,
// dedupe concurrent callers onto one fetch, and serve the last good list if a
// refresh fails (a stale roster beats a 502).
const CACHE_TTL_MS = (parseInt(process.env.MEMBER_CACHE_SECONDS, 10) || 60) * 1000;
let membersCache = null;       // last successful result
let membersCacheAt = 0;        // when it was fetched
let membersInFlight = null;    // Promise while a fetch is running

// Fetch every guild member (paginated), keep those with a member role.
async function listMembers() {
  if (!botConfigured) {
    throw new Error('Discord bot is not configured (set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID).');
  }

  if (membersCache && Date.now() - membersCacheAt < CACHE_TTL_MS) {
    return membersCache;
  }
  if (membersInFlight) return membersInFlight;

  membersInFlight = fetchAllMembers()
    .then((members) => {
      membersCache = members;
      membersCacheAt = Date.now();
      return members;
    })
    .catch((err) => {
      if (membersCache) {
        console.warn('listMembers refresh failed — serving stale cache:', err.message);
        return membersCache;
      }
      throw err;
    })
    .finally(() => { membersInFlight = null; });

  return membersInFlight;
}

async function fetchAllMembers() {
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

  const roleFilter = memberRoles();
  const filtered = roleFilter.length
    ? members.filter((m) => (m.roles || []).some((r) => roleFilter.includes(r)))
    : members;

  return filtered
    .filter((m) => m.user && !m.user.bot)
    .map((m) => ({
      id: m.user.id,
      name: m.nick || m.user.global_name || m.user.username,
      avatar: m.user.avatar
        ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`
        : null,
      joinedAt: m.joined_at || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Fetch one guild member by user id (for session re-verification).
// Returns { status, member } — 404 means they're no longer in the guild.
async function fetchMember(userId) {
  if (!botConfigured) throw new Error('Discord bot is not configured.');
  const res = await axios.get(`${API}/guilds/${GUILD_ID}/members/${userId}`, {
    headers: authHeaders(),
    validateStatus: (s) => s < 500,
  });
  return { status: res.status, member: res.status === 200 ? res.data : null };
}

// Post an embed to the configured roster channel.
async function postEmbed(embed, content) {
  if (!botConfigured) throw new Error('Discord bot is not configured.');
  const channel = rosterChannelId();
  if (!channel) throw new Error('No roster channel is set — pick one in Guild Settings.');
  await axios.post(
    `${API}/channels/${channel}/messages`,
    { content: content || undefined, embeds: [embed] },
    { headers: { ...authHeaders(), 'Content-Type': 'application/json' } }
  );
}

// Post an image file to the configured roster channel.
async function postImage(buffer, filename, content) {
  if (!botConfigured) throw new Error('Discord bot is not configured.');
  const channel = rosterChannelId();
  if (!channel) throw new Error('No roster channel is set — pick one in Guild Settings.');
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', buffer, { filename: filename || 'roster.png', contentType: 'image/png' });
  if (content) form.append('payload_json', JSON.stringify({ content }));
  await axios.post(
    `${API}/channels/${channel}/messages`,
    form,
    { headers: { ...authHeaders(), ...form.getHeaders() } }
  );
}

// Every role in the guild, for the permissions page to grant against. Cached on
// the same short TTL as listMembers for the same reason — roles change rarely
// and the page re-fetches on every visit.
//
// @everyone is dropped: it's a real role that every member holds, so granting
// against it would hand a capability to the entire guild, which is never what
// someone clicking a row in a permissions grid means to do.
let rolesCache = null;
let rolesCacheAt = 0;

async function listRoles() {
  if (!botConfigured) return [];
  if (rolesCache && Date.now() - rolesCacheAt < CACHE_TTL_MS) return rolesCache;
  try {
    const { data } = await axios.get(`${API}/guilds/${GUILD_ID}/roles`, { headers: authHeaders() });
    const roles = (data || [])
      .filter((r) => r.id !== GUILD_ID && !r.managed)
      .map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position }))
      .sort((a, b) => b.position - a.position);
    rolesCache = roles;
    rolesCacheAt = Date.now();
    return roles;
  } catch (err) {
    if (rolesCache) {
      console.warn('listRoles refresh failed — serving stale cache:', err.message);
      return rolesCache;
    }
    throw err;
  }
}

// Drop both caches. Called by guildSettings.save(), because member_role_ids
// decides who listMembers() returns: without this, changing the roster roles
// looks like it did nothing for up to CACHE_TTL_MS, and the officer who just
// saved goes looking for a bug in the settings page instead.
function invalidateCaches() {
  membersCache = null;
  membersCacheAt = 0;
  rolesCache = null;
  rolesCacheAt = 0;
}

module.exports = {
  listMembers, listRoles, fetchMember, postEmbed, postImage, botConfigured, invalidateCaches,
};
