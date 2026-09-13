// Level data model: plain-JSON-serializable structures shared by the game and the editor.
import { ENTITY_TYPES, ACTION_TYPES, DEFAULT_GRID, GRID_LIMITS, TELEPORTER_MAX_PER_FREQUENCY } from './constants.js';

let _uidCounter = 1;
export function uid(prefix = 'e') {
  return `${prefix}_${Date.now().toString(36)}_${(_uidCounter++).toString(36)}`;
}

export function createEmptyLevel(title = 'Nouveau niveau') {
  return {
    version: 1,
    id: null, // set once published to Supabase
    title,
    author: null,
    cols: DEFAULT_GRID.cols,
    rows: DEFAULT_GRID.rows,
    // The player's spawn point also carries its own initial state: which way
    // gravity pulls at the start of the level, and whether the player sprite
    // itself is drawn (sound/particles keep working either way).
    playerStart: { x: 1, y: DEFAULT_GRID.rows - 2, gravityDir: 'down', invisible: false },
    entities: [],
    triggers: [],
    // "Condition du monde" — world-wide settings, changeable live in-game via
    // the "Changer l'état du monde" action (grid size excepted, obviously).
    gravityScale: 1,
    background: '#1b1e2b',
    createdAt: null,
    updatedAt: null,
  };
}

// Picks the lowest teleporter frequency that still has room (< max members),
// so dropping teleporters on the grid "just works" without the author having
// to think about channels until they want to link specific ones.
export function nextTeleporterFrequency(level) {
  const counts = {};
  for (const e of level.entities) {
    if (e.type !== ENTITY_TYPES.TELEPORTER) continue;
    const f = (e.props && e.props.frequency) || 1;
    counts[f] = (counts[f] || 0) + 1;
  }
  for (let f = 1; f <= 99; f++) {
    if ((counts[f] || 0) < TELEPORTER_MAX_PER_FREQUENCY) return f;
  }
  return 1;
}

export function createEntity(type, x, y, overrides = {}, level = null) {
  const base = {
    id: uid('ent'),
    type,
    x, y,       // top-left cell coords
    w: 1, h: 1, // size in cells
    passable: false,
    invisible: false,
    harmless: false,
    deadly: false,
    props: {},
  };
  switch (type) {
    case ENTITY_TYPES.SPIKE:
      base.props = { facing: 'up' };
      break;
    case ENTITY_TYPES.SPRING:
      base.props = { direction: 'up', power: 1.6 };
      break;
    case ENTITY_TYPES.FAN:
      base.props = { direction: 'right', force: 1 };
      break;
    case ENTITY_TYPES.SPINNER:
      base.props = { speed: 2.2, radius: 0.9 };
      break;
    case ENTITY_TYPES.PLATFORM:
      // Same footprint as a freshly-placed solid block (1×1) by default —
      // still freely resizable afterward via the props panel, unlike a block.
      base.props = { style: 'color', color: null };
      break;
    case ENTITY_TYPES.TELEPORTER:
      base.props = { frequency: level ? nextTeleporterFrequency(level) : 1, oneUse: false };
      break;
    case ENTITY_TYPES.TRIGGER:
      base.w = 1; base.h = 1;
      base.props = { actions: [], loop: false };
      break;
    case ENTITY_TYPES.BUTTON:
      base.w = 1; base.h = 1;
      base.props = { actions: [], loop: false };
      break;
    case ENTITY_TYPES.PLATE:
      base.w = 1; base.h = 1;
      base.props = { actions: [], loop: false };
      break;
    default:
      break;
  }
  return { ...base, ...overrides };
}

// TRIGGER, BUTTON and PLATE all carry an ordered `props.actions` list — this
// helper is the one place that needs to know that, so cleanup/migration code
// doesn't have to special-case each type separately.
export function hasActionList(entity) {
  return entity.type === ENTITY_TYPES.TRIGGER || entity.type === ENTITY_TYPES.BUTTON || entity.type === ENTITY_TYPES.PLATE;
}

export function createAction(type, overrides = {}) {
  return {
    id: uid('act'),
    type,
    delay: 0,     // seconds after trigger fires
    targetId: null,
    params: {},
    ...overrides,
  };
}

export function cloneLevel(level) {
  return JSON.parse(JSON.stringify(level));
}

export function findEntity(level, id) {
  return level.entities.find(e => e.id === id) || null;
}

export function removeEntity(level, id) {
  level.entities = level.entities.filter(e => e.id !== id);
  // Triggers/buttons/plates carry action lists; clean up any of their
  // actions that referenced the removed entity so we don't keep dangling ids.
  for (const ent of level.entities) {
    if (hasActionList(ent) && ent.props && ent.props.actions) {
      ent.props.actions = ent.props.actions.filter(a => a.targetId !== id);
    }
  }
}

// Basic structural validation before saving/publishing. Mirrors the four
// publish conditions: a spawn, at least one support block, a goal, and (for
// publishing to the community) an author tied to a real account.
export function validateLevel(level) {
  const errors = [];
  if (!level.title || !level.title.trim()) errors.push('Le niveau doit avoir un titre.');
  if (!level.playerStart) errors.push('Il manque un point de départ du joueur (spawn).');
  if (!level.entities.some(e => e.type === ENTITY_TYPES.BLOCK || e.type === ENTITY_TYPES.PLATFORM)) {
    errors.push('Ajoute au moins un bloc (ou une plateforme) pour servir de support au joueur.');
  }
  if (!level.entities.some(e => e.type === ENTITY_TYPES.GOAL)) errors.push('Ajoute une case "But" (goal) pour terminer le niveau.');
  if (level.cols < GRID_LIMITS.colsMin || level.rows < GRID_LIMITS.rowsMin) errors.push('La grille est trop petite.');
  const freqCounts = {};
  for (const e of level.entities) {
    if (e.type !== ENTITY_TYPES.TELEPORTER) continue;
    const f = (e.props && e.props.frequency) || 1;
    freqCounts[f] = (freqCounts[f] || 0) + 1;
  }
  for (const [f, count] of Object.entries(freqCounts)) {
    if (count > TELEPORTER_MAX_PER_FREQUENCY) errors.push(`Trop de téléporteurs sur la fréquence ${f} (max ${TELEPORTER_MAX_PER_FREQUENCY}).`);
  }
  return errors;
}

export function serializeLevel(level) {
  return JSON.stringify(level);
}

// Fills in any missing fields so hand-edited or older JSON files never crash
// the editor/engine (which assume every entity has `props`, `w`, `h`, and the
// three boolean toggles), and migrates several now-removed concepts from
// older saved levels:
//   - the "decor" entity type is gone — those entities are simply dropped.
//   - triggers no longer have a firing "mode" — any old mode/loopInterval is
//     just ignored (the fresh `loop` boolean below replaces it).
//   - buttons no longer have a fixed `cooldown` — it's ignored in favor of
//     "ready once its actions finish", and `resetAfterActions` defaults in.
//   - move-element actions used `dx`/`dy` (screen-space); they're migrated to
//     `axisX`/`axisY` (axisY is inverted: +1 now means "up").
//   - the old per-field player actions (setGravity/invertControls/
//     setJumpPower/setSpeed) are folded into one consolidated
//     ACTION_TYPES.SET_PLAYER_STATE action each; the old shakeCamera action
//     is dropped (camera shake is now automatic-only, on death).
//   - a move-element action that targeted the player is detargeted (the
//     player can no longer be a moveElement target — that's the
//     teleporter's job).
export function normalizeLevel(rawLevel) {
  const level = { ...createEmptyLevel(), ...rawLevel };
  level.entities = (level.entities || [])
    .filter((e) => e.type !== 'decor')
    .map((e) => {
      const legacyState = typeof e.state === 'string' ? e.state : null;
      const out = {
        id: e.id || uid('ent'),
        type: e.type,
        x: e.x ?? 0,
        y: e.y ?? 0,
        w: e.w ?? 1,
        h: e.h ?? 1,
        passable: e.passable ?? (legacyState === 'passable'),
        invisible: e.invisible ?? (legacyState === 'invisible'),
        harmless: e.harmless ?? (legacyState === 'harmless'),
        deadly: !!e.deadly,
        props: e.props || {},
      };
      return out;
    });
  for (const e of level.entities) {
    if (e.type === ENTITY_TYPES.SPIKE) {
      e.props.facing = e.props.facing || 'up';
    }
    if (e.type === ENTITY_TYPES.SPRING) {
      // springs are up/down only now (left/right moved to the fan entity)
      if (e.props.direction !== 'up' && e.props.direction !== 'down') e.props.direction = 'up';
    }
    if (e.type === ENTITY_TYPES.FAN) {
      e.props.direction = e.props.direction || 'right';
      e.props.force = e.props.force ?? 1;
    }
    if (e.type === ENTITY_TYPES.TELEPORTER) {
      e.props.frequency = e.props.frequency || 1;
      e.props.oneUse = !!e.props.oneUse;
    }
    if (e.type === ENTITY_TYPES.TRIGGER || e.type === ENTITY_TYPES.PLATE) {
      e.props.loop = !!e.props.loop;
      delete e.props.mode; delete e.props.loopInterval; // old firing-mode concept, gone
    }
    if (e.type === ENTITY_TYPES.BUTTON) {
      e.props.loop = !!e.props.loop;
      // "resetAfterActions" is gone — every button/plate press now
      // automatically alternates forward/reverse of its own accord (see
      // engine.js's _fireTrigger), so there's nothing left to configure.
      delete e.props.mode; delete e.props.loopInterval; delete e.props.cooldown; delete e.props.resetAfterActions;
    }
    if (e.type === ENTITY_TYPES.PLATFORM) {
      // Appearance is now an explicit choice: a custom/default color (a
      // wooden-plank-style platform), or looking exactly like a solid block.
      e.props.style = e.props.style === 'block' ? 'block' : 'color';
      e.props.color = e.props.color || null; // null = default blue, only relevant when style === 'color'
    }
    if (hasActionList(e)) {
      e.props.actions = (e.props.actions || []).map((a) => {
        let type = a.type;
        let targetId = a.targetId ?? null;
        const params = { ...(a.params || {}) };
        // migrate legacy SET_STATE `state` string param to the new boolean trio
        if (type === 'setState' && typeof params.state === 'string') {
          params.passable = params.state === 'passable';
          params.invisible = params.state === 'invisible';
          params.harmless = params.state === 'harmless';
          delete params.state;
        }
        // fold the old per-field player actions into one consolidated action
        if (type === 'setGravity') {
          type = ACTION_TYPES.SET_PLAYER_STATE;
          const gravity = params.direction; targetId = null;
          Object.keys(params).forEach((k) => delete params[k]);
          params.gravity = gravity;
        } else if (type === 'invertControls') {
          type = ACTION_TYPES.SET_PLAYER_STATE; targetId = null;
          const invert = params.axis || 'horizontal', invertDuration = params.duration || 0;
          Object.keys(params).forEach((k) => delete params[k]);
          params.invert = invert; params.invertDuration = invertDuration;
        } else if (type === 'setJumpPower') {
          type = ACTION_TYPES.SET_PLAYER_STATE; targetId = null;
          const jumpMult = params.value, statDuration = params.duration || 0;
          Object.keys(params).forEach((k) => delete params[k]);
          params.jumpMult = jumpMult; params.statDuration = statDuration;
        } else if (type === 'setSpeed') {
          type = ACTION_TYPES.SET_PLAYER_STATE; targetId = null;
          const speedMult = params.value, statDuration = params.duration || 0;
          Object.keys(params).forEach((k) => delete params[k]);
          params.speedMult = speedMult; params.statDuration = statDuration;
        } else if (type === 'shakeCamera') {
          return null; // dropped entirely — filtered out below
        }
        // migrate legacy dx/dy (screen-space) -> axisX/axisY (axisY inverted)
        if (type === ACTION_TYPES.MOVE_ELEMENT) {
          if (('dx' in params || 'dy' in params) && !('axisX' in params) && !('axisY' in params)) {
            params.axisX = params.dx || 0;
            params.axisY = -(params.dy || 0);
          }
          delete params.dx; delete params.dy;
          // the player can no longer be a moveElement target (that's the
          // teleporter's job now) — detarget rather than crash on old data
          if (targetId === 'player') targetId = null;
        }
        return {
          id: a.id || uid('act'), type, delay: a.delay || 0,
          targetId, params,
        };
      }).filter(Boolean);
    }
  }
  if (!level.playerStart) level.playerStart = { x: 1, y: 1 };
  level.playerStart.gravityDir = level.playerStart.gravityDir || 'down';
  level.playerStart.invisible = !!level.playerStart.invisible;
  level.gravityScale = Number.isFinite(level.gravityScale) ? level.gravityScale : 1;
  level.background = level.background || '#1b1e2b';
  return level;
}

export function deserializeLevel(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  return normalizeLevel(raw);
}
