// Shared constants for Capevil engine + editor
export const CELL = 40; // px per grid cell

export const ENTITY_TYPES = {
  BLOCK: 'block',            // solid block — freely resizable, and can be targeted by moveElement/teleport actions to build moving platforms
  SPIKE: 'spike',            // triangular hazard (orientable)
  SPRING: 'spring',          // bounces player (up/down only)
  FAN: 'fan',                // continuous wind push (left/right/up/down)
  SPINNER: 'spinner',        // rotating spiked wheel hazard
  TELEPORTER: 'teleporter',  // linked by frequency, cycles the player between peers
  GOAL: 'goal',              // level end
  CHECKPOINT: 'checkpoint',  // saves respawn point when touched
  TRIGGER: 'trigger',        // invisible zone, fires once per entry (or loops forever)
  BUTTON: 'button',          // visible pressable switch: fires on press, ready again once its actions finish
  PLATE: 'plate',            // visible pressure plate: repeats its actions for as long as the player stays on it
  CRATE: 'crate',            // pushable physics cube: falls with gravity, player can push it, can weigh down plates
};

// A distinct, standalone "moving platform" entity used to exist (type
// 'platform') — it's gone now that BLOCK is freely resizable and any solid
// entity can already be targeted by a moveElement/teleport action, which
// made it pure duplication (same collision code, same action-driven
// movement, just a second type to maintain). normalizeLevel migrates any
// old saved level's 'platform' entities to BLOCK on load — see there.

export const HAZARD_TYPES = new Set([ENTITY_TYPES.SPIKE, ENTITY_TYPES.SPINNER]);
// Crates are solid too (the player walks into/stands on them exactly like a
// block) — that's what lets them reuse the same generic solid-collision code
// as every other solid, instead of needing their own player-collision logic.
export const SOLID_TYPES = new Set([ENTITY_TYPES.BLOCK, ENTITY_TYPES.CRATE]);

// Entity "state" used to be a single exclusive enum (normal/passable/invisible/
// harmless). That made "invisible" behave like a ghost (unseen AND unable to
// hurt/collide) which is backwards from what an invisible hazard should do.
// It is now independent boolean toggles living directly on the entity:
//   passable  -> no collision at all (solids become walk-through; hazards/deadly blocks stop hurting)
//   invisible -> not rendered in-game, but still fully solid/dangerous
//   harmless  -> hazard (spike/spinner) no longer kills (still visible, still solid if applicable)
//   deadly    -> a normally-safe solid block/platform instead kills the player on contact (like a hazard)
export const ENTITY_TOGGLES = ['passable', 'invisible', 'harmless', 'deadly'];
export const TOGGLE_LABELS = {
  passable: 'Traversable (aucune collision)',
  invisible: 'Invisible (mais toujours actif)',
  harmless: 'Inoffensif (ne tue pas)',
  deadly: 'Tueur (tue le joueur au contact)',
};

// Which toggles make sense to show for a given entity type in the editor.
export function togglesForType(type) {
  switch (type) {
    case ENTITY_TYPES.BLOCK:
      return ['passable', 'invisible', 'deadly'];
    case ENTITY_TYPES.SPIKE:
    case ENTITY_TYPES.SPINNER:
      return ['passable', 'invisible', 'harmless'];
    case ENTITY_TYPES.SPRING:
    case ENTITY_TYPES.FAN:
    case ENTITY_TYPES.TELEPORTER:
      return ['passable', 'invisible'];
    case ENTITY_TYPES.GOAL:
      return ['passable', 'invisible'];
    case ENTITY_TYPES.CHECKPOINT:
      return ['invisible'];
    case ENTITY_TYPES.BUTTON:
    case ENTITY_TYPES.PLATE:
      // A button/plate's whole point is to be a visible, physical switch, so
      // it's never hidden and never itself a hazard.
      return [];
    case ENTITY_TYPES.CRATE:
      // Same three as BLOCK: a crate can be made traversable, hidden, or
      // turned into a hazard ("tueur") — see engine.js's _checkHazardsAndGoal
      // and _solidRects for the deadly-crate special case, mirroring how a
      // deadly BLOCK already works. `harmless` doesn't apply — a crate isn't
      // a hazard by default, so there's nothing to "de-fang".
      return ['passable', 'invisible', 'deadly'];
    default:
      return [];
  }
}

// Purely cosmetic z-ordering: which entities get drawn behind/in front of
// others, and behind/in front of the player. This never touches collision,
// hazards, or scripting — every entity fully interacts with the player
// (solids are still solid, hazards still hurt, triggers still fire) no
// matter what layer it's drawn on; only its paint order on screen changes.
// 0 is the default and matches the game's original single-pass draw order
// exactly, so untouched levels/entities render unchanged.
// Free-form integer: the level author just types a number (0 = normal,
// negative = further back, positive = further forward) instead of picking
// from a handful of named presets — the entity hierarchy panel in the
// editor (see editor.js's renderHierarchy) is what makes sense of an
// arbitrary set of values, showing every placed entity ordered back-to-front
// so the actual number never has to be memorized.
export const LAYER_MIN = -999;
export const LAYER_MAX = 999;
export function clampLayer(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(LAYER_MIN, Math.min(LAYER_MAX, n));
}

export const SPIKE_FACINGS = ['up', 'down', 'left', 'right'];
export const FACING_LABELS = { up: 'Haut', down: 'Bas', left: 'Gauche', right: 'Droite' };

export const GRAVITY_DIRS = ['down', 'up', 'left', 'right'];
export const GRAVITY_VECTORS = {
  down:  { x: 0, y: 1 },
  up:    { x: 0, y: -1 },
  left:  { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
// Used when the world's gravityScale (or a crate's own gravity multiplier)
// is negative: gravity then pulls toward the OPPOSITE of the nominal
// direction (a player with gravityDir 'down' under negative world gravity
// effectively falls 'up', feet-first rotation and all) — see engine.js's
// _effectiveGravityDir.
export const OPPOSITE_GRAVITY_DIR = { down: 'up', up: 'down', left: 'right', right: 'left' };

// Every trigger/button/plate action reduces to exactly these five kinds.
export const ACTION_TYPES = {
  MOVE_ELEMENT: 'moveElement',         // move a target element by an Axe X / Axe Y offset over a duration
  TELEPORT: 'teleport',                // instantly move a target (or the player) to (x,y) cells
  SET_WORLD_STATE: 'setWorldState',    // change gravity scale / background (never the grid size)
  SET_STATE: 'setState',               // set a target's passable/invisible/harmless flags
  SET_PLAYER_STATE: 'setPlayerState',  // change the player: gravity, inverted controls, visibility, jump/speed power
};

export const PHYSICS = {
  GRAVITY_ACCEL: 1800,   // px/s^2 base gravity acceleration (scaled by level.gravityScale)
  MAX_FALL_SPEED: 1400,  // px/s terminal velocity along gravity axis (scaled by level.gravityScale)
  MOVE_SPEED: 260,       // px/s base horizontal (or gravity-perpendicular) speed
  JUMP_POWER: 620,       // px/s base jump impulse
  AUTO_SCROLL_SPEED: 200,// px/s forward auto-scroll (Geometry-Dash-like forward push)
};

export const DEFAULT_GRID = { cols: 30, rows: 14 };

// Hard limits on grid size — the editor can no longer make these adjustable
// beyond this range (columns 9-80, rows 9-30).
export const GRID_LIMITS = { colsMin: 9, colsMax: 80, rowsMin: 9, rowsMax: 30 };

// Teleporters sharing a "frequency" are linked together. Capped at 3 per
// group (matches the physical idea of a few linked portals, and keeps the
// cycling order easy to reason about in the editor).
export const TELEPORTER_MAX_PER_FREQUENCY = 3;
export const TELEPORTER_FREQUENCIES = [1, 2, 3, 4, 5, 6, 7, 8];

// ---- Extended trigger/button/plate activation options ----
// Actions scheduled by a firing always play out to the end regardless of
// whether the player stays on the trigger/button/plate ("continuer jusqu'au
// bout des actions" is the built-in default behavior — see engine.js's
// _fireTrigger, which pushes every action into `this.scheduled` up front).
// RELEASE_MODES only controls what happens AFTER that: whether the
// trigger/button/plate stays reusable, or permanently closes itself once
// this activation's actions are done playing.
export const RELEASE_MODES = ['finish', 'finishAndClose'];
export const RELEASE_MODE_LABELS = {
  finish: 'Continuer jusqu’au bout des actions',
  finishAndClose: 'Continuer jusqu’au bout des actions, puis fermer (plus utilisable)',
};

// Who is allowed to activate a trigger/button/plate. Every type defaults to
// 'player' except PLATE, which has always also weighed down for a resting
// crate (see engine.js's _crateOverlapping) — 'both' preserves that.
export const ACTIVATOR_MODES = ['player', 'crate', 'both'];
export const ACTIVATOR_LABELS = { player: 'Joueur uniquement', crate: 'Caisse uniquement', both: 'Joueur ou caisse' };
