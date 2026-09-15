// Level data model: plain-JSON-serializable structures shared by the game and the editor.
import { ENTITY_TYPES, ACTION_TYPES, DEFAULT_GRID, GRID_LIMITS, TELEPORTER_MAX_PER_FREQUENCY, clampLayer, RELEASE_MODES, ACTIVATOR_MODES, PLATE_PRESS_MODES } from './constants.js';

// Shared default set of the extended activation params added to TRIGGER,
// BUTTON and PLATE alike (see engine.js's _fireTrigger/_activate/_canActivate
// for how each is used). `activator` defaults to 'both' for PLATE (a crate
// has always been able to weigh one down) and 'player' for TRIGGER/BUTTON
// (crates couldn't activate those before this feature existed).
function defaultActivationProps(type) {
  return {
    releaseMode: 'finish',      // 'finish' | 'finishAndClose'
    releaseGrace: 0,            // seconds a brief release is still forgiven
    activationDelay: 0,         // seconds between overlap and actually firing
    sequential: false,          // chain actions one after another instead of independent delays
    activator: type === ENTITY_TYPES.PLATE ? 'both' : 'player', // 'player' | 'crate' | 'both'
    maxRepeats: 0,              // 0 = unlimited
    rearmCooldown: 0,           // seconds after actions finish before it can fire again
  };
}

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
    // Optional second player — same shape as playerStart, null when the
    // level is single-player (the default; "2 joueurs, pas plus, mais 1
    // seul est possible"). See engine.js's this.players / this.player2.
    playerStart2: null,
    entities: [],
    triggers: [],
    // "Condition du monde" — world-wide settings, changeable live in-game via
    // the "Changer l'état du monde" action (grid size excepted, obviously).
    // Can be negative — gravity then pulls the opposite way (affects the
    // player AND every crate; see engine.js's _effectiveGravityDir /
    // _updateCrates).
    gravityScale: 1,
    background: '#1b1e2b',
    // Authored-only (not live-changeable via an action, unlike the two
    // above): whether jumping into a solid against the direction gravity
    // pulls (bonking your head on a ceiling, normally) incorrectly counts as
    // landing — the historical physics bug that let you spam-jump forever
    // stuck against a ceiling/wall. Off by default (bug fixed); a level
    // author can opt back into the old buggy behavior on purpose as a
    // mechanic (see engine.js's _resolveAxis).
    ceilingJumpGlitch: false,
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
    // Purely visual paint-order layer (any integer, 0 = default/original
    // order) — see constants.js's clampLayer. Never affects
    // collision/hazards/scripting.
    layer: 0,
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
      // `direction`: 'cw' (default, matches the original always-clockwise
      // behavior) or 'ccw' — see engine.js's _updateSpinnerAngles, which
      // simply flips the sign of the per-frame angle increment.
      base.props = { speed: 2.2, radius: 0.9, direction: 'cw' };
      break;
    case ENTITY_TYPES.TELEPORTER:
      base.props = { frequency: level ? nextTeleporterFrequency(level) : 1, oneUse: false };
      break;
    case ENTITY_TYPES.TRIGGER:
      base.w = 1; base.h = 1;
      base.props = { actions: [], loop: false, ...defaultActivationProps(type) };
      break;
    case ENTITY_TYPES.BUTTON:
      base.w = 1; base.h = 1;
      // "reversible" is opt-in: off by default, a button always replays its
      // actions forward; turning it on makes successive presses alternate
      // forward/undone instead.
      // `facing`: purely cosmetic rotation (like SPIKE's), doesn't move the
      // activation hitbox — see engine.js's render case.
      base.props = { actions: [], loop: false, reversible: false, facing: 'up', ...defaultActivationProps(type) };
      break;
    case ENTITY_TYPES.PLATE:
      base.w = 1; base.h = 1;
      // `pressMode` ('once'|'hold'|'loop') governs the *press*-side actions
      // above — `loop` is kept in sync with it (true iff pressMode==='loop')
      // purely so the shared "∞" badge-drawing code (editor.js/engine.js,
      // also used by TRIGGER/BUTTON) keeps working without special-casing
      // PLATE. `releaseActions`/`closeOnRelease` are a second, independent
      // action list that fires once, forward only, when the activator
      // leaves the plate — see engine.js's _firePlateRelease.
      base.props = {
        actions: [], loop: false, reversible: false, facing: 'up',
        pressMode: 'hold', releaseActions: [], closeOnRelease: false,
        ...defaultActivationProps(type),
      };
      break;
    case ENTITY_TYPES.CRATE:
      // Same footprint as a block by default; freely resizable (a bigger
      // crate is just heavier-looking, physics-wise it behaves the same).
      base.w = 1; base.h = 1;
      // `gravity`: signed per-crate multiplier on top of the world's own
      // gravityScale (see engine.js's _updateCrates) — 1 = falls normally,
      // negative floats it upward instead, 0 = unaffected by gravity.
      // `pushDifficulty`: 1 = normal push resistance; higher = harder to
      // shove (see engine.js's _pushCrates).
      base.props = { gravity: 1, pushDifficulty: 1 };
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
    // A PLATE's separate "on release" list is its own action list, targeting
    // entities the exact same way — same cleanup applies to it.
    if (ent.type === ENTITY_TYPES.PLATE && ent.props && ent.props.releaseActions) {
      ent.props.releaseActions = ent.props.releaseActions.filter(a => a.targetId !== id);
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
  if (!level.entities.some(e => e.type === ENTITY_TYPES.BLOCK)) {
    errors.push('Ajoute au moins un bloc pour servir de support au joueur.');
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
//   - the standalone "moving platform" entity type ('platform') is gone —
//     BLOCK is now freely resizable and was already a valid moveElement/
//     teleport target, so it does everything a platform did. Any old
//     'platform' entity becomes a BLOCK, keeping its position/size/toggles;
//     its platform-only appearance props (style/color) are dropped since a
//     migrated block always renders as a normal solid block.
export function normalizeLevel(rawLevel) {
  const level = { ...createEmptyLevel(), ...rawLevel };
  level.entities = (level.entities || [])
    .filter((e) => e.type !== 'decor')
    .map((e) => {
      const legacyState = typeof e.state === 'string' ? e.state : null;
      const out = {
        id: e.id || uid('ent'),
        type: e.type === 'platform' ? ENTITY_TYPES.BLOCK : e.type,
        x: e.x ?? 0,
        y: e.y ?? 0,
        w: e.w ?? 1,
        h: e.h ?? 1,
        passable: e.passable ?? (legacyState === 'passable'),
        invisible: e.invisible ?? (legacyState === 'invisible'),
        harmless: e.harmless ?? (legacyState === 'harmless'),
        deadly: !!e.deadly,
        layer: clampLayer(e.layer ?? 0),
        props: e.type === 'platform' ? {} : (e.props || {}),
      };
      return out;
    });
  for (const e of level.entities) {
    if (e.type === ENTITY_TYPES.SPIKE || e.type === ENTITY_TYPES.BUTTON || e.type === ENTITY_TYPES.PLATE) {
      // Purely cosmetic rotation — 'up' is the identity orientation, so
      // backfilling it for older saved levels reproduces their existing
      // appearance exactly (see engine.js's render cases / _facingAngle).
      e.props.facing = e.props.facing || 'up';
    }
    if (e.type === ENTITY_TYPES.SPINNER) {
      e.props.direction = e.props.direction === 'ccw' ? 'ccw' : 'cw';
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
    if (e.type === ENTITY_TYPES.CRATE) {
      // `gravity` is deliberately allowed to be negative ("accepte la
      // negation") — that's what lets a specific crate float upward instead
      // of falling. Clamped to a sane range, same order of magnitude as the
      // world's own gravityScale, so a typo/import doesn't produce absurd
      // physics.
      const g = Number(e.props.gravity);
      e.props.gravity = Number.isFinite(g) ? Math.max(-5, Math.min(5, g)) : 1;
      const pd = Number(e.props.pushDifficulty);
      e.props.pushDifficulty = Number.isFinite(pd) ? Math.max(0.1, Math.min(10, pd)) : 1;
    }
    if (e.type === ENTITY_TYPES.TRIGGER || e.type === ENTITY_TYPES.PLATE) {
      e.props.loop = !!e.props.loop;
      delete e.props.mode; delete e.props.loopInterval; // old firing-mode concept, gone
    }
    if (e.type === ENTITY_TYPES.BUTTON) {
      e.props.loop = !!e.props.loop;
      delete e.props.mode; delete e.props.loopInterval; delete e.props.cooldown; delete e.props.resetAfterActions;
    }
    if (e.type === ENTITY_TYPES.BUTTON || e.type === ENTITY_TYPES.PLATE) {
      // "reversible" is opt-in (default off): only when explicitly enabled
      // does a button/plate alternate forward/reverse on successive
      // activations (see engine.js's _fireTrigger) — otherwise it always
      // plays its actions forward, every time.
      e.props.reversible = !!e.props.reversible;
    }
    if (e.type === ENTITY_TYPES.PLATE) {
      // `pressMode` is new; older saved levels only have the `loop`
      // boolean, which this derives from exactly (so an old plate's press
      // behavior is completely unchanged: loop:true -> 'loop', otherwise
      // the pre-existing "repeat while held" -> 'hold'). Once set, `loop`
      // is kept mirroring it going forward (see createEntity's PLATE case).
      e.props.pressMode = PLATE_PRESS_MODES.includes(e.props.pressMode)
        ? e.props.pressMode
        : (e.props.loop ? 'loop' : 'hold');
      e.props.loop = e.props.pressMode === 'loop';
      e.props.closeOnRelease = !!e.props.closeOnRelease;
      // A lightweight normalization (not the full legacy-migration pass
      // below, which handles concepts — old dx/dy, old player actions —
      // that never existed for this brand-new field) so hand-edited or
      // imported JSON can't crash the engine/editor.
      e.props.releaseActions = Array.isArray(e.props.releaseActions)
        ? e.props.releaseActions.filter((a) => a && a.type).map((a) => ({
          id: a.id || uid('act'),
          type: a.type,
          delay: Math.max(0, Number(a.delay) || 0),
          targetId: a.targetId ?? null,
          params: { ...(a.params || {}) },
        }))
        : [];
    }
    if (hasActionList(e)) {
      // Extended activation params (see level-model.js's
      // defaultActivationProps / engine.js's _activate & friends). Backfilled
      // here so older saved levels (missing these fields entirely) pick up
      // the exact-same-as-before defaults rather than crashing or silently
      // behaving like `undefined`.
      const d = defaultActivationProps(e.type);
      e.props.releaseMode = RELEASE_MODES.includes(e.props.releaseMode) ? e.props.releaseMode : d.releaseMode;
      e.props.releaseGrace = Math.max(0, Number(e.props.releaseGrace) || 0);
      e.props.activationDelay = Math.max(0, Number(e.props.activationDelay) || 0);
      e.props.sequential = !!e.props.sequential;
      e.props.activator = ACTIVATOR_MODES.includes(e.props.activator) ? e.props.activator : d.activator;
      e.props.maxRepeats = Math.max(0, Math.round(Number(e.props.maxRepeats) || 0));
      e.props.rearmCooldown = Math.max(0, Number(e.props.rearmCooldown) || 0);
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
          // neither player can be a moveElement target (that's the
          // teleporter's job now) — detarget rather than crash on old data
          if (targetId === 'player' || targetId === 'player2') targetId = null;
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
  // "2 joueurs" (see engine.js's this.players): playerStart2 is null on an
  // ordinary single-player level (the default — "1 seul [joueur] est
  // possible" is always valid), and a full spawn record just like
  // playerStart once the author turns the second player on.
  if (level.playerStart2 && typeof level.playerStart2 === 'object') {
    level.playerStart2 = {
      x: level.playerStart2.x ?? 1, y: level.playerStart2.y ?? 1,
      gravityDir: level.playerStart2.gravityDir || 'down',
      invisible: !!level.playerStart2.invisible,
    };
  } else {
    level.playerStart2 = null;
  }
  level.gravityScale = Number.isFinite(level.gravityScale) ? level.gravityScale : 1;
  level.background = level.background || '#1b1e2b';
  level.ceilingJumpGlitch = !!level.ceilingJumpGlitch;
  return level;
}

export function deserializeLevel(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  return normalizeLevel(raw);
}
