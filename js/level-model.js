// Level data model: plain-JSON-serializable structures shared by the game and the editor.
import { ENTITY_TYPES, ENTITY_STATES, TRIGGER_MODES, DEFAULT_GRID } from './constants.js';

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
    createdAt: null,
    updatedAt: null,
  };
}

export function createEntity(type, x, y, overrides = {}) {
  const base = {
    id: uid('ent'),
    type,
    x, y,       // top-left cell coords
    w: 1, h: 1, // size in cells
    state: ENTITY_STATES.NORMAL,
    props: {},
  };
  switch (type) {
    case ENTITY_TYPES.SPRING:
      base.props = { direction: 'up', power: 1.6 };
      break;
    case ENTITY_TYPES.SPINNER:
      base.props = { speed: 2.2, radius: 0.9 };
      break;
    case ENTITY_TYPES.PLATFORM:
      base.w = 2;
      break;
    case ENTITY_TYPES.TRIGGER:
      base.w = 1; base.h = 1;
      base.props = { mode: TRIGGER_MODES.ONCE, actions: [] };
      break;
    default:
      break;
  }
  return { ...base, ...overrides };
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
  // Triggers live inside `entities` (type === TRIGGER); clean up any of their
  // actions that referenced the removed entity so we don't keep dangling ids.
  for (const ent of level.entities) {
    if (ent.type === ENTITY_TYPES.TRIGGER && ent.props && ent.props.actions) {
      ent.props.actions = ent.props.actions.filter(a => a.targetId !== id);
    }
  }
}

// Basic structural validation before saving/publishing.
export function validateLevel(level) {
  const errors = [];
  if (!level.title || !level.title.trim()) errors.push('Le niveau doit avoir un titre.');
  if (!level.entities.some(e => e.type === ENTITY_TYPES.GOAL)) errors.push('Ajoute une case "But" (goal) pour terminer le niveau.');
  if (!level.playerStart) errors.push('Il manque un point de départ du joueur.');
  if (level.cols < 5 || level.rows < 5) errors.push('La grille est trop petite.');
  return errors;
}

export function serializeLevel(level) {
  return JSON.stringify(level);
}

// Fills in any missing fields so hand-edited or older JSON files never crash
// the editor/engine (which assume every entity has `props`, `state`, `w`, `h`).
export function normalizeLevel(rawLevel) {
  const level = { ...createEmptyLevel(), ...rawLevel };
  level.entities = (level.entities || []).map((e) => ({
    id: e.id || uid('ent'),
    type: e.type,
    x: e.x ?? 0,
    y: e.y ?? 0,
    w: e.w ?? 1,
    h: e.h ?? 1,
    state: e.state || ENTITY_STATES.NORMAL,
    props: e.props || {},
  }));
  for (const e of level.entities) {
    if (e.type === ENTITY_TYPES.TRIGGER) {
      e.props.mode = e.props.mode || TRIGGER_MODES.ONCE;
      e.props.actions = (e.props.actions || []).map((a) => ({
        id: a.id || uid('act'), type: a.type, delay: a.delay || 0,
        targetId: a.targetId ?? null, params: a.params || {},
      }));
    }
  }
  if (!level.playerStart) level.playerStart = { x: 1, y: 1 };
  return level;
}

export function deserializeLevel(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  return normalizeLevel(raw);
}
