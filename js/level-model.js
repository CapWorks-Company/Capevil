// Level data model: plain-JSON-serializable structures shared by the game and the editor.
import { ENTITY_TYPES, TRIGGER_MODES, DEFAULT_GRID, TELEPORTER_MAX_PER_FREQUENCY } from './constants.js';

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
    playerStart: { x: 1, y: DEFAULT_GRID.rows - 2 },
    entities: [],
    triggers: [],
    editBounds: null, // optional { enabled, colMin, colMax, rowMin, rowMax } — see normalizeEditBounds
    createdAt: null,
    updatedAt: null,
  };
}

// Validates/clamps an editBounds object against the level's current grid size.
// Returns null when disabled or malformed, so callers can just check truthiness.
export function normalizeEditBounds(eb, cols, rows) {
  if (!eb || !eb.enabled) return null;
  let colMin = Number.isFinite(eb.colMin) ? Math.round(eb.colMin) : 0;
  let colMax = Number.isFinite(eb.colMax) ? Math.round(eb.colMax) : cols - 1;
  let rowMin = Number.isFinite(eb.rowMin) ? Math.round(eb.rowMin) : 0;
  let rowMax = Number.isFinite(eb.rowMax) ? Math.round(eb.rowMax) : rows - 1;
  colMin = Math.max(0, Math.min(colMin, cols - 1));
  colMax = Math.max(colMin, Math.min(colMax, cols - 1));
  rowMin = Math.max(0, Math.min(rowMin, rows - 1));
  rowMax = Math.max(rowMin, Math.min(rowMax, rows - 1));
  return { enabled: true, colMin, colMax, rowMin, rowMax };
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
      base.w = 2;
      break;
    case ENTITY_TYPES.TELEPORTER:
      base.props = { frequency: level ? nextTeleporterFrequency(level) : 1, oneUse: false };
      break;
    case ENTITY_TYPES.TRIGGER:
      base.w = 1; base.h = 1;
      base.props = { mode: TRIGGER_MODES.ONCE, loopInterval: 2, actions: [] };
      break;
    case ENTITY_TYPES.BUTTON:
      base.w = 1; base.h = 1;
      base.props = { cooldown: 1, actions: [] };
      break;
    default:
      break;
  }
  return { ...base, ...overrides };
}

// Both TRIGGER and BUTTON entities carry an ordered `props.actions` list —
// this helper is the one place that needs to know that, so cleanup/migration
// code doesn't have to special-case each type separately.
export function hasActionList(entity) {
  return entity.type === ENTITY_TYPES.TRIGGER || entity.type === ENTITY_TYPES.BUTTON;
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
  // Triggers and buttons carry action lists; clean up any of their actions
  // that referenced the removed entity so we don't keep dangling ids.
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
  if (level.cols < 5 || level.rows < 5) errors.push('La grille est trop petite.');
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
// three boolean toggles). Also migrates the old single `state` enum
// (normal/passable/invisible/harmless) to the new independent booleans.
export function normalizeLevel(rawLevel) {
  const level = { ...createEmptyLevel(), ...rawLevel };
  level.entities = (level.entities || []).map((e) => {
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
    if (e.type === ENTITY_TYPES.TRIGGER) {
      e.props.mode = e.props.mode || TRIGGER_MODES.ONCE;
      e.props.loopInterval = e.props.loopInterval || 2;
    }
    if (e.type === ENTITY_TYPES.BUTTON) {
      e.props.cooldown = e.props.cooldown ?? 1;
    }
    if (hasActionList(e)) {
      e.props.actions = (e.props.actions || []).map((a) => {
        const params = { ...(a.params || {}) };
        // migrate legacy SET_STATE `state` string param to the new boolean trio
        if (a.type === 'setState' && typeof params.state === 'string') {
          params.passable = params.state === 'passable';
          params.invisible = params.state === 'invisible';
          params.harmless = params.state === 'harmless';
          delete params.state;
        }
        return {
          id: a.id || uid('act'), type: a.type, delay: a.delay || 0,
          targetId: a.targetId ?? null, params,
        };
      });
    }
  }
  if (!level.playerStart) level.playerStart = { x: 1, y: 1 };
  level.editBounds = normalizeEditBounds(rawLevel.editBounds, level.cols, level.rows);
  return level;
}

export function deserializeLevel(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  return normalizeLevel(raw);
}
