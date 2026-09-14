// Shared constants for Capevil engine + editor
export const CELL = 40; // px per grid cell

export const ENTITY_TYPES = {
  BLOCK: 'block',            // solid black cube
  SPIKE: 'spike',            // triangular hazard (orientable)
  SPRING: 'spring',          // bounces player (up/down only)
  FAN: 'fan',                // continuous wind push (left/right/up/down)
  SPINNER: 'spinner',        // rotating spiked wheel hazard
  PLATFORM: 'platform',      // movable platform (solid, can be moved by triggers)
  TELEPORTER: 'teleporter',  // linked by frequency, cycles the player between peers
  GOAL: 'goal',              // level end
  CHECKPOINT: 'checkpoint',  // saves respawn point when touched
  TRIGGER: 'trigger',        // invisible zone, fires once per entry (or loops forever)
  BUTTON: 'button',          // visible pressable switch: fires on press, ready again once its actions finish
  PLATE: 'plate',            // visible pressure plate: repeats its actions for as long as the player stays on it
  CRATE: 'crate',            // pushable physics cube: falls with gravity, player can push it, can weigh down plates
};

export const HAZARD_TYPES = new Set([ENTITY_TYPES.SPIKE, ENTITY_TYPES.SPINNER]);
// Crates are solid too (the player walks into/stands on them exactly like a
// block) — that's what lets them reuse the same generic solid-collision code
// as every other solid, instead of needing their own player-collision logic.
export const SOLID_TYPES = new Set([ENTITY_TYPES.BLOCK, ENTITY_TYPES.PLATFORM, ENTITY_TYPES.CRATE]);

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
    case ENTITY_TYPES.PLATFORM:
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
      // A crate is a physics object, not a hazard/hideable decoration — none
      // of the generic toggles apply to it.
      return [];
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
export const LAYERS = [-2, -1, 0, 1, 2];
export const LAYER_LABELS = {
  '-2': 'Arrière-plan (tout derrière)',
  '-1': 'Arrière-plan',
  '0': 'Normal (par défaut)',
  '1': 'Premier plan (devant le joueur)',
  '2': 'Premier plan (tout devant)',
};
export function clampLayer(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-2, Math.min(2, n));
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
