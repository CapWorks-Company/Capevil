// Shared constants for Level Devil engine + editor
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
  TRIGGER: 'trigger',        // invisible trigger zone, fires once (or per mode)
  BUTTON: 'button',          // visible pressable switch: fires repeatedly with a cooldown
  DECOR: 'decor',            // purely visual, no collision
};

export const HAZARD_TYPES = new Set([ENTITY_TYPES.SPIKE, ENTITY_TYPES.SPINNER]);
export const SOLID_TYPES = new Set([ENTITY_TYPES.BLOCK, ENTITY_TYPES.PLATFORM]);

// Entity "state" used to be a single exclusive enum (normal/passable/invisible/
// harmless). That made "invisible" behave like a ghost (unseen AND unable to
// hurt/collide) which is backwards from what an invisible hazard should do.
// It is now three independent boolean toggles living directly on the entity:
//   passable  -> no collision at all (solids become walk-through; hazards stop hurting)
//   invisible -> not rendered in-game, but still fully solid/dangerous
//   harmless  -> hazard no longer kills (still visible, still solid if applicable)
export const ENTITY_TOGGLES = ['passable', 'invisible', 'harmless'];
export const TOGGLE_LABELS = {
  passable: 'Traversable (aucune collision)',
  invisible: 'Invisible (mais toujours actif)',
  harmless: 'Inoffensif (ne tue pas)',
};

// Which toggles make sense to show for a given entity type in the editor.
export function togglesForType(type) {
  switch (type) {
    case ENTITY_TYPES.BLOCK:
    case ENTITY_TYPES.PLATFORM:
      return ['passable', 'invisible'];
    case ENTITY_TYPES.SPIKE:
    case ENTITY_TYPES.SPINNER:
      return ['passable', 'invisible', 'harmless'];
    case ENTITY_TYPES.SPRING:
    case ENTITY_TYPES.FAN:
    case ENTITY_TYPES.TELEPORTER:
      return ['passable', 'invisible'];
    case ENTITY_TYPES.GOAL:
    case ENTITY_TYPES.CHECKPOINT:
    case ENTITY_TYPES.DECOR:
      return ['invisible'];
    case ENTITY_TYPES.BUTTON:
      // A button's whole point is to be a visible, physical switch — unlike
      // a trigger zone it is never hidden, so no toggles apply to it.
      return [];
    default:
      return [];
  }
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

export const ACTION_TYPES = {
  MOVE_ELEMENT: 'moveElement',       // move a target by (dx,dy) cells over duration
  SET_STATE: 'setState',             // set target's passable/invisible/harmless flags
  SET_GRAVITY: 'setGravity',         // change player's gravity direction
  INVERT_CONTROLS: 'invertControls', // toggle troll controls (swap keys)
  SET_JUMP_POWER: 'setJumpPower',    // change player's jump power (multiplier)
  SET_SPEED: 'setSpeed',             // change player's move speed (multiplier)
  TELEPORT: 'teleport',              // instantly move target to (x,y) cells
  SHAKE_CAMERA: 'shakeCamera',       // cosmetic
};

export const TRIGGER_MODES = {
  ONCE: 'once',       // fires the first time the player enters, never again
  REPEAT: 'repeat',   // fires every time the player enters the zone
  ON_EXIT: 'onExit',  // fires when the player leaves the zone
  LOOP: 'loop',       // fires once on entry, then repeats its whole action list forever
};

export const PHYSICS = {
  GRAVITY_ACCEL: 1800,   // px/s^2 base gravity acceleration
  MAX_FALL_SPEED: 1400,  // px/s terminal velocity along gravity axis
  MOVE_SPEED: 260,       // px/s base horizontal (or gravity-perpendicular) speed
  JUMP_POWER: 620,       // px/s base jump impulse
  AUTO_SCROLL_SPEED: 200,// px/s forward auto-scroll (Geometry-Dash-like forward push)
};

export const DEFAULT_GRID = { cols: 30, rows: 14 };

// Teleporters sharing a "frequency" are linked together. Capped at 3 per
// group (matches the physical idea of a few linked portals, and keeps the
// cycling order easy to reason about in the editor).
export const TELEPORTER_MAX_PER_FREQUENCY = 3;
export const TELEPORTER_FREQUENCIES = [1, 2, 3, 4, 5, 6, 7, 8];
