// A hand-built demo level that shows off every mechanic: gravity flip,
// control inversion (troll), a chained/sequential moving platform, a spring,
// oriented spikes, an invisible-but-solid block, a wind fan, a looping
// platform, linked teleporters, a spinning hazard, a checkpoint and the goal.
import { ENTITY_TYPES, ACTION_TYPES } from './constants.js';
import { createEmptyLevel, createEntity, createAction } from './level-model.js';

export function buildSampleLevel() {
  const level = createEmptyLevel('Démo : le couloir infernal');
  level.author = 'Capevil';
  level.cols = 50;
  level.rows = 14;
  // Keep the spawn's own state (gravity/visibility) that createEmptyLevel
  // already set up — only move it, don't replace the whole object.
  level.playerStart.x = 1;
  level.playerStart.y = 11;

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
  // Le sol est maintenant assemblé case par case (les blocs solides ne se
  // redimensionnent plus) : les cellules adjacentes se rendent sans jointure.
  for (let i = 0; i < 18; i++) add(ENTITY_TYPES.BLOCK, i, 13);
  add(ENTITY_TYPES.SPRING, 8, 12, { props: { direction: 'up', power: 1.6 } });
  add(ENTITY_TYPES.SPIKE, 9, 10, { props: { facing: 'up' } });
  add(ENTITY_TYPES.SPIKE, 9, 11, { props: { facing: 'up' } });
  add(ENTITY_TYPES.SPIKE, 9, 12, { props: { facing: 'up' } });
  // pointes au plafond, pointant vers le bas
  for (let i = 0; i < 3; i++) add(ENTITY_TYPES.BLOCK, 12 + i, 8);
  add(ENTITY_TYPES.SPIKE, 12, 9, { w: 3, props: { facing: 'down' } });

  // Bloc invisible mais bien solide : on ne le voit pas, mais on peut monter
  // dessus (illustre le toggle "invisible" — différent de "traversable").
  add(ENTITY_TYPES.BLOCK, 15, 11, { invisible: true });

  // --- Plateforme mobile qui traverse la fosse --------------------------
  // Un simple bloc solide déplacé par des actions : n'importe quel bloc peut
  // servir de plateforme mobile, plus besoin d'un type d'élément séparé.
  const platform = add(ENTITY_TYPES.BLOCK, 17, 9, { w: 2 });
  add(ENTITY_TYPES.TRIGGER, 16, 12, {
    props: {
      actions: [
        // Axe Y : +1 monte, -1 descend (l'inverse de dy en pixels-écran).
        createAction(ACTION_TYPES.MOVE_ELEMENT, { targetId: platform.id, delay: 0, params: { axisX: 0, axisY: -4, duration: 0.6 } }),
        createAction(ACTION_TYPES.MOVE_ELEMENT, { targetId: platform.id, delay: 0.7, params: { axisX: 6, axisY: 0, duration: 2.0 } }),
      ],
    },
  });
  // fosse : colonnes 18 à 23 → aucun sol (mortel si on tombe dedans)

  // --- Floor B : gravité, troll, spinner, ventilateur --------------------
  for (let i = 0; i < 12; i++) add(ENTITY_TYPES.BLOCK, 24 + i, 13);
  add(ENTITY_TYPES.CHECKPOINT, 24, 12);

  add(ENTITY_TYPES.TRIGGER, 26, 12, {
    props: { actions: [
      createAction(ACTION_TYPES.SET_PLAYER_STATE, { delay: 0, params: { gravity: 'up' } }),
    ] },
  });
  for (let i = 0; i < 6; i++) add(ENTITY_TYPES.BLOCK, 26 + i, 2);
  // Ici le joueur est "collé" au plafond : sa boîte de collision est sur la
  // ligne 3 (juste sous le plafond posé en ligne 2).
  add(ENTITY_TYPES.TRIGGER, 30, 3, {
    props: { actions: [
      createAction(ACTION_TYPES.SET_PLAYER_STATE, { delay: 0, params: { gravity: 'down' } }),
    ] },
  });

  add(ENTITY_TYPES.TRIGGER, 32, 12, {
    props: { actions: [
      createAction(ACTION_TYPES.SET_PLAYER_STATE, { delay: 0, params: { invert: 'horizontal', invertDuration: 4 } }),
    ] },
  });
  add(ENTITY_TYPES.SPINNER, 33, 12, { props: { speed: 2.4, radius: 0.9 } });

  // Ventilateur : pousse le joueur vers la droite au-dessus d'une petite fosse.
  add(ENTITY_TYPES.BLOCK, 35, 13);
  add(ENTITY_TYPES.FAN, 36, 9, { h: 4, props: { direction: 'right', force: 1.3 } });
  // fosse colonnes 36-38 sous le ventilateur

  // --- Floor C : plateforme en boucle, bouton, plaque, téléporteurs, arrivée --
  for (let i = 0; i < 11; i++) add(ENTITY_TYPES.BLOCK, 39 + i, 13);

  // Plateforme qui boucle toute seule : monte, redescend, et recommence — la
  // case "Boucle infinie" du trigger se charge de tout relancer elle-même.
  const loopPlat = add(ENTITY_TYPES.BLOCK, 41, 11);
  add(ENTITY_TYPES.TRIGGER, 40, 12, {
    props: {
      loop: true,
      actions: [
        createAction(ACTION_TYPES.MOVE_ELEMENT, { targetId: loopPlat.id, delay: 0, params: { axisX: 0, axisY: 3, duration: 0.8 } }),
        createAction(ACTION_TYPES.MOVE_ELEMENT, { targetId: loopPlat.id, delay: 1.8, params: { axisX: 0, axisY: -3, duration: 0.8 } }),
      ],
    },
  });

  // Deux téléporteurs liés par la même fréquence.
  add(ENTITY_TYPES.TELEPORTER, 43, 12, { props: { frequency: 1, oneUse: false } });
  add(ENTITY_TYPES.TELEPORTER, 47, 12, { props: { frequency: 1, oneUse: false } });

  add(ENTITY_TYPES.GOAL, 48, 12);

  return level;
}
