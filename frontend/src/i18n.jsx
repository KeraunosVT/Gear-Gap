import { createContext, useCallback, useContext, useMemo, useState, Fragment } from 'react';
import en from './locales/en';
import es from './locales/es';
import pt from './locales/pt';
import { setDisplayLocale } from './timeUtils';

// ── SITE LANGUAGE ───────────────────────────────────────────────────────────
// A small in-house translator rather than a library: the site needs lookup,
// {placeholders}, plurals and the odd inline link, and nothing else.
//
// Per viewer, kept in localStorage like the theme and timezone. English is the
// source: a key missing from es/pt falls back to English rather than showing
// the raw key, so a half-translated page still reads.
//
// Only the website. Discord posts from the bot go to channels everyone reads,
// so they stay in one language. Error messages from the API are also English
// — they are shown as the server sent them.

export const LANGUAGES = [
  { code: 'en', label: 'English', intl: 'en-US' },
  { code: 'es', label: 'Español', intl: 'es' },
  { code: 'pt', label: 'Português', intl: 'pt-BR' },
];
const DICTS = { en, es, pt };
const LANG_KEY = 'language';

function initialLang() {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (DICTS[stored]) return stored;
  } catch { /* storage blocked — fall through to the browser's language */ }
  const browser = String(navigator.language || '').slice(0, 2).toLowerCase();
  return DICTS[browser] ? browser : 'en';
}

// Module-level as well as in context, so plain helpers (date formatters in
// timeUtils and the pages) can format in the right language without a hook.
let current = initialLang();
if (typeof document !== 'undefined') document.documentElement.lang = current;

export const getLang = () => current;
// The BCP 47 tag for Intl / toLocaleDateString.
export const dateLocale = () => LANGUAGES.find((l) => l.code === current)?.intl || 'en-US';
setDisplayLocale(dateLocale());

// "Oct 25" / "25 oct" / "25 de out." — a guild-night YYYY-MM-DD, in the site
// language. Anchored at noon so no browser timezone moves it a day.
export const fmtDay = (dateStr, opts = { month: 'short', day: 'numeric' }) =>
  new Date(`${dateStr}T12:00:00`).toLocaleDateString(dateLocale(), opts);
// Weekday name for 0 (Sunday) … 6, in the site language. 2023-01-01 was a Sunday.
export const weekdayName = (dow, style = 'long') =>
  new Date(Date.UTC(2023, 0, 1 + dow, 12)).toLocaleDateString(dateLocale(), { weekday: style, timeZone: 'UTC' });

// Picks key_one / key_other (etc.) when `count` is given and such keys exist.
function lookup(lang, key, vars) {
  const dict = DICTS[lang] || en;
  if (vars && typeof vars.count === 'number') {
    const form = new Intl.PluralRules(LANGUAGES.find((l) => l.code === lang)?.intl || 'en-US').select(vars.count);
    const plural = dict[`${key}_${form}`] ?? dict[`${key}_other`] ?? en[`${key}_${form}`] ?? en[`${key}_other`];
    if (plural != null) return plural;
  }
  return dict[key] ?? en[key] ?? key;
}

const fill = (str, vars) => (vars
  ? str.replace(/\{(\w+)\}/g, (m, name) => (vars[name] != null ? String(vars[name]) : m))
  : str);

// Plain translate, usable outside components (reads the module-level language).
export function translate(key, vars) {
  return fill(lookup(current, key, vars), vars);
}

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(current);

  const setLang = useCallback((next) => {
    if (!DICTS[next]) return;
    current = next;
    document.documentElement.lang = next;
    setDisplayLocale(dateLocale());
    try { localStorage.setItem(LANG_KEY, next); } catch { /* per-viewer nicety only */ }
    setLangState(next);
  }, []);

  const value = useMemo(() => {
    const t = (key, vars) => fill(lookup(lang, key, vars), vars);
    // Translate a string with inline markup: "<b>{name}</b> is away" with
    // { b: (text) => <strong>{text}</strong> }. Tags can't nest.
    const rich = (key, vars = {}, tags = {}) => {
      const str = t(key, vars);
      const out = [];
      const re = /<(\w+)>(.*?)<\/\1>/g;
      let last = 0;
      let m;
      let i = 0;
      while ((m = re.exec(str))) {
        if (m.index > last) out.push(str.slice(last, m.index));
        const render = tags[m[1]];
        out.push(<Fragment key={i++}>{render ? render(m[2]) : m[2]}</Fragment>);
        last = re.lastIndex;
      }
      if (last < str.length) out.push(str.slice(last));
      return out;
    };
    return { lang, setLang, t, rich };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

// Outside the provider (tests, the outermost error boundary) it still works,
// in whatever language is stored.
export function useT() {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  return {
    lang: current,
    setLang: () => {},
    t: translate,
    rich: (key, vars) => [translate(key, vars).replace(/<\/?\w+>/g, '')],
  };
}
