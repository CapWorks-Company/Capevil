// Shared constants for Level Devil engine + editor
export const CELL = 40; // px per grid cell

export const ENTITY_TYPES = {
  BLOCK: 'block',            // solid black cube
  SPIKE: 'spike',            // triangular hazard
  SPRING: 'spring',          // bounces player
  SPINNER: 'spinner',        // rotating spiked wheel hazard
  PLATFORM: 'platform',      // movable platform (solid, can be moved by triggers)
  GOAL: 'goal',              // level end
  CHECKPOINT: 'checkpoint',  // saves respawn point when touched
  TRIGGER: 'trigger',        // invisible trigger zone
  DECOR: 'decor',            // purely visual, no collision
};

export const HAZARD_TYPES = new Set([ENTITY_TYPES.SPIKE, ENTITY_TYPES.SPINNER]);
export const SOLID_TYPES = new Set([ENTITY_TYPES.BLOCK, ENTITY_TYPES.PLATFORM]);

export const ENTITY_STATES = {
  NORMAL: 'normal',       // default behaviour for its type
  PASSABLE: 'passable',   // no collision at all (ghost), still rendered translucent
  INVISIBLE: 'invisible', // not rendered AND not collidable
  HARMLESS: 'harmless',   // solid but does not kill (hazards only) - acts like a normal block
};

export const GRAVITY_DIRS = ['down', 'up', 'left', 'right'];
export const GRAVITY_VECTORS = {
  down:  { x: 0, y: 1 },
  up:    { x: 0, y: -1 },
  left:  { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export const ACTION_TYPES = {
  MOVE_ELEMENT: 'moveElement',       // move a target by (dx,dy) cells over duration
  SET_STATE: 'setState',             // change target state (normal/passable/invisible/harmless)
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
};

export const PHYSICS = {
  GRAVITY_ACCEL: 1800,   // px/s^2 base gravity acceleration
  MAX_FALL_SPEED: 1400,  // px/s terminal velocity along gravity axis
  MOVE_SPEED: 260,       // px/s base horizontal (or gravity-perpendicular) speed
  JUMP_POWER: 620,       // px/s base jump impulse
  AUTO_SCROLL_SPEED: 200,// px/s forward auto-scroll (Geometry-Dash-like forward push)
};

export const DEFAULT_GRID = { cols: 30, rows: 14 };
