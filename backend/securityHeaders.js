// backend/securityHeaders.js — the response headers every page and API call
// carries, via helmet.
//
// The Content-Security-Policy is a list of where the site is allowed to load
// things from. Anything not listed is refused by the browser, so injected
// script from anywhere else can't run, and no other site can put the hall in a
// frame and trick an officer into clicking through it.
//
// When something stops loading after a change — a new font, an image host, an
// external API called from the browser — this list is where it gets added. The
// browser console names the directive that blocked it.
const helmet = require('helmet');

function directives(production) {
  return {
    defaultSrc: ["'self'"],
    // The Vite build is all external module files; nothing inline.
    scriptSrc: ["'self'"],
    // 'unsafe-inline' for React's style={{…}} attributes. Inline styles can't
    // run code; the script rule above is the one that matters.
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
    // Any HTTPS image, not a fixed list: avatars (Discord CDN), item icons
    // (Questlog CDN), screenshots and currency icons (Supabase storage), and
    // item images whose host is whatever they were imported from. blob: is the
    // build-scan preview before upload. Images can't execute, so the breadth
    // costs little and a fixed list would break the next new host silently.
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    // Every API call is same-origin; the browser talks to nothing else.
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    // Nobody frames the hall — not even itself. Clickjacking defence.
    frameAncestors: ["'none'"],
    // Production is HTTPS; local dev on http://localhost would have every
    // request rewritten to https and fail.
    ...(production ? { upgradeInsecureRequests: [] } : {}),
  };
}

function securityHeaders({ production = process.env.NODE_ENV === 'production' } = {}) {
  return helmet({
    contentSecurityPolicy: { useDefaults: false, directives: directives(production) },
    // Old-browser twin of frame-ancestors above.
    frameguard: { action: 'deny' },
    // HSTS only where there's HTTPS to pin. Sent over plain HTTP it's ignored
    // anyway, but leaving it off locally keeps the dev setup obviously simple.
    strictTransportSecurity: production,
  });
}

module.exports = { securityHeaders, directives };
