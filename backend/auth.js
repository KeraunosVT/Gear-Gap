// backend/auth.js — Discord OAuth2 login, role-gated to a single guild.
// No bot required: membership and roles are read via the user's own
// `guilds.members.read` scope at GET /users/@me/guilds/{guild}/member.
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { fetchMember, botConfigured } = require('./discord');

const router = express.Router();

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_GUILD_ID,
  DISCORD_ALLOWED_ROLE_IDS = '',
  JWT_SECRET,
  APP_URL = '/',
} = process.env;

// Comma-separated role IDs that are allowed in. Empty list = any member of the
// guild is allowed (membership alone gates access).
const ALLOWED_ROLES = DISCORD_ALLOWED_ROLE_IDS.split(',').map(s => s.trim()).filter(Boolean);

// Admin role IDs — a tighter check for the admin area. Empty list = nobody is an
// admin until configured (fails closed).
const ADMIN_ROLES = (process.env.DISCORD_ADMIN_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

const COOKIE_NAME = 'gh_session';
const STATE_COOKIE = 'gh_oauth_state';
const SESSION_DAYS = 7;

// How stale a session may get before we re-check the member against Discord.
// Kicked members / demoted admins lose access within this window instead of
// riding out the full 7-day token. Requires the bot token; without a bot the
// old behavior (no re-checks) is kept, with a warning at boot.
const REVERIFY_MS = (parseInt(process.env.SESSION_REVERIFY_MINUTES, 10) || 60) * 60 * 1000;

// Auth is "configured" only when every required secret is present. If not, the
// app fails closed — data routes return 401 and nothing leaks.
const authConfigured = Boolean(
  DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_REDIRECT_URI && DISCORD_GUILD_ID && JWT_SECRET
);
if (!authConfigured) {
  console.warn('⚠️  Discord login is not fully configured — all data routes will be locked.');
}
if (authConfigured && !botConfigured) {
  console.warn('⚠️  No bot token — sessions cannot be re-verified against Discord; kicked members keep access until their session expires.');
}

const isProd = process.env.NODE_ENV === 'production';
const baseCookie = { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/' };

// ── Begin login: redirect to Discord with a CSRF state ──────────────────────
router.get('/login', (req, res) => {
  if (!authConfigured) return res.status(503).send('Discord login is not configured.');

  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, { ...baseCookie, maxAge: 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state,
    prompt: 'consent',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

// ── OAuth callback: verify, check role, issue session ───────────────────────
// Full path: /api/auth/discord/callback — must match DISCORD_REDIRECT_URI and
// the redirect registered in the Discord developer portal.
router.get('/discord/callback', async (req, res) => {
  if (!authConfigured) return res.status(503).send('Discord login is not configured.');

  const { code, state } = req.query;
  const savedState = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, baseCookie);

  if (!code || !state || state !== savedState) {
    return res.redirect(`${APP_URL}?auth=error`);
  }

  try {
    // 1. Exchange the code for an access token
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: DISCORD_REDIRECT_URI,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenRes.data.access_token;

    // 2. Read the user's member object in our guild (404 => not a member)
    const memberRes = await axios.get(
      `https://discord.com/api/users/@me/guilds/${DISCORD_GUILD_ID}/member`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        validateStatus: (s) => s < 500,
      }
    );

    if (memberRes.status === 404) {
      return res.redirect(`${APP_URL}?auth=not_member`);
    }
    if (memberRes.status !== 200) {
      throw new Error(`member fetch failed: ${memberRes.status}`);
    }

    const member = memberRes.data;

    // 3+4. Role check, then issue a signed session cookie
    const sessionUser = evaluateMember(member);
    if (!sessionUser) {
      return res.redirect(`${APP_URL}?auth=forbidden`);
    }
    issueSession(res, sessionUser);

    res.redirect(APP_URL);
  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.redirect(`${APP_URL}?auth=error`);
  }
});

// ── Who am I? ───────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!authConfigured || !token) return res.status(401).json({ authenticated: false });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true, user: { id: user.id, username: user.username, avatar: user.avatar, isAdmin: !!user.isAdmin } });
  } catch {
    res.status(401).json({ authenticated: false });
  }
});

// ── Logout ──────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, baseCookie);
  res.json({ ok: true });
});

// ── Session helpers ─────────────────────────────────────────────────────────
// Turn a Discord guild-member object into a session payload, or null if their
// roles no longer grant access (empty allow-list = any member passes).
function evaluateMember(member) {
  const roles = member?.roles || [];
  const allowed = ALLOWED_ROLES.length === 0 || roles.some((r) => ALLOWED_ROLES.includes(r));
  if (!allowed) return null;
  const u = member.user || {};
  return {
    id: u.id,
    username: u.global_name || u.username || 'Member',
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
    isAdmin: ADMIN_ROLES.length > 0 && roles.some((r) => ADMIN_ROLES.includes(r)),
    verified_at: Date.now(),
  };
}

function issueSession(res, sessionUser) {
  const sessionToken = jwt.sign(sessionUser, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
  res.cookie(COOKIE_NAME, sessionToken, { ...baseCookie, maxAge: SESSION_DAYS * 86400 * 1000 });
}

// ── Gate for protected routes ───────────────────────────────────────────────
// Sessions older than REVERIFY_MS are re-checked against Discord via the bot:
// kicked members and revoked roles are cut off within the hour instead of
// keeping access for the token's full lifetime. Discord being unreachable is
// NOT treated as revocation (fail open, retry next request) — only a definitive
// 404 (not a member) or a failed role check revokes the session.
const reverifyInFlight = new Map(); // user id -> Promise (dedupes request bursts)

async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!authConfigured || !token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  let user;
  try {
    user = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Session expired' });
  }

  // Tokens issued before this feature have no verified_at and re-verify immediately.
  const stale = botConfigured && Date.now() - (user.verified_at || 0) > REVERIFY_MS;
  if (stale) {
    try {
      let pending = reverifyInFlight.get(user.id);
      if (!pending) {
        pending = fetchMember(user.id).finally(() => reverifyInFlight.delete(user.id));
        reverifyInFlight.set(user.id, pending);
      }
      const { status, member } = await pending;

      if (status === 404) {
        res.clearCookie(COOKIE_NAME, baseCookie);
        return res.status(401).json({ error: 'You are no longer a member of the guild.' });
      }
      if (status === 200) {
        const refreshed = evaluateMember(member);
        if (!refreshed) {
          res.clearCookie(COOKIE_NAME, baseCookie);
          return res.status(401).json({ error: 'Your guild roles no longer grant access.' });
        }
        issueSession(res, refreshed); // fresh verified_at (and current roles/name)
        user = refreshed;
      } else {
        // 401/403/429 etc. point at our bot config or rate limits, not this
        // user — keep the session and retry on a later request.
        console.warn(`Session re-verify for ${user.id} got HTTP ${status} — keeping existing session.`);
      }
    } catch (err) {
      console.warn('Session re-verify failed — keeping existing session:', err.message);
    }
  }

  req.user = user;
  next();
}

// Stricter gate for the admin area: a valid session AND the admin flag.
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user?.isAdmin) return next();
    return res.status(403).json({ error: 'Admin access required' });
  });
}

module.exports = { router, requireAuth, requireAdmin };
