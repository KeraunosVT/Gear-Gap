// Event categories for the calendar's colours and legend.
//
// Read off the event's name, because neither the schedule nor a one-off signup
// stores a type — "Arch Boss — Morokai" is an Arch Boss by its name alone.
// First match wins, so the narrower patterns sit above the broader ones they
// would otherwise lose to: "War Games" before "War". Anything unmatched is
// Other.
export const CATEGORIES = [
  { key: 'world_dungeon', label: 'World Dungeon', color: '#d9962b', match: /dungeon/i },
  { key: 'world_boss', label: 'World Boss', color: '#c2413b', match: /world\s*boss|field\s*boss/i },
  { key: 'arch_boss', label: 'Arch Boss', color: '#2f8f5b', match: /arch\s*boss/i },
  { key: 'boonstone', label: 'Boonstone', color: '#2a93a8', match: /boonstone/i },
  { key: 'riftstone', label: 'Riftstone', color: '#c0508f', match: /riftstone/i },
  { key: 'war_games', label: 'War Games', color: '#c46a2e', match: /war\s*games?|wargame/i },
  { key: 'siege', label: 'Siege', color: '#3d6fc4', match: /siege/i },
  { key: 'war', label: 'War', color: '#9c3434', match: /\bwar\b/i },
  { key: 'guild_contract', label: 'Guild Contract', color: '#8457c2', match: /contract/i },
  { key: 'raid', label: 'Raid', color: '#5b6b80', match: /raid/i },
  { key: 'tax_delivery', label: 'Tax Delivery', color: '#22897a', match: /tax/i },
  { key: 'lawless_wilds', label: 'Lawless Wilds', color: '#1f7a72', match: /lawless/i },
  { key: 'world_event', label: 'World Event', color: '#7a5cc7', match: /world\s*event/i },
];

export const OTHER = { key: 'other', label: 'Other', color: '#5f6b5f' };

export function categoryOf(title) {
  const t = String(title || '');
  return CATEGORIES.find((c) => c.match.test(t)) || OTHER;
}
