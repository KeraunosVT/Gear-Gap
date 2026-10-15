// Event categories for the calendar's colours and legend.
//
// Read off the event's name, because neither the schedule nor a one-off signup
// stores a type — "Arch Boss — Morokai" is an Arch Boss by its name alone.
// First match wins, so the narrower patterns sit above the broader ones they
// would otherwise lose to: "War Games" before "War". Anything unmatched is
// Other.
//
// Every colour sits under white 11px text on the calendar, so each is dark
// enough to hold roughly 4.5:1 against white.
export const CATEGORIES = [
  { key: 'world_dungeon', label: 'World Dungeon', color: '#94600f', match: /dungeon/i },
  { key: 'world_boss', label: 'World Boss', color: '#a8352f', match: /world\s*boss|field\s*boss/i },
  { key: 'arch_boss', label: 'Arch Boss', color: '#24734a', match: /arch\s*boss/i },
  { key: 'boonstone', label: 'Boonstone', color: '#1f7385', match: /boonstone/i },
  { key: 'riftstone', label: 'Riftstone', color: '#a03f76', match: /riftstone/i },
  { key: 'war_games', label: 'War Games', color: '#a6551f', match: /war\s*games?|wargame/i },
  { key: 'siege', label: 'Siege', color: '#3460aa', match: /siege/i },
  { key: 'war', label: 'War', color: '#8f2f2f', match: /\bwar\b/i },
  { key: 'guild_contract', label: 'Guild Contract', color: '#6f47a8', match: /contract/i },
  { key: 'raid', label: 'Raid', color: '#4d5b6e', match: /raid/i },
  { key: 'tax_delivery', label: 'Tax Delivery', color: '#1b6e62', match: /tax/i },
  { key: 'lawless_wilds', label: 'Lawless Wilds', color: '#1a665f', match: /lawless/i },
  { key: 'world_event', label: 'World Event', color: '#6549ad', match: /world\s*event/i },
];

export const OTHER = { key: 'other', label: 'Other', color: '#515c51' };

export function categoryOf(title) {
  const t = String(title || '');
  return CATEGORIES.find((c) => c.match.test(t)) || OTHER;
}
