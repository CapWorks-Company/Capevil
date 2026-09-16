// Single client-side source of truth for the badge shop and cosmetic skins —
// every page that needs a price, a label, an icon, or a skin's colors reads
// it from here instead of re-declaring its own copy (the editor's palette
// gating, the account page's boutique, the admin editor, the win-screen skin
// announcement, engine.js's rendering — all import this one file).
//
// IMPORTANT: the PRICES and the skin unlock milestones are also baked into
// sql/schema.sql (badge_price() and claim_campaign_reward()'s milestone
// table) because the server can never trust the client with money — Postgres
// can't import this file, so if either list changes, the other must be
// updated by hand to match. Everything else here (labels, icons, colors) is
// purely cosmetic/display and only needs to live client-side.

// Which ENTITY_TYPES / editor feature each badge unlocks, so editor.js can
// gate its palette + the "🌍 Condition du monde" button off a single list
// instead of hardcoding badge ids in two places.
export const BADGES = [
  {
    id: 'spring', icon: '🌀', label: 'Badge Ressort', price: 100,
    unlocks: 'Débloque le ressort dans l\'éditeur.',
  },
  {
    id: 'fan', icon: '🌬️', label: 'Badge Ventilo', price: 100,
    unlocks: 'Débloque le ventilateur dans l\'éditeur.',
  },
  {
    id: 'teleporter', icon: '🛸', label: 'Badge Maître de la magie', price: 1000,
    unlocks: 'Débloque le téléporteur dans l\'éditeur.',
  },
  {
    id: 'switch', icon: '🔘', label: 'Badge Déclencheur', price: 1000,
    unlocks: 'Débloque le bouton et la plaque de pression dans l\'éditeur.',
  },
  {
    id: 'crate', icon: '📦', label: 'Badge Caisse', price: 100,
    unlocks: 'Débloque le cube poussable dans l\'éditeur.',
  },
  {
    id: 'world', icon: '🌍', label: 'Badge Monde', price: 500,
    unlocks: 'Débloque « Condition du monde » (gravité, fond, glitch du plafond) dans l\'éditeur.',
  },
  {
    id: 'creator', icon: '✍️', label: 'Badge Créateur', price: 1000,
    unlocks: 'Passe la limite de projets publiés de 5 à 20.',
    requires: { publishedLevels: 5 },
    requiresLabel: 'Il te faut déjà 5 niveaux publiés.',
  },
  {
    id: 'ultra', icon: '🚀', label: 'Badge Ultra', price: 1000,
    unlocks: 'Passe la limite de projets publiés de 20 à 50.',
    requires: { badge: 'creator' },
    requiresLabel: 'Il te faut déjà le Badge Créateur.',
  },
  {
    id: 'vip', icon: '👑', label: 'Badge VIP', price: 500,
    unlocks: 'Débloque les commentaires sur les niveaux (officiels et communautaires).',
    priceIsGuess: true, // aucun prix n'était donné pour celui-ci — voir sql/schema.sql's comment on badge_price()
  },
];

export function badgeById(id) {
  return BADGES.find((b) => b.id === id) || null;
}

// Which editor entity type / feature each badge id gates — kept as a
// separate small map (rather than folding into BADGES above) since it's
// only ever read by editor.js, and ENTITY_TYPES isn't meaningful outside
// the editor/engine context.
export const ENTITY_BADGE_REQUIREMENT = {
  spring: 'spring',
  fan: 'fan',
  teleporter: 'teleporter',
  button: 'switch',
  plate: 'switch',
  crate: 'crate',
};
// The 🌍 world-conditions button's own requirement — not an entity type, so
// it isn't in the map above.
export const WORLD_CONDITIONS_BADGE = 'world';

export function maxProjectsForBadges(badges) {
  const owned = new Set(badges || []);
  if (owned.has('ultra')) return 50;
  if (owned.has('creator')) return 20;
  return 5;
}

// Palette-based cosmetic skins — Capevil has no sprite art (everything is
// drawn procedurally on canvas, see engine.js), so a "skin" here is a pair of
// gradient colors that replaces the player's default orange (slot 1) / blue
// (slot 2) look, or the block's default dark-navy fill for object skins.
// Colors are deliberately reused from elsewhere in the game's existing
// palette (spinner blades, plate pad, fan glow, crate wood…) so every skin
// already feels visually at home instead of introducing brand-new hues.
export const PLAYER_SKINS = [
  { id: 'default', label: 'Défaut', unlockLevel: null, primary: null, secondary: null }, // null = engine keeps its own role-based orange/blue
  { id: 'emerald', label: 'Émeraude', unlockLevel: 3, primary: '#3ee9b8', secondary: '#06a879' },
  { id: 'ruby', label: 'Rubis', unlockLevel: 6, primary: '#ff5c8a', secondary: '#8f0d34' },
  { id: 'shadow', label: 'Ombre', unlockLevel: 9, primary: '#5a5e82', secondary: '#1e2030' },
  { id: 'gold', label: 'Or', unlockLevel: 12, primary: '#ffe08a', secondary: '#ff9f1c' },
  { id: 'ice', label: 'Glace', unlockLevel: 15, primary: '#e0fbff', secondary: '#48cae4' },
];

export const OBJECT_SKINS = [
  { id: 'default', label: 'Défaut', unlockLevel: null, base: '#181a26' },
  { id: 'stone', label: 'Pierre', unlockLevel: 4, base: '#4a4d52' },
  { id: 'wood', label: 'Bois', unlockLevel: 8, base: '#5c3a1e' },
  { id: 'neon', label: 'Néon', unlockLevel: 12, base: '#141420', glow: '#9d4edd' },
];

export function playerSkinById(id) {
  return PLAYER_SKINS.find((s) => s.id === id) || PLAYER_SKINS[0];
}
export function objectSkinById(id) {
  return OBJECT_SKINS.find((s) => s.id === id) || OBJECT_SKINS[0];
}

// Looks a skin id up in EITHER list and returns its display label — used by
// the win screen's "nouveau skin débloqué" line, which doesn't know ahead of
// time whether a given unlocked id is a player skin or an object skin.
export function skinLabel(id) {
  return (PLAYER_SKINS.find((s) => s.id === id) || OBJECT_SKINS.find((s) => s.id === id) || { label: id }).label;
}

// Every skin, in the exact "reached campaign level N" order the server
// unlocks them (see sql/schema.sql's claim_campaign_reward) — used by the
// Aventure page's reward track and the win-screen's "nouveau skin débloqué"
// announcement.
export const SKIN_MILESTONES = [
  ...PLAYER_SKINS.filter((s) => s.unlockLevel).map((s) => ({ level: s.unlockLevel, kind: 'player', skin: s })),
  ...OBJECT_SKINS.filter((s) => s.unlockLevel).map((s) => ({ level: s.unlockLevel, kind: 'object', skin: s })),
].sort((a, b) => a.level - b.level);
