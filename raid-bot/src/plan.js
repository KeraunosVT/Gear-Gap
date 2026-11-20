// A run's plan: which gates of which modes it covers, typed as one line —
// "normal 1-3 + nightmare 1", "nm 1", "difficult" (all gates).
//
// Stored as segments in difficulty order:
//   [{ mode: 'normal', gates: [1, 2, 3] }, { mode: 'nightmare', gates: [1] }]
const { gatesText } = require('./catalog');

function modeFor(raid, word) {
  const w = word.toLowerCase();
  return raid.modes.find((m) => m.key === w || m.label.toLowerCase() === w || (m.aliases || []).includes(w))
    // Any unambiguous start of a mode's name: "night", "diffic".
    || (w.length >= 2 ? onlyOne(raid.modes.filter((m) => m.label.toLowerCase().startsWith(w))) : null);
}

const onlyOne = (list) => (list.length === 1 ? list[0] : null);

// "1-3" → [1,2,3]; "1,3" / "1 & 3" / "1 3" → [1,3]. Empty → every gate.
function parseGates(text, max) {
  const t = text.replace(/[–—]/g, '-').trim();
  if (!t) return { gates: Array.from({ length: max }, (_, i) => i + 1) };
  const gates = new Set();
  for (const part of t.split(/[\s,&]+/).filter(Boolean)) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) return { error: `"${part}" isn't a gate.` };
    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : from;
    if (from < 1 || to > max || from > to) return { error: `Gates go from 1 to ${max}.` };
    for (let g = from; g <= to; g += 1) gates.add(g);
  }
  return { gates: [...gates].sort((a, b) => a - b) };
}

// Returns { ok: true, segments } or { ok: false, error }.
function parsePlan(raid, input) {
  const s = String(input || '').toLowerCase()
    .replace(/\bgates?\b/g, ' ')
    .replace(/\bg(?=\d)/g, ' ')
    .replace(/\b(and|then|plus)\b/g, ' ')
    .replace(/[+;/|]/g, ' ');
  const pieces = [...s.matchAll(/([a-z]+)\s*([\d\s,&\-–—]*)/g)];
  if (!pieces.length || s.replace(/[a-z\d\s,&\-–—]/g, '').length) {
    return { ok: false, error: `Couldn't read the plan "${input}". Try "normal 1-3" or "normal 1-3 + nightmare 1".` };
  }

  const byMode = new Map();
  for (const [, word, gatesPart] of pieces) {
    const mode = modeFor(raid, word);
    if (!mode) {
      return { ok: false, error: `"${word}" isn't a mode. Pick from ${raid.modes.map((m) => m.label).join(', ')}.` };
    }
    const parsed = parseGates(gatesPart, raid.gates);
    if (parsed.error) return { ok: false, error: parsed.error };
    const have = byMode.get(mode.key) || new Set();
    parsed.gates.forEach((g) => have.add(g));
    byMode.set(mode.key, have);
  }

  const segments = raid.modes
    .filter((m) => byMode.has(m.key))
    .map((m) => ({ mode: m.key, gates: [...byMode.get(m.key)].sort((a, b) => a - b) }));
  return { ok: true, segments };
}

// Back to the typed form, which parsePlan reads exactly: "Normal 1-3 + Nightmare 1".
function formatPlan(raid, segments) {
  return segments.map((seg) => {
    const label = raid.modes.find((m) => m.key === seg.mode)?.label || seg.mode;
    const g = seg.gates;
    const contiguous = g.every((n, i) => i === 0 || n === g[i - 1] + 1);
    const gates = g.length === raid.gates ? `1-${raid.gates}`
      : contiguous && g.length > 1 ? `${g[0]}-${g[g.length - 1]}` : g.join(',');
    return `${label} ${gates}`;
  }).join(' + ');
}

// "🟢 **Normal** · Gates 1–3", one per segment, for the post.
function planLines(raid, segments) {
  return (segments || []).map((seg) => {
    const mode = raid?.modes.find((m) => m.key === seg.mode);
    return `${mode?.emoji || '•'} **${mode?.label || seg.mode}** · ${gatesText(seg.gates || [])}`;
  });
}

// Autocomplete for the plan box: what they've typed, read back so they can see
// it parsed, then the usual plans that match it.
function planSuggestions(raid, typed) {
  const t = String(typed || '').trim();
  const full = `1-${raid.gates}`;
  const labels = raid.modes.map((m) => m.label);
  const common = [
    ...labels.map((l) => `${l} ${full}`),
    ...labels.slice(1).map((l, i) => `${labels[i]} ${full} + ${l} ${full}`),
    ...labels.map((l) => `${l} 1`),
  ];
  const out = [];
  if (t) {
    const parsed = parsePlan(raid, t);
    if (parsed.ok) {
      const value = formatPlan(raid, parsed.segments);
      out.push({ name: `✓ ${planLines(raid, parsed.segments).map((l) => l.replace(/\*\*/g, '')).join('  ')}`.slice(0, 100), value });
    }
  }
  const q = t.toLowerCase();
  for (const c of common) {
    if (out.some((o) => o.value === c)) continue;
    if (!q || c.toLowerCase().startsWith(q) || c.toLowerCase().includes(q)) out.push({ name: c, value: c });
  }
  return out.slice(0, 25);
}

module.exports = { parsePlan, formatPlan, planLines, planSuggestions };
