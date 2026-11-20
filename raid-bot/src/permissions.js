// Who may do what, per server.
//
// Posting: anyone, unless the server set a poster role.
// Managing a run: its lead, anyone with the server's manager role, and anyone
// with Manage Server or Manage Events, who can always step in.
const { PermissionFlagsBits } = require('discord.js');

// interaction.member is a GuildMember when the server is cached and a raw API
// member otherwise; both carry role ids, in different places.
function roleIds(member) {
  if (!member) return [];
  if (Array.isArray(member.roles)) return member.roles;
  return [...(member.roles?.cache?.keys?.() || [])];
}

const hasAny = (perms, ...flags) => flags.some((f) => perms?.has?.(f));
const isServerStaff = (perms) => hasAny(perms, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageEvents);

function canPost({ member, perms, settings }) {
  if (!settings.poster_role_id || isServerStaff(perms)) return true;
  const roles = roleIds(member);
  return roles.includes(settings.poster_role_id)
    || (!!settings.manager_role_id && roles.includes(settings.manager_role_id));
}

function canManage({ userId, member, perms, settings, run }) {
  if (run.lead_id === userId || isServerStaff(perms)) return true;
  return !!settings.manager_role_id && roleIds(member).includes(settings.manager_role_id);
}

module.exports = { canPost, canManage, isServerStaff, roleIds };
