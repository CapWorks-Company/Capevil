// A hand-built demo level that shows off every mechanic: gravity flip,
// control inversion (troll), a chained/sequential moving platform, a spring,
// oriented spikes, an invisible-but-solid block, a wind fan, a looping
// platform, linked teleporters, a spinning hazard, a checkpoint and the goal.
import { ENTITY_TYPES, TRIGGER_MODES, ACTION_TYPES } from './constants.js';
import { createEmptyLevel, createEntity, createAction } from './level-model.js';

export function buildSampleLevel() {
  const level = createEmptyLevel('Démo : le couloir infernal');
  level.author = 'Level Devil';
  level.cols = 50;
  level.rows = 14;
  level.editBounds = { colMin: 0, colMax: level.cols - 1, rowMin: 0, rowMax: level.rows - 1 };
  level.playerStart = { x: 1, y: 11 };

  const add = (type, x, y, overrides) => {
    const e = createEntity(type, x, y, overrides, level);
    level.entities.push(e);
    return e;
  };

  // NB : le sol est un bloc plein posé sur la ligne 13. Le joueur (haut ~0.7
  // case) se tient donc, en marchant, avec sa boîte de collision sur la
  // ligne 12 (juste au-dessus du sol) — c'est là qu'il faut placer tout ce
  // qui doit être "touché" en marchant normalement (ressort, checkpoint,
  // trigger au sol, but…), exactement comme les pointes.

  // --- Floor A : départ, ressort, pointes orientées ---------------------
  add(ENTITY_TYPES.BLOCK, 0, 13, { w: 18 });
  add(ENTITY_TYPES.SPRING, 8, 12, { props: { direction: 'up', power: 1.6 } });
  add(ENTITY_TYPES.SPIKE, 9, 10, { props: { facing: 'up' } });
  add(ENTITY_TYPES.SPIKE, 9, 11, { props: { facing: 'up' } });
  add(ENTITY_TYPES.SPIKE, 9, 12, { props: { facing: 'up' } });
  // pointes au plafond, pointant vers le bas
  add(ENTITY_TYPES.BLOCK, 12, 8, { w: 3 });
  add(ENTITY_TYPES.SPIKE, 12, 9, { w: 3, props: { facing: 'down' } });

  // Bloc invisible mais bien solide : on ne le voit pas, mais on peut monter
  // dessus (illustre le toggle "invisible" — différent de "traversable").
  add(ENTITY_TYPES.BLOCK, 15, 11, { invisible: true });

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

  // --- Floor B : gravité, troll, spinner, ventilateur --------------------
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

  // Ventilateur : pousse le joueur vers la droite au-dessus d'une petite fosse.
  add(ENTITY_TYPES.BLOCK, 35, 13);
  add(ENTITY_TYPES.FAN, 36, 9, { h: 4, props: { direction: 'right', force: 1.3 } });
  // fosse colonnes 36-38 sous le ventilateur

  // --- Floor C : plateforme en boucle, téléporteurs, arrivée --------------
  add(ENTITY_TYPES.BLOCK, 39, 13, { w: 11 });

  // Plateforme qui boucle toute seule : gauche 3 cases, pause, retour, pause…
  const loopPlat = add(ENTITY_TYPES.PLATFORM, 41, 11);
  add(ENTITY_TYPES.TRIGGER, 40, 12, {
    props: {
      mode: TRIGGER_MODES.LOOP,
      loopInterval: 4,
      actions: [
        createAction(ACTION_TYPES.MOVE_ELEMENT, { targetId: loopPlat.id, delay: 0, params: { dx: 0, dy: -3, duration: 0.8 } }),
        createAction(ACTION_TYPES.MOVE_ELEMENT, { targetId: loopPlat.id, delay: 1.8, params: { dx: 0, dy: 3, duration: 0.8 } }),
      ],
    },
  });

  // Deux téléporteurs liés par la même fréquence.
  add(ENTITY_TYPES.TELEPORTER, 43, 12, { props: { frequency: 1, oneUse: false } });
  add(ENTITY_TYPES.TELEPORTER, 47, 12, { props: { frequency: 1, oneUse: false } });

  add(ENTITY_TYPES.GOAL, 48, 12);

  return level;
}
