// A hand-built demo level that shows off every mechanic: gravity flip,
// control inversion (troll), a chained/sequential moving platform, a spring,
// a spike wall, a spinning hazard, a checkpoint and the goal.
import { ENTITY_TYPES, TRIGGER_MODES, ACTION_TYPES } from './constants.js';
import { createEmptyLevel, createEntity, createAction } from './level-model.js';

export function buildSampleLevel() {
  const level = createEmptyLevel('Démo : le couloir infernal');
  level.author = 'Level Devil';
  level.cols = 36;
  level.rows = 14;
  level.playerStart = { x: 1, y: 11 };

  const add = (type, x, y, overrides) => {
    const e = createEntity(type, x, y, overrides);
    level.entities.push(e);
    return e;
  };

  // NB : le sol est un bloc plein posé sur la ligne 13. Le joueur (haut ~0.7
  // case) se tient donc, en marchant, avec sa boîte de collision sur la
  // ligne 12 (juste au-dessus du sol) — c'est là qu'il faut placer tout ce
  // qui doit être "touché" en marchant normalement (ressort, checkpoint,
  // trigger au sol, but…), exactement comme les pointes.

  // --- Floor A : départ, ressort, mur de pointes -----------------------
  add(ENTITY_TYPES.BLOCK, 0, 13, { w: 18 });
  add(ENTITY_TYPES.SPRING, 8, 12, { props: { direction: 'up', power: 1.6 } });
  add(ENTITY_TYPES.SPIKE, 9, 10);
  add(ENTITY_TYPES.SPIKE, 9, 11);
  add(ENTITY_TYPES.SPIKE, 9, 12);

  // --- Plateforme mobile qui traverse la fosse --------------------------
  const platform = add(ENTITY_TYPES.PLATFORM, 17, 9, { w: 2 });
  add(ENTITY_TYPES.TRIGGER, 16, 12, {
    props: {
      mode: TRIGGER_MODES.ONCE,
      actions: [
        createAction(ACTION_TYPES.MOVE_ELEMENT, { targetId: platform.id, delay: 0, params: { dx: 0, dy: 4, duration: 0.6 } }),
        createAction(ACTION_TYPES.MOVE_ELEMENT, { targetId: platform.id, delay: 0.7, params: { dx: 6, dy: 0, duration: 2.0 } }),
      ],
    },
  });
  // fosse : colonnes 18 à 23 → aucun sol (mortel si on tombe dedans)

  // --- Floor B : gravité, troll, spinner, goal ---------------------------
  add(ENTITY_TYPES.BLOCK, 24, 13, { w: 12 });
  add(ENTITY_TYPES.CHECKPOINT, 24, 12);

  add(ENTITY_TYPES.TRIGGER, 26, 12, {
    props: { mode: TRIGGER_MODES.ONCE, actions: [
      createAction(ACTION_TYPES.SET_GRAVITY, { targetId: 'player', delay: 0, params: { direction: 'up' } }),
    ] },
  });
  add(ENTITY_TYPES.BLOCK, 26, 2, { w: 6 });
  // Ici le joueur est "collé" au plafond : sa boîte de collision est sur la
  // ligne 3 (juste sous le plafond posé en ligne 2).
  add(ENTITY_TYPES.TRIGGER, 30, 3, {
    props: { mode: TRIGGER_MODES.ONCE, actions: [
      createAction(ACTION_TYPES.SET_GRAVITY, { targetId: 'player', delay: 0, params: { direction: 'down' } }),
    ] },
  });

  add(ENTITY_TYPES.TRIGGER, 32, 12, {
    props: { mode: TRIGGER_MODES.ONCE, actions: [
      createAction(ACTION_TYPES.INVERT_CONTROLS, { targetId: 'player', delay: 0, params: { axis: 'horizontal', enabled: true, duration: 4 } }),
    ] },
  });
  add(ENTITY_TYPES.SPINNER, 33, 12, { props: { speed: 2.4, radius: 0.9 } });

  add(ENTITY_TYPES.GOAL, 35, 12);

  return level;
}
