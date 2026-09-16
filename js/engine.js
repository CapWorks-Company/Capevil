// Core game engine: physics, collisions, triggers, rendering.
// Framework-free, canvas 2D. Designed to be driven by game.js (play mode)
// and reused (read-only, no input) by editor.js for in-editor testing.
import {
  CELL, ENTITY_TYPES, HAZARD_TYPES, SOLID_TYPES,
  GRAVITY_VECTORS, OPPOSITE_GRAVITY_DIR, ACTION_TYPES, PHYSICS,
} from './constants.js';
import { loadKeybinds, buildKeyMap } from './keybindings.js';
import { sfx, unlockAudio } from './audio-fx.js';
import { ParticleSystem } from './particles.js';

// Cheap ease-in-out used purely for the goal door's leaf motion (see the
// GOAL render case) — real doors accelerate off their rest position and
// decelerate into the seal instead of gliding at one constant speed the
// whole way. Doesn't touch `doorProgress` itself (that stays linear — it's
// what drives winLevel()'s timing), only how it's mapped for drawing.
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class Engine {
  constructor(canvas, level, { onDeath, onWin, onStateChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.level = level;
    this.onDeath = onDeath || (() => {});
    this.onWin = onWin || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.raw = { left: false, right: false, up: false, down: false, jump: false };
    // Player 2's own input state/keymap (see constants around "2 joueurs" —
    // level-model.js's playerStart2) — always built, even for a single-player
    // level, since it's cheap and keeps the two players perfectly symmetric;
    // it simply never gets used when this.player2 stays null (see
    // _resetPlayer).
    this.raw2 = { left: false, right: false, up: false, down: false, jump: false };
    this.debugTriggers = false;
    this.keymap = buildKeyMap(loadKeybinds(1));
    this.keymap2 = buildKeyMap(loadKeybinds(2));
    this.particles = new ParticleSystem();
    this.shake = { magnitude: 0, duration: 0, time: 0 }; // camera shake, see _triggerShake
    this._keydown = (e) => {
      unlockAudio();
      // Prevent the browser's own reaction to game keys — Space/arrows
      // scrolling the page, or Space re-clicking whatever toolbar button
      // last had focus (e.g. the mute or keybind button) — without
      // swallowing keystrokes while the player is actually typing somewhere.
      const tag = (e.target && e.target.tagName) || '';
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && (this.keymap[e.code] || this.keymap2[e.code])) e.preventDefault();
      this._setKey(e.code, true);
    };
    this._keyup = (e) => this._setKey(e.code, false);
    this._onKeybindsChanged = () => { this.keymap = buildKeyMap(loadKeybinds(1)); this.keymap2 = buildKeyMap(loadKeybinds(2)); };
    window.addEventListener('keydown', this._keydown);
    window.addEventListener('keyup', this._keyup);
    window.addEventListener('capevil:keybinds-changed', this._onKeybindsChanged);
    this.reset();
  }

  destroy() {
    window.removeEventListener('keydown', this._keydown);
    window.removeEventListener('keyup', this._keyup);
    window.removeEventListener('capevil:keybinds-changed', this._onKeybindsChanged);
    cancelAnimationFrame(this._raf);
  }

  // A single physical key can drive player 1 and/or player 2 independently
  // (their keymaps are entirely separate — see keybindings.js), so both are
  // checked on every key event rather than picking just one.
  _setKey(code, val) {
    const k1 = this.keymap[code];
    if (k1) { this.raw[k1] = val; if (val) this._lastJumpPress = k1 === 'jump' ? performance.now() : this._lastJumpPress; }
    const k2 = this.keymap2[code];
    if (k2) this.raw2[k2] = val;
  }

  // Full reset: used both on first load and every time the player dies, so a
  // death always puts the whole level back exactly how it was (triggers can
  // fire again, moved platforms go back to their start, states/gravity/troll
  // effects are cleared) — only the checkpoint respawn point survives.
  reset() {
    const lvl = this.level;
    this.deaths = this.deaths || 0;
    this.simTime = 0;
    this.won = false;
    this.dead = false;
    this.finishing = false; // true while the goal door is playing its closing animation
    this._hidePlayerForDoor = false;
    this.respawn = { x: lvl.playerStart.x, y: lvl.playerStart.y };
    // The world's AUTHORED gravity/background — SET_WORLD_STATE can change
    // these live, and a button/plate's "reverse" pass needs to know what to
    // restore them to (see _runAction/SET_WORLD_STATE and _reverseAction).
    this._authoredGravityScale = Number.isFinite(lvl.gravityScale) ? lvl.gravityScale : 1;
    this._authoredBackground = lvl.background || '#1b1e2b';
    this._buildRuntime();
    this._resetPlayer();
    this.scheduled = []; // [{time, run}]
    this._teleportCooldown = 0;
    // Single-player levels use `camera` alone. A 2-player level splits the
    // canvas in half and drives `camera1`/`camera2` independently (see
    // _updateCamera/render) — `camera` is kept in sync with `camera1` too, so
    // any old code that only knows about a single camera still works.
    this.camera = { x: 0, y: 0 };
    this.camera1 = { x: 0, y: 0 };
    this.camera2 = { x: 0, y: 0 };
    this.particles.clear();
    this.shake = { magnitude: 0, duration: 0, time: 0 };
    this.onStateChange({ deaths: this.deaths });
  }

  _buildRuntime() {
    this.runtime = new Map();
    for (const ent of this.level.entities) {
      this.runtime.set(ent.id, {
        def: ent,
        x: ent.x * CELL, y: ent.y * CELL,
        passable: !!ent.passable, invisible: !!ent.invisible, harmless: !!ent.harmless, deadly: !!ent.deadly,
        facing: (ent.props && ent.props.facing) || 'up', // runtime-only so SET_STATE can rotate it without touching the authored def
        anim: null, // { fromX,fromY,toX,toY,startTime,duration }
        dx: 0, dy: 0, // this-frame movement delta, for carrying the player along
        angle: 0,
        wasOverlapping: false,
        activated: false,
        usedOnce: false,
        // trigger/button/plate scheduling state
        looping: false,     // a "boucle infinie" cycle is currently running
        holding: false,     // (plate only) the player is currently on it, auto-repeating
        buttonReady: true,  // (button only) can be pressed again
        awaitingReset: false, // (button, resetAfterActions:'onNextPress') next press reverts instead of firing
        reversed: false,    // (button/plate only) next activation replays its actions undone instead of forward
        // extended trigger/button/plate activation state — see _activate/
        // _canActivate/_graceOverlap/_fireTrigger for how each is used
        disabled: false,     // permanently closed (releaseMode:'finishAndClose', or maxRepeats reached)
        repeatCount: 0,      // how many times this has fired so far (maxRepeats)
        cooldownUntil: 0,    // simTime before which it can't fire again (rearmCooldown)
        graceUntil: 0,       // simTime until which a real release is still forgiven (releaseGrace)
        activationToken: 0,  // bumped each time a fresh overlap starts, to cancel a stale pending activationDelay
        // goal-door animation state
        closing: false,
        closeStart: 0,
        doorProgress: 0,
        sealed: false, // set once, the instant the door fully seals — see _updateDoors
        // (fan only) fixed-rate ambient/push wind-particle emitters — see _applyFans
        windAccum: 0,
        pushWindAccum: 0,
        // (crate only) vertical fall velocity — see _updateCrates
        vy: 0,
      });
    }
  }

  _makePlayer(ps, respawnPt) {
    const player = {
      x: respawnPt.x * CELL, y: respawnPt.y * CELL,
      w: CELL * 0.7, h: CELL * 0.7,
      vx: 0, vy: 0,
      gravityDir: ps.gravityDir || 'down',
      invisible: !!ps.invisible,
      invert: { horizontal: false, vertical: false },
      jumpMult: 1, speedMult: 1,
      onGround: false,
      facing: 1,
      windVx: 0, windVy: 0, // persistent push from FAN zones, layered on top of input-driven velocity
      ridingId: null, // id of the solid currently carrying the player — see _updatePhysics's carry step
    };
    // center the smaller hitbox inside its cell
    player.x += (CELL - player.w) / 2;
    player.y += (CELL - player.h) / 2;
    return player;
  }

  // Builds player 1 always, and player 2 only when the level enables a
  // second player (lvl.playerStart2 set — see level-model.js). Player 2
  // always respawns at the same authored OFFSET from player 1's spawn, even
  // after a checkpoint moves the shared respawn anchor (`this.respawn`) —
  // so a checkpoint doesn't need its own separate tracking per player, and
  // the two players keep their relative formation across respawns.
  _resetPlayer() {
    const lvl = this.level;
    const ps = lvl.playerStart || {};
    this.player = this._makePlayer(ps, this.respawn);
    if (lvl.playerStart2) {
      const ps2 = lvl.playerStart2;
      const dx = ps2.x - ps.x, dy = ps2.y - ps.y;
      this.player2 = this._makePlayer(ps2, { x: this.respawn.x + dx, y: this.respawn.y + dy });
    } else {
      this.player2 = null;
    }
    // Every per-player system (physics, fans, hazards, camera…) just loops
    // over this array — it has one entry in a single-player level, two once
    // playerStart2 is set, and nothing else needs to special-case the count.
    this.players = this.player2 ? [this.player, this.player2] : [this.player];
  }

  // Puts every runtime entity back to its authored definition (position,
  // toggles, animation) and clears trigger/scheduled-action state, without
  // touching `this.respawn` (checkpoints must survive a death).
  _resetRuntimeState() {
    this.scheduled = [];
    this._teleportCooldown = 0;
    this.finishing = false;
    this.level.gravityScale = this._authoredGravityScale;
    this.level.background = this._authoredBackground;
    for (const rt of this.runtime.values()) {
      const def = rt.def;
      rt.x = def.x * CELL; rt.y = def.y * CELL;
      rt.passable = !!def.passable; rt.invisible = !!def.invisible; rt.harmless = !!def.harmless; rt.deadly = !!def.deadly;
      rt.facing = (def.props && def.props.facing) || 'up';
      rt.anim = null; rt.dx = 0; rt.dy = 0; rt.angle = 0;
      rt.wasOverlapping = false; rt.usedOnce = false;
      rt.looping = false; rt.holding = false; rt.buttonReady = true; rt.awaitingReset = false; rt.reversed = false;
      rt.closing = false; rt.closeStart = 0; rt.doorProgress = 0; rt.sealed = false;
      rt.vy = 0;
      rt.disabled = false; rt.repeatCount = 0; rt.cooldownUntil = 0; rt.graceUntil = 0; rt.activationToken = 0;
      if (def.type !== ENTITY_TYPES.CHECKPOINT) rt.activated = false;
    }
  }

  start() {
    this._last = performance.now();
    const loop = (t) => {
      const dt = Math.min((t - this._last) / 1000, 1 / 30);
      this._last = t;
      if (!this.dead && !this.won) this.update(dt);
      // Cosmetic-only systems (death burst, confetti, camera shake) keep
      // animating through the death-freeze / win state, even though gameplay
      // itself is paused above — otherwise a death burst would freeze
      // mid-air for the whole respawn delay.
      this._updateCosmetics(dt);
      this.render();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _updateCosmetics(dt) {
    this.particles.update(dt);
    if (this.shake.time > 0) this.shake.time = Math.max(0, this.shake.time - dt);
  }

  // Triggers a short, decaying camera shake — used automatically on death.
  _triggerShake(magnitude = 10, duration = 0.3) {
    this.shake = { magnitude, duration: Math.max(0.05, duration), time: Math.max(0.05, duration) };
  }

  stop() { cancelAnimationFrame(this._raf); }

  // ---- effective input, accounting for troll inversion ----
  // `p` selects which player's raw input/keymap to read — player 2's is
  // entirely separate from player 1's (see the constructor / keybindings.js).
  _input(p = this.player) {
    const raw = p === this.player2 ? this.raw2 : this.raw;
    let { left, right, up, down, jump } = raw;
    if (p.invert.horizontal) [left, right] = [right, left];
    if (p.invert.vertical) [up, down] = [down, up];
    return { left, right, up, down, jump };
  }

  // A death always resets the WHOLE level (both players, all triggers) —
  // see the class-level comment on reset(). `p` is only used to anchor the
  // death burst at whichever player actually died.
  killPlayer(p = this.player) {
    if (this.dead) return;
    this.dead = true;
    this.deaths++;
    sfx.death();
    this.particles.deathBurst(p.x + p.w / 2, p.y + p.h / 2);
    this._triggerShake(10, 0.35);
    this.onStateChange({ deaths: this.deaths });
    this.onDeath();
    setTimeout(() => {
      this.dead = false;
      this._resetRuntimeState();
      this._resetPlayer();
    }, 450);
  }

  winLevel(p = this.player) {
    if (this.won) return;
    this.won = true;
    sfx.win();
    this.particles.confetti(p.x + p.w / 2, p.y + p.h / 2);
    this.onWin({ deaths: this.deaths });
  }

  // Touching the goal doesn't win instantly: the player is pulled inside the
  // doorway (and hidden — "téléporté dedans"), the door slides shut over
  // DOOR_CLOSE_DURATION, and only once it's fully closed does the level
  // actually count as won. Gameplay (input/physics/triggers) is frozen for
  // the whole animation via the `finishing` flag checked in update(). On a
  // 2-player level, whichever player reaches the goal first triggers the
  // close — BOTH players are pulled inside and finish together.
  _startDoorClose(rt, box) {
    this.finishing = true;
    rt.closing = true;
    rt.closeStart = this.simTime;
    for (const p of this.players) {
      p.vx = 0; p.vy = 0;
      p.x = rt.x + box.w / 2 - p.w / 2;
      p.y = rt.y + box.h / 2 - p.h / 2;
    }
    this._hidePlayerForDoor = true;
    sfx.teleport();
  }

  _updateDoors() {
    if (!this.finishing) return;
    const DOOR_CLOSE_DURATION = 0.6;
    for (const rt of this.runtime.values()) {
      if (rt.def.type !== ENTITY_TYPES.GOAL || !rt.closing) continue;
      const t = Math.min(1, (this.simTime - rt.closeStart) / DOOR_CLOSE_DURATION);
      rt.doorProgress = t;
      if (t >= 1 && !rt.sealed) {
        // The mechanical "clunk" as the two leaves meet and the bolt drives
        // home — fires exactly once, a beat before winLevel()'s own fanfare.
        rt.sealed = true;
        sfx.doorSeal();
        this._triggerShake(4, 0.18);
      }
      if (t >= 1) this.winLevel();
    }
  }

  // ---------------------------------------------------------------- update
  update(dt) {
    this.simTime += dt;
    if (this._teleportCooldown > 0) this._teleportCooldown -= dt;
    this._runScheduled();
    this._updateMovers(dt);
    // Once the player has touched the goal door, gameplay itself pauses —
    // no more input/physics/triggers — while the door finishes closing.
    if (!this.finishing) {
      this._applyFans(dt);
      this._updateCrates(dt);
      for (const p of this.players) this._updatePhysics(p, dt);
      this._checkTriggers();
      this._checkButtons();
      this._checkPlates();
      for (const p of this.players) this._checkHazardsAndGoal(p);
      this._checkTeleporters();
    }
    this._updateSpinnerAngles(dt);
    this._updateDoors();
    this._updateCamera();
  }

  _runScheduled() {
    if (!this.scheduled.length) return;
    const ready = this.scheduled.filter(s => s.time <= this.simTime);
    if (!ready.length) return;
    this.scheduled = this.scheduled.filter(s => s.time > this.simTime);
    for (const s of ready) s.run();
  }

  _updateMovers(dt) {
    for (const rt of this.runtime.values()) {
      if (!rt.anim) { rt.dx = 0; rt.dy = 0; continue; }
      const a = rt.anim;
      const prevX = rt.x, prevY = rt.y;
      const t = Math.min(1, (this.simTime - a.startTime) / a.duration);
      rt.x = a.fromX + (a.toX - a.fromX) * t;
      rt.y = a.fromY + (a.toY - a.fromY) * t;
      rt.dx = rt.x - prevX;
      rt.dy = rt.y - prevY;
      if (t >= 1) rt.anim = null;
    }
  }

  _updateSpinnerAngles(dt) {
    for (const rt of this.runtime.values()) {
      if (rt.def.type === ENTITY_TYPES.SPINNER) {
        const speed = (rt.def.props && rt.def.props.speed) || 2;
        // 'ccw' just flips the sign of the increment — same blades, same
        // math, spinning the other way around.
        const dir = (rt.def.props && rt.def.props.direction === 'ccw') ? -1 : 1;
        rt.angle += speed * dir * dt;
      }
    }
  }

  // Purely cosmetic rotation shared by entities with an asymmetric shape and
  // a `props.facing` (BUTTON, PLATE — mirrors SPIKE's own facing concept).
  // 'up' is the identity angle (0) on purpose: it's the default/backfilled
  // value, so older saved levels render pixel-identical to before this
  // feature existed.
  _facingAngle(facing) {
    return { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }[facing] || 0;
  }

  // Continuous wind push from FAN zones while the player is within range
  // (unlike a spring's one-shot impulse). The fan's own w/h only sets its
  // visual thickness; how *far* it reaches is the separate `range` property
  // (in cells, measured from the fan's own edge along the blow direction),
  // optionally fading out toward the edge of that range ("diminution avec la
  // distance") instead of pushing at full force right up to the cutoff.
  // Handles every player at once (rather than being called per-player) so
  // each fan's ambient wind stream is emitted exactly once per frame no
  // matter how many players there are — only the "does it push THIS player"
  // part below is repeated per player.
  _applyFans(dt) {
    const pushed = this.players.map(() => ({ x: false, y: false }));
    for (const rt of this.runtime.values()) {
      if (rt.def.type !== ENTITY_TYPES.FAN || rt.passable) continue;
      const props = rt.def.props || {};
      const dir = props.direction || 'right';
      const v = GRAVITY_VECTORS[dir];
      const range = Math.max(0, props.range ?? 5);
      const fanW = rt.def.w * CELL, fanH = rt.def.h * CELL;
      // Extend the hitbox by `range` cells, but only along the blow axis —
      // the perpendicular size stays exactly what was authored.
      let box = { x: rt.x, y: rt.y, w: fanW, h: fanH };
      if (v.x > 0) box.w += range * CELL;
      else if (v.x < 0) { box.x -= range * CELL; box.w += range * CELL; }
      else if (v.y > 0) box.h += range * CELL;
      else if (v.y < 0) { box.y -= range * CELL; box.h += range * CELL; }

      // Ambient wind: as long as the fan itself is visible, stream particles
      // drifting along its whole push corridor continuously — whether or not
      // the player happens to be standing in it right now — so a fan visibly
      // "blows" across the cells/blocks it affects at all times instead of
      // only showing an effect once in a while. This is a fixed-rate
      // accumulator (not a per-frame dice roll), so the stream never goes
      // quiet at low framerates or low `force` — it just spawns less often
      // per particle, always at a steady cadence. The rate itself still
      // scales with `force` (power) so a stronger fan reads as busier.
      if (!rt.invisible) {
        const ambientForce = props.force ?? 1;
        rt.windAccum = (rt.windAccum || 0) + dt * (3 + ambientForce * 5);
        while (rt.windAccum >= 1) {
          rt.windAccum -= 1;
          const px = box.x + Math.random() * box.w;
          const py = box.y + Math.random() * box.h;
          this.particles.wind(px, py, v, Math.min(2, ambientForce));
        }
      }

      for (let i = 0; i < this.players.length; i++) {
        const p = this.players[i];
        if (!this._overlap(p, box)) continue;

        let distCells = 0;
        if (v.x > 0) distCells = Math.max(0, (p.x - (rt.x + fanW)) / CELL);
        else if (v.x < 0) distCells = Math.max(0, (rt.x - (p.x + p.w)) / CELL);
        else if (v.y > 0) distCells = Math.max(0, (p.y - (rt.y + fanH)) / CELL);
        else if (v.y < 0) distCells = Math.max(0, (rt.y - (p.y + p.h)) / CELL);

        let strength = 1;
        if (props.falloff && range > 0) strength = Math.max(0, 1 - distCells / range);
        if (strength <= 0) continue;

        const force = (props.force ?? 1) * strength;
        const accel = PHYSICS.GRAVITY_ACCEL * force;
        const maxSpeed = PHYSICS.MOVE_SPEED * 1.8 * force;
        if (v.x) { pushed[i].x = true; p.windVx += v.x * accel * dt; p.windVx = Math.max(-maxSpeed, Math.min(maxSpeed, p.windVx)); }
        if (v.y) { pushed[i].y = true; p.windVy += v.y * accel * dt; p.windVy = Math.max(-maxSpeed, Math.min(maxSpeed, p.windVy)); }
        // Same fixed-rate accumulator as the ambient stream above, just
        // centered on the player while they're actually being pushed.
        rt.pushWindAccum = (rt.pushWindAccum || 0) + dt * 12 * Math.max(0.3, strength);
        while (rt.pushWindAccum >= 1) {
          rt.pushWindAccum -= 1;
          this.particles.wind(p.x + p.w / 2, p.y + p.h / 2, v, strength);
        }
      }
    }
    // decay back to zero once a player leaves every fan zone
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!pushed[i].x) p.windVx *= 0.8;
      if (!pushed[i].y) p.windVy *= 0.8;
      if (Math.abs(p.windVx) < 1) p.windVx = 0;
      if (Math.abs(p.windVy) < 1) p.windVy = 0;
    }
  }

  _solidRects() {
    const rects = [];
    for (const rt of this.runtime.values()) {
      const t = rt.def.type;
      if (rt.passable) continue; // invisible solids are still fully solid
      // A hazard (spike/spinner) marked "inoffensif" becomes a normal solid
      // obstacle — safe to touch and stand on — while a plain hazard stays
      // non-solid (you don't get stuck on a lethal spike, you just die).
      if (!SOLID_TYPES.has(t) && !(HAZARD_TYPES.has(t) && rt.harmless)) continue;
      // A block (or crate) marked "tueur" flips the same way in reverse: it
      // must stay non-solid so the player can actually overlap it (otherwise
      // normal collision would just push them out before death could ever
      // be detected) — _checkHazardsAndGoal is what kills them on that
      // overlap.
      if ((t === ENTITY_TYPES.BLOCK || t === ENTITY_TYPES.CRATE) && rt.deadly) continue;
      rects.push({ id: rt.def.id, x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL, dx: rt.dx || 0, dy: rt.dy || 0 });
    }
    return rects;
  }

  // Crates are pushable physics cubes — not action-targetable like a
  // trigger/button/plate, but they do carry their own toggles (traversable /
  // invisible / tueur) and a couple of numeric props (gravity, difficulté à
  // pousser). Runs BEFORE _updatePhysics each frame so a crate that fell (or
  // was left mid-air after a solid moved away) settles before the player's
  // own collision is resolved against it this same frame. Crates are already
  // in SOLID_TYPES, so the player-vs-crate side of this (walking into one,
  // standing on one) is handled for free by the existing generic
  // solid-collision code — this method only has to give the crate its own
  // falling motion.
  _updateCrates(dt) {
    const worldGravityScale = Number.isFinite(this.level.gravityScale) ? this.level.gravityScale : 1;
    const solids = this._solidRects(); // snapshot once — good enough for one frame of crate-vs-crate stacking
    for (const rt of this.runtime.values()) {
      if (rt.def.type !== ENTITY_TYPES.CRATE || rt.passable) continue;
      // A crate's own "gravité" (props.gravity, default 1, can be negative)
      // multiplies the world's gravityScale — either one being negative
      // (but not both) makes THIS crate float upward instead of falling,
      // independently of every other crate and of the player. `gy` is the
      // resulting effective fall direction along y (+1 normal, -1 flipped);
      // `gMag` is always non-negative so the accel/terminal-velocity math
      // below stays exactly the pre-existing (positive-only) formula, just
      // projected onto whichever direction actually applies this frame.
      const crateGravity = Number.isFinite(rt.def.props && rt.def.props.gravity) ? rt.def.props.gravity : 1;
      const totalScale = worldGravityScale * crateGravity;
      const gMag = Math.abs(totalScale);
      const gy = totalScale < 0 ? -1 : 1;
      const maxFall = PHYSICS.MAX_FALL_SPEED * gMag;
      rt.vy = (rt.vy || 0) + PHYSICS.GRAVITY_ACCEL * gy * gMag * dt;
      const fallSpeed = rt.vy * gy;
      if (fallSpeed > maxFall) rt.vy = maxFall * gy;
      const w = rt.def.w * CELL, h = rt.def.h * CELL;
      // Remembered so the swept check below can tell whether a solid's edge
      // was crossed THIS frame, not just whether the final position happens
      // to overlap it — see the comment there.
      const startY = rt.y;
      rt.y += rt.vy * dt;
      const box = { x: rt.x, y: rt.y, w, h };
      for (const r of solids) {
        if (r.id === rt.def.id) continue; // never collide with itself
        if (box.x + box.w <= r.x || box.x >= r.x + r.w) continue; // no horizontal overlap: irrelevant
        // Swept (continuous) check: a single frame's fall distance can be
        // larger than a solid's own thickness (a high "Condition du monde"
        // gravity multiplier makes this easy to hit even against an
        // ordinary 1-cell-thick block) — in that case the crate's box can
        // jump clean from "above" to "below" the solid without its FINAL
        // position ever overlapping it, so a plain end-of-frame overlap
        // test misses the collision entirely and the crate tunnels straight
        // through instead of landing on top of (or under) it. Comparing the
        // solid's edge against where the crate started and ended this frame
        // catches that crossing regardless of how far it moved.
        if (rt.vy > 0 && startY + h <= r.y && box.y + box.h >= r.y) {
          rt.y = r.y - box.h; rt.vy = 0; box.y = rt.y; continue;
        }
        if (rt.vy < 0 && startY >= r.y + r.h && box.y <= r.y + r.h) {
          rt.y = r.y + r.h; rt.vy = 0; box.y = rt.y; continue;
        }
        // Normal discrete overlap check: covers slow falls, resting contact,
        // and crate-vs-crate stacking against this frame's still-mid-fall
        // neighbors (their solids() snapshot is from before this loop ran).
        if (!this._overlap(box, r)) continue;
        if (rt.vy > 0) rt.y = r.y - box.h;
        else if (rt.vy < 0) rt.y = r.y + r.h;
        rt.vy = 0;
        box.y = rt.y;
      }
      // out-of-bounds crates (pushed off an edge into the void, or floated
      // off the top under negative gravity) just stop moving once well past
      // the level — no need to keep integrating forever
      if (rt.y > this.level.rows * CELL + CELL * 4 || rt.y < -CELL * 4) rt.vy = 0;
    }
  }

  // Lets the player shove a crate sideways by walking into it. Called right
  // after the player's tentative (pre-collision) x-move for this frame, so
  // `p.x` already reflects where they're trying to go. A crate the player is
  // (now) overlapping gets shifted the same direction, clamped to however
  // far it can actually travel before overlapping something else — enough
  // to stay flush with the player, so it keeps moving in lockstep with them
  // for as long as they keep walking into it. If the crate has zero room to
  // budge at all, it doesn't move, and the caller's normal solid-collision
  // resolution (against the crate's unchanged position) blocks the player
  // exactly like walking into a block. A crate resting on top of the player
  // (or vice versa) never triggers this — touching flush along y, not
  // overlapping, is exactly what `_overlap` treats as "no collision".
  //
  // This used to be all-or-nothing: if shoving the crate the FULL requested
  // distance (the player's entire per-frame penetration) would overlap
  // anything — another solid ahead, or the grid edge — the crate didn't
  // move AT ALL, even by a smaller safe amount. The instant a crate got
  // within less than one frame's push distance of an obstacle (a wall, the
  // level edge, or the far side of a 1-cell gap it should have been able to
  // enter), it would permanently freeze right there: every later frame
  // requests that same full penetration distance again, which still
  // overshoots past the obstacle by the same sliver, so the crate — and the
  // player pushing it, now flush against it — could never creep the last
  // few pixels closer or align with a gap it was actually narrow enough to
  // pass through. Clamping the move to the nearest obstacle instead lets it
  // creep up flush frame by frame, same as the player's own collision does.
  _pushCrates(p, dt) {
    if (p.vx === 0) return;
    const pushDir = p.vx > 0 ? 1 : -1;
    for (const rt of this.runtime.values()) {
      if (rt.def.type !== ENTITY_TYPES.CRATE || rt.passable) continue;
      const box = { x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL };
      if (!this._overlap(p, box)) continue;
      const penetration = pushDir > 0 ? (p.x + p.w - box.x) : (box.x + box.w - p.x);
      if (penetration <= 0) continue;
      let maxMove = penetration;
      // "Difficulté à pousser" (props.pushDifficulty, default/minimum 1 =
      // normal): resolving the player's ENTIRE per-frame penetration into
      // crate movement, unconditionally (the block below this comment,
      // untouched), is what makes a normal crate keep lockstep with the
      // player — effectively weightless. A difficulty above 1 caps how far
      // THIS frame's push can move the crate below that full penetration;
      // the player's own collision then simply stops them at the crate's
      // slower pace, which reads as "this one's harder to shove". Left
      // alone (<=1, the default) there is no cap at all, so normal crates
      // are bit-for-bit identical to before this feature existed.
      const pushDifficulty = Number.isFinite(rt.def.props && rt.def.props.pushDifficulty) ? rt.def.props.pushDifficulty : 1;
      if (pushDifficulty > 1) maxMove = Math.min(maxMove, (PHYSICS.MOVE_SPEED * dt) / pushDifficulty);
      if (pushDir > 0) maxMove = Math.min(maxMove, this.level.cols * CELL - (box.x + box.w));
      else maxMove = Math.min(maxMove, box.x);
      for (const r of this._solidRects()) {
        if (r.id === rt.def.id) continue;
        if (box.y >= r.y + r.h || box.y + box.h <= r.y) continue; // no vertical overlap: irrelevant to a horizontal push
        if (pushDir > 0 && r.x >= box.x + box.w) maxMove = Math.min(maxMove, r.x - (box.x + box.w));
        else if (pushDir < 0 && r.x + r.w <= box.x) maxMove = Math.min(maxMove, box.x - (r.x + r.w));
      }
      if (maxMove <= 0) continue;
      rt.x += pushDir * maxMove;
    }
  }

  // Whether any crate currently overlaps the given box — used by
  // _checkPlates so a crate sitting on a pressure plate weighs it down
  // exactly like the player standing on it would.
  _crateOverlapping(box) {
    for (const rt of this.runtime.values()) {
      if (rt.def.type !== ENTITY_TYPES.CRATE || rt.passable) continue;
      const cbox = { x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL };
      if (this._overlap(cbox, box)) return true;
    }
    return false;
  }

  // Point on the player's boundary facing "down" relative to current
  // gravity — i.e. the feet — used to anchor cosmetic dust particles so they
  // land under the player regardless of which wall gravity currently treats
  // as the floor.
  _feetPoint(p, g) {
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    if (g.x !== 0) return [g.x > 0 ? p.x + p.w : p.x, cy];
    return [cx, g.y > 0 ? p.y + p.h : p.y];
  }

  // Rigid platform carry: if the player was resting on a moving solid as of
  // last frame, translate them by that solid's delta for THIS frame before
  // anything else moves. This has to be an unconditional translation, not a
  // "does the player still overlap it" re-check — the old carry only
  // nudged the player sideways (perpendicular to gravity) whenever
  // _resolveAxis happened to re-detect overlap that same frame, which is
  // fine for a slow-moving platform but breaks down for a fast one: a
  // platform rising quickly enough can end up with its post-move rect no
  // longer overlapping the player's pre-move position at all (a discrete,
  // non-swept check), so the player is left behind — visibly passing
  // through/above the platform instead of riding it up. Moving the player
  // in lockstep first, then letting the normal collision pass re-settle
  // them against the solid's new position, makes the ride immune to that
  // regardless of how fast the platform moves.
  _carryRider(p) {
    if (!p.ridingId) return;
    const ride = this.runtime.get(p.ridingId);
    p.ridingId = null; // re-armed below by _resolveAxis if still grounded on something this frame
    if (!ride || ride.passable) return;
    if (ride.dx) p.x += ride.dx;
    if (ride.dy) p.y += ride.dy;
  }

  // The world's gravityScale (see level.gravityScale / "Condition du monde")
  // can be negative — that's what lets an author flip gravity as a mechanic
  // instead of only ever scaling its strength. Rather than thread a signed
  // scale through every direction-dependent calculation (grounding side,
  // jump impulse, feet-point, sprite rotation…), this bakes the flip into
  // the direction itself: negative world gravity means "pull toward the
  // OPPOSITE of gravityDir" instead of toward it. Every caller below then
  // uses this effective direction together with the scale's plain
  // MAGNITUDE (Math.abs), so all the existing direction-aware physics code
  // (which was only ever written/tested for a non-negative scale) keeps
  // working unchanged — it just sees a different, already-correct "down".
  _effectiveGravityDir(dir) {
    const gs = Number.isFinite(this.level.gravityScale) ? this.level.gravityScale : 1;
    return gs < 0 ? (OPPOSITE_GRAVITY_DIR[dir] || dir) : dir;
  }

  _updatePhysics(p, dt) {
    this._carryRider(p);
    const gravityScale = Number.isFinite(this.level.gravityScale) ? this.level.gravityScale : 1;
    const g = GRAVITY_VECTORS[this._effectiveGravityDir(p.gravityDir)];
    const gMag = Math.abs(gravityScale);
    const input = this._input(p);
    const wasOnGround = p.onGround;

    // acceleration due to gravity
    p.vx += g.x * PHYSICS.GRAVITY_ACCEL * gMag * dt;
    p.vy += g.y * PHYSICS.GRAVITY_ACCEL * gMag * dt;
    // clamp fall speed along gravity axis
    const maxFall = PHYSICS.MAX_FALL_SPEED * gMag;
    const fallSpeed = p.vx * g.x + p.vy * g.y;
    if (fallSpeed > maxFall) {
      p.vx = g.x * maxFall + p.vx * (1 - Math.abs(g.x));
      p.vy = g.y * maxFall + p.vy * (1 - Math.abs(g.y));
    }

    // movement axis is perpendicular to gravity
    const horizontalGravity = g.x !== 0;
    const speed = PHYSICS.MOVE_SPEED * p.speedMult;
    if (!horizontalGravity) {
      let mv = 0;
      if (input.left) mv -= 1;
      if (input.right) mv += 1;
      p.vx = mv * speed;
      if (mv !== 0) p.facing = mv;
    } else {
      let mv = 0;
      if (input.up) mv -= 1;
      if (input.down) mv += 1;
      p.vy = mv * speed;
    }

    // layer the fan's wind push on top of the input-driven velocity we just
    // set above (added here, not inside _applyFans, so it survives the
    // unconditional overwrite the movement-axis code above just did)
    p.vx += p.windVx;
    p.vy += p.windVy;

    // jump: impulse opposite gravity direction
    if (input.jump && p.onGround) {
      p.vx += -g.x * PHYSICS.JUMP_POWER * p.jumpMult;
      p.vy += -g.y * PHYSICS.JUMP_POWER * p.jumpMult;
      p.onGround = false;
      sfx.jump();
      this.particles.dust(...this._feetPoint(p, g));
    }

    // integrate + resolve collisions on each axis separately
    let rects = this._solidRects();
    p.onGround = false;

    p.x += p.vx * dt;
    this._pushCrates(p, dt); // may shove a crate out of the way before x-collision resolves
    rects = this._solidRects(); // re-snapshot: a pushed crate's rect must reflect its new position
    this._resolveAxis(p, rects, 'x', g);
    p.y += p.vy * dt;
    this._resolveAxis(p, rects, 'y', g);

    if (!wasOnGround && p.onGround) {
      sfx.land();
      this.particles.dust(...this._feetPoint(p, g));
    }

    // out of level bounds -> death
    const margin = CELL * 2;
    if (p.x < -margin || p.y < -margin ||
        p.x > this.level.cols * CELL + margin || p.y > this.level.rows * CELL + margin) {
      this.killPlayer(p);
    }
  }

  _resolveAxis(p, rects, axis, g) {
    // Historical bug ("glitch du plafond"): grounding used to be granted for
    // ANY collision on the gravity-aligned axis, without checking which side
    // it happened on — so jumping up and bonking your head on a ceiling
    // block (moving AGAINST gravity) counted the exact same as landing on a
    // floor (moving WITH gravity), letting you jump again immediately and
    // spam-jump forever stuck against the ceiling. Fixed by default: only a
    // collision on the side gravity actually presses the player into counts
    // as grounded. `ceilingJumpGlitch` lets a level author opt back into the
    // old buggy behavior on purpose, as a mechanic.
    const glitchOn = !!(this.level && this.level.ceilingJumpGlitch);
    for (const r of rects) {
      if (!this._overlap(p, r)) continue;
      let vSign = 0;
      if (axis === 'x') {
        vSign = p.vx > 0 ? 1 : (p.vx < 0 ? -1 : 0);
        if (p.vx > 0) p.x = r.x - p.w;
        else if (p.vx < 0) p.x = r.x + r.w;
        p.vx = 0;
      } else {
        vSign = p.vy > 0 ? 1 : (p.vy < 0 ? -1 : 0);
        if (p.vy > 0) p.y = r.y - p.h;
        else if (p.vy < 0) p.y = r.y + r.h;
        p.vy = 0;
      }
      const gravitySign = axis === 'x' ? Math.sign(g.x) : Math.sign(g.y);
      const pushingInto = glitchOn
        ? gravitySign !== 0
        : (gravitySign !== 0 && vSign === gravitySign);
      if (pushingInto) {
        p.onGround = true;
        // Remember what the player is standing on so _carryRider() can move
        // them in lockstep with it next frame (handles the platform moving
        // along EITHER axis — up/down or sideways — not just perpendicular
        // to gravity); see _carryRider's comment for why this replaced the
        // old same-frame overlap-based nudge.
        p.ridingId = r.id;
      }
    }
  }

  _overlap(p, r) {
    return p.x < r.x + r.w && p.x + p.w > r.x && p.y < r.y + r.h && p.y + p.h > r.y;
  }

  // Circle-vs-AABB distance test: finds the point of the (axis-aligned)
  // player box closest to the circle's center, then checks whether that
  // point is within the radius. Used for the spinner's disc-shaped blades,
  // which occupy far less area than their square bounding box.
  _circleRectOverlap(cx, cy, r, rect) {
    const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
    const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
    const dx = cx - closestX, dy = cy - closestY;
    return (dx * dx + dy * dy) < r * r;
  }

  // Run once per player (see update()) — on a 2-player level, EITHER player
  // touching a hazard/deadly block kills (the whole level resets, per
  // killPlayer's own doc comment), EITHER one reaching the goal starts the
  // door closing for both (see _startDoorClose), and a checkpoint activates
  // (moving the shared respawn anchor) the moment either one steps on it.
  _checkHazardsAndGoal(p) {
    for (const rt of this.runtime.values()) {
      const t = rt.def.type;
      const box = { x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL };
      if (!this._overlap(p, box)) continue;

      if (HAZARD_TYPES.has(t)) {
        if (t === ENTITY_TYPES.SPINNER) {
          // Same radius formula as the visual rendering (_renderEntity), so
          // the hitbox matches exactly what's drawn on screen.
          const cx = rt.x + box.w / 2, cy = rt.y + box.h / 2;
          const radius = CELL * ((rt.def.props && rt.def.props.radius) || 0.9) * rt.def.w;
          if (!this._circleRectOverlap(cx, cy, radius, p)) continue;
        }
        // "Inoffensif" hazards are solid now (see _solidRects) so normal
        // collision resolution keeps the player from ever truly overlapping
        // one; "traversable" hazards have zero collision, so overlap here
        // just means passing harmlessly through. A plain hazard still kills.
        if (!rt.harmless && !rt.passable) this.killPlayer(p);
        continue;
      }
      if ((t === ENTITY_TYPES.BLOCK || t === ENTITY_TYPES.CRATE) && rt.deadly) {
        // Mirrors the hazard rule above but with the polarity flipped: a
        // block/crate is safe by default, "tueur" makes it lethal, and
        // "traversable" still always wins (walk straight through, no harm
        // either way).
        if (!rt.passable) this.killPlayer(p);
        continue;
      }
      if (t === ENTITY_TYPES.SPRING && !rt.passable) {
        const dir = (rt.def.props && rt.def.props.direction) || 'up';
        const power = ((rt.def.props && rt.def.props.power) || 1.6) * PHYSICS.JUMP_POWER;
        const v = GRAVITY_VECTORS[dir]; // direct push direction (not opposed like gravity)
        p.vx = v.x * power; p.vy = v.y * power;
        sfx.spring();
        this.particles.dust(rt.x + box.w / 2, rt.y);
      }
      if (t === ENTITY_TYPES.GOAL && !this.finishing && !rt.passable) {
        this._startDoorClose(rt, box);
      }
      if (t === ENTITY_TYPES.CHECKPOINT && !rt.activated) {
        rt.activated = true;
        this.respawn = { x: rt.def.x, y: rt.def.y };
        sfx.checkpoint();
      }
    }
  }

  // Teleporters sharing the same `frequency` cycle a player through the
  // group in authored order. When "sens unique" is on (synced across the
  // whole frequency group by the editor), both the departure AND the
  // arrival teleporter are marked used — otherwise the player could just
  // walk back onto the one they arrived at and take the return trip. On a
  // 2-player level, either player can trigger a teleporter independently,
  // but still at most one teleport total per frame (matching the original
  // single-player behavior) — checked in player order, first match wins.
  _checkTeleporters() {
    if (this._teleportCooldown > 0) return;
    for (const p of this.players) {
      for (const rt of this.runtime.values()) {
        if (rt.def.type !== ENTITY_TYPES.TELEPORTER) continue;
        if (rt.passable || rt.usedOnce) continue;
        const box = { x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL };
        if (!this._overlap(p, box)) continue;
        this._teleportViaGroup(rt, p);
        return; // at most one teleport per frame
      }
    }
  }

  _teleportViaGroup(rt, p = this.player) {
    const freq = (rt.def.props && rt.def.props.frequency) || 1;
    const group = this.level.entities.filter(e => e.type === ENTITY_TYPES.TELEPORTER && ((e.props && e.props.frequency) || 1) === freq);
    if (group.length < 2) return;
    const idx = group.findIndex(e => e.id === rt.def.id);
    const nextDef = group[(idx + 1) % group.length];
    const targetRt = this.runtime.get(nextDef.id);
    if (!targetRt) return;
    p.x = targetRt.x + (nextDef.w * CELL - p.w) / 2;
    p.y = targetRt.y + (nextDef.h * CELL - p.h) / 2;
    this._teleportCooldown = 0.5;
    sfx.teleport();
    if (rt.def.props && rt.def.props.oneUse) {
      rt.usedOnce = true;
      targetRt.usedOnce = true; // no backtracking through the one you land on
    }
  }

  // Whether the given activator kind(s) currently overlap `box`, per this
  // entity's `props.activator` ('player' | 'crate' | 'both'). Lets a
  // trigger/button/plate be stepped on by the player, weighed down by a
  // resting crate, or either — see constants.js's ACTIVATOR_MODES.
  _activatorOverlap(rt, box) {
    const props = rt.def.props || {};
    const mode = props.activator || (rt.def.type === ENTITY_TYPES.PLATE ? 'both' : 'player');
    // Either player can activate it (2-player level or not — this.players
    // always has at least player 1).
    if ((mode === 'player' || mode === 'both') && this.players.some(p => this._overlap(p, box))) return true;
    if ((mode === 'crate' || mode === 'both') && this._crateOverlapping(box)) return true;
    return false;
  }

  // Extends a raw overlap reading by `props.releaseGrace` seconds: once
  // truly overlapping, a brief drop-out (a stray step off the edge, a jump
  // that clears it for a moment) still reads as "still overlapping" for up
  // to `releaseGrace` seconds, so it isn't mistaken for a genuine release.
  // With releaseGrace at 0 (the default) this is just the raw reading.
  _graceOverlap(rt, rawOverlapping) {
    const grace = (rt.def.props && rt.def.props.releaseGrace) || 0;
    if (rawOverlapping) { rt.graceUntil = 0; return true; }
    if (grace > 0) {
      if (!rt.graceUntil) rt.graceUntil = this.simTime + grace;
      if (this.simTime < rt.graceUntil) return true;
    }
    rt.graceUntil = 0;
    return false;
  }

  // Whether this trigger/button/plate is currently allowed to fire at all —
  // false once permanently closed (releaseMode:'finishAndClose', or
  // maxRepeats reached) or while still cooling down (rearmCooldown).
  _canActivate(rt) {
    if (rt.disabled) return false;
    if (rt.cooldownUntil && this.simTime < rt.cooldownUntil) return false;
    return true;
  }

  // Defers the actual firing by `props.activationDelay` seconds (0 = fire
  // immediately, the original behavior). If the activator leaves (beyond any
  // releaseGrace) or the entity gets re-armed/disabled before the delay
  // elapses, the pending activation is silently dropped instead of firing —
  // `onCancel` (optional) lets the caller undo any "reserved" state it set
  // when it first decided to activate (e.g. a button's buttonReady flag).
  _activate(rt, onFire, onCancel) {
    const delay = (rt.def.props && rt.def.props.activationDelay) || 0;
    if (delay <= 0) { onFire(); return; }
    rt.activationToken = (rt.activationToken || 0) + 1;
    const token = rt.activationToken;
    this.scheduled.push({
      time: this.simTime + delay,
      run: () => {
        if (rt.activationToken !== token || !rt.wasOverlapping || !this._canActivate(rt)) {
          if (onCancel) onCancel();
          return;
        }
        onFire();
      },
    });
  }

  // A trigger always fires when the player (or a crate, depending on
  // `activator`) enters it — re-arms once they leave (past any releaseGrace),
  // so it can fire again on a later pass, unless maxRepeats/releaseMode
  // 'finishAndClose' has permanently closed it. If "boucle infinie" is on,
  // entering it once kicks off a self-repeating cycle instead of a single
  // pass.
  _checkTriggers() {
    for (const rt of this.runtime.values()) {
      if (rt.def.type !== ENTITY_TYPES.TRIGGER) continue;
      const box = { x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL };
      const overlapping = this._graceOverlap(rt, this._activatorOverlap(rt, box));
      if (overlapping && !rt.wasOverlapping && this._canActivate(rt)) {
        this._activate(rt, () => {
          if (rt.def.props && rt.def.props.loop) this._fireLoop(rt);
          else this._fireTrigger(rt);
        });
      }
      rt.wasOverlapping = overlapping;
    }
  }

  // A button is a visible, physical switch: pressing it fires its actions;
  // it becomes pressable again as soon as those actions finish playing (no
  // fixed cooldown to configure, unless rearmCooldown adds one on top). By
  // default every press replays the same actions forward. If "Inversement
  // des actions" is turned on, presses instead alternate between playing the
  // actions forward and playing them undone — "comme si on inversait le sens
  // du temps" — via _fireTrigger's built-in forward/reverse toggle (see
  // below), so a second press naturally puts everything back the way it was.
  // "Boucle infinie" instead turns one press into a self-repeating cycle
  // forever (each cycle of the loop also alternates the same way, when
  // reversible is on).
  _checkButtons() {
    for (const rt of this.runtime.values()) {
      if (rt.def.type !== ENTITY_TYPES.BUTTON) continue;
      const box = { x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL };
      const overlapping = this._graceOverlap(rt, this._activatorOverlap(rt, box));
      const props = rt.def.props || {};
      if (overlapping && !rt.wasOverlapping && rt.buttonReady && this._canActivate(rt)) {
        sfx.button();
        if (props.loop) {
          this._activate(rt, () => this._fireLoop(rt));
        } else {
          rt.buttonReady = false; // reserved immediately so a re-entry mid-delay can't double-press
          this._activate(rt, () => {
            this._fireTrigger(rt);
            const finishAt = this._actionsFinishTime(rt);
            this.scheduled.push({ time: finishAt, run: () => { rt.buttonReady = true; } });
          }, () => { rt.buttonReady = true; });
        }
      }
      rt.wasOverlapping = overlapping;
    }
  }

  // A pressure plate's press-side behavior depends on `props.pressMode`:
  // 'once' fires its actions a single time per press (no repeat even if the
  // activator stays on it); 'hold' (the historical default) repeats them for
  // as long as the player (or a resting crate, depending on `activator`)
  // stays on it — one cycle right away, then again every time the previous
  // cycle finishes, stopping the moment the activator leaves; 'loop' ("boucle
  // infinie") starts a cycle that never stops once pressed, regardless of
  // whether the activator stays. All three can alternate forward/reverse
  // each firing when "Inversement des actions" is on, same opt-in as a
  // button. Independently, releasing the plate (leaving it, past any
  // releaseGrace) fires its own separate one-shot action list — see
  // _firePlateRelease — regardless of which press mode is active.
  _checkPlates() {
    for (const rt of this.runtime.values()) {
      if (rt.def.type !== ENTITY_TYPES.PLATE) continue;
      const props = rt.def.props || {};
      const box = { x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL };
      const overlapping = this._graceOverlap(rt, this._activatorOverlap(rt, box));
      if (overlapping && !rt.wasOverlapping && this._canActivate(rt)) {
        const mode = props.pressMode || (props.loop ? 'loop' : 'hold');
        if (mode === 'loop') this._activate(rt, () => this._fireLoop(rt));
        else if (mode === 'once') this._activate(rt, () => this._fireTrigger(rt));
        else this._activate(rt, () => this._startHold(rt));
      }
      if (!overlapping && rt.wasOverlapping) this._firePlateRelease(rt);
      if (!overlapping) rt.holding = false;
      rt.wasOverlapping = overlapping;
    }
  }

  // Fires a PLATE's separate `props.releaseActions` list once, the moment
  // the activator leaves it (already grace-adjusted by the `overlapping`
  // reading in _checkPlates — a brief drop-out within releaseGrace never
  // reaches here). Always plays forward, never alternated by `reversible`
  // (that's a press-only concept: release is already a single momentary
  // event, not something repeatedly activated) — and does nothing at all
  // once the plate is fully disabled. `props.closeOnRelease` permanently
  // closes the plate (same effect as releaseMode:'finishAndClose', but tied
  // to the release firing finishing rather than the press-side actions).
  _firePlateRelease(rt) {
    if (rt.disabled) return;
    const props = rt.def.props || {};
    const actions = props.releaseActions || [];
    if (!actions.length) {
      if (props.closeOnRelease) rt.disabled = true;
      return;
    }
    const sequential = !!props.sequential;
    const offsets = this._actionOffsetsFor(actions, sequential);
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const runAt = this.simTime + offsets[i];
      this.scheduled.push({ time: runAt, run: () => this._runAction(action) });
    }
    if (props.closeOnRelease) {
      const span = Math.max(0, this._actionsSpanFor(actions, sequential));
      this.scheduled.push({ time: this.simTime + Math.max(0.1, span), run: () => { rt.disabled = true; } });
    }
  }

  _startHold(rt) {
    if (rt.holding) return;
    rt.holding = true;
    const cycle = () => {
      if (!rt.holding) return;
      if (!this._canActivate(rt)) { rt.holding = false; return; }
      this._fireTrigger(rt);
      const span = Math.max(0.1, this._actionsSpan(rt));
      this.scheduled.push({ time: this.simTime + span, run: cycle });
    };
    cycle();
  }

  // Starts a self-repeating "boucle infinie" cycle (shared by trigger/button/
  // plate) — fires the action list, waits for it to finish, fires it again,
  // forever (or until maxRepeats/releaseMode closes it). Guarded by
  // `looping` so re-entering/re-pressing doesn't stack multiple concurrent
  // cycles.
  _fireLoop(rt) {
    if (rt.looping) return;
    rt.looping = true;
    const cycle = () => {
      if (!this._canActivate(rt)) { rt.looping = false; return; }
      this._fireTrigger(rt);
      const span = Math.max(0.1, this._actionsSpan(rt));
      this.scheduled.push({ time: this.simTime + span, run: cycle });
    };
    cycle();
  }

  // Per-action start offsets (seconds, relative to "now"). By default each
  // action starts independently at its own `delay` (original behavior). With
  // `props.sequential` on ("Executé les actions dans l'ordre"), actions
  // instead chain one after another — each one's `delay` becomes an extra
  // wait added AFTER the previous action finishes playing, rather than being
  // measured from "now" — so they visibly play out one at a time instead of
  // several kicking off at once. Shared by both _fireTrigger (scheduling) and
  // _actionsSpan (duration) so the two can never disagree.
  _actionOffsets(rt) {
    const actions = (rt.def.props && rt.def.props.actions) || [];
    const sequential = !!(rt.def.props && rt.def.props.sequential);
    return this._actionOffsetsFor(actions, sequential);
  }

  // Same computation as _actionOffsets, but for an arbitrary action list —
  // lets PLATE's separate `releaseActions` list (see _firePlateRelease)
  // share this logic with the main `actions` list instead of duplicating it.
  _actionOffsetsFor(actions, sequential) {
    const offsets = [];
    if (!sequential) {
      for (const a of actions) offsets.push(a.delay || 0);
      return offsets;
    }
    let cursor = 0;
    for (const a of actions) {
      cursor += (a.delay || 0);
      offsets.push(cursor);
      const dur = a.type === ACTION_TYPES.MOVE_ELEMENT ? Math.max(0.05, a.params.duration || 0.5) : 0;
      cursor += dur;
    }
    return offsets;
  }

  // Total time (seconds, relative to "now") the action list takes to fully
  // play out — used to know when a button becomes pressable again, when to
  // loop/repeat next, and where to schedule a "revert to start" once actions
  // finish.
  _actionsSpan(rt) {
    const actions = (rt.def.props && rt.def.props.actions) || [];
    const sequential = !!(rt.def.props && rt.def.props.sequential);
    return this._actionsSpanFor(actions, sequential);
  }

  // Same computation as _actionsSpan, but for an arbitrary action list — see
  // _actionOffsetsFor.
  _actionsSpanFor(actions, sequential) {
    const offsets = this._actionOffsetsFor(actions, sequential);
    let span = 0;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      const dur = a.type === ACTION_TYPES.MOVE_ELEMENT ? Math.max(0.05, a.params.duration || 0.5) : 0;
      span = Math.max(span, offsets[i] + dur);
    }
    return span;
  }

  _actionsFinishTime(rt) {
    return this.simTime + this._actionsSpan(rt);
  }

  // TRIGGER always plays its actions forward. BUTTON and PLATE can
  // optionally do the same alternating trick, but only when "Inversement
  // des actions" is explicitly turned on for that entity (props.reversible)
  // — by default they always play forward, every time, just like a trigger.
  // When enabled: 1st activation forward, 2nd activation undone ("comme si
  // on inversait le sens du temps" — a moved element goes back to its
  // start, an invisible player becomes visible again, etc — see
  // _runActionReversed), 3rd forward again, and so on.
  //
  // Also tracks the extended activation bookkeeping shared by all three
  // types: bumps `repeatCount` and permanently closes the entity once
  // `maxRepeats` is reached, permanently closes it once this activation's
  // actions finish when `releaseMode:'finishAndClose'`, and arms
  // `cooldownUntil` when `rearmCooldown` is set.
  _fireTrigger(triggerRt) {
    const props = triggerRt.def.props || {};
    const canReverse = (triggerRt.def.type === ENTITY_TYPES.BUTTON || triggerRt.def.type === ENTITY_TYPES.PLATE)
      && !!props.reversible;
    const reversed = canReverse && triggerRt.reversed;
    const actions = props.actions || [];
    const offsets = this._actionOffsets(triggerRt);
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const runAt = this.simTime + offsets[i];
      this.scheduled.push({ time: runAt, run: () => (reversed ? this._runActionReversed(action) : this._runAction(action)) });
    }
    if (canReverse) triggerRt.reversed = !triggerRt.reversed;

    triggerRt.repeatCount = (triggerRt.repeatCount || 0) + 1;
    const maxRepeats = props.maxRepeats || 0;
    if (maxRepeats > 0 && triggerRt.repeatCount >= maxRepeats) triggerRt.disabled = true;

    const span = Math.max(0, this._actionsSpan(triggerRt));
    if (props.releaseMode === 'finishAndClose') {
      this.scheduled.push({ time: this.simTime + Math.max(0.1, span), run: () => { triggerRt.disabled = true; } });
    }
    if (props.rearmCooldown > 0) {
      triggerRt.cooldownUntil = this.simTime + span + props.rearmCooldown;
    }
  }

  // Resolves a TELEPORT action's special 'player' / 'player2' targetId to the
  // actual runtime player object. 'player2' on a level that doesn't have a
  // second player (this.player2 is null) falls back to player 1 rather than
  // crashing — harmless no-op-ish behavior for an action authored while 2
  // players was on, then later turned back off.
  _resolveActionPlayer(targetId) {
    if (targetId === 'player2') return this.player2 || this.player;
    return this.player;
  }

  // Resolves a SET_PLAYER_STATE action's `params.player` (1 or 2, default 1
  // — see constants around "2 joueurs") to the actual runtime player object,
  // with the same player2-doesn't-exist fallback as above.
  _resolveStatePlayer(params) {
    return Number(params.player) === 2 ? (this.player2 || this.player) : this.player;
  }

  _runAction(action) {
    const target = (action.targetId === 'player' || action.targetId === 'player2') ? null : this.runtime.get(action.targetId);
    const params = action.params || {};
    switch (action.type) {
      case ACTION_TYPES.MOVE_ELEMENT: {
        if (!target) return;
        // Axe X : +1 = droite, -1 = gauche. Axe Y : +1 = monte, -1 = descend
        // (inversé par rapport à l'axe écran, où y grandit vers le bas).
        const dx = (params.axisX || 0) * CELL;
        const dy = -(params.axisY || 0) * CELL;
        target.anim = {
          fromX: target.x, fromY: target.y,
          toX: target.x + dx, toY: target.y + dy,
          startTime: this.simTime,
          duration: Math.max(0.05, params.duration || 0.5),
        };
        break;
      }
      case ACTION_TYPES.TELEPORT: {
        if (action.targetId === 'player' || action.targetId === 'player2') {
          const p = this._resolveActionPlayer(action.targetId);
          p.x = params.x * CELL; p.y = params.y * CELL;
        } else if (target) {
          target.x = params.x * CELL; target.y = params.y * CELL;
          target.anim = null;
        }
        break;
      }
      case ACTION_TYPES.SET_STATE: {
        if (target) {
          if ('passable' in params) target.passable = !!params.passable;
          if ('invisible' in params) target.invisible = !!params.invisible;
          if ('harmless' in params) target.harmless = !!params.harmless;
          if ('deadly' in params) target.deadly = !!params.deadly;
          if ('facing' in params) target.facing = params.facing;
        }
        break;
      }
      case ACTION_TYPES.SET_WORLD_STATE: {
        if ('gravityScale' in params) this.level.gravityScale = params.gravityScale;
        if ('background' in params) this.level.background = params.background;
        break;
      }
      case ACTION_TYPES.SET_PLAYER_STATE: {
        const p = this._resolveStatePlayer(params);
        if ('gravity' in params) p.gravityDir = params.gravity;
        if ('invert' in params) {
          const axis = params.invert;
          if (axis === 'both') { p.invert.horizontal = true; p.invert.vertical = true; }
          else p.invert[axis] = true;
          const dur = params.invertDuration || 0;
          if (dur) {
            setTimeout(() => {
              if (axis === 'both') { p.invert.horizontal = false; p.invert.vertical = false; }
              else p.invert[axis] = false;
            }, dur * 1000);
          }
        }
        if ('invisible' in params) this._setPlayerInvisible(!!params.invisible, p);
        if ('jumpMult' in params) {
          p.jumpMult = params.jumpMult;
          const dur = params.statDuration || 0;
          if (dur) setTimeout(() => { p.jumpMult = 1; }, dur * 1000);
        }
        if ('speedMult' in params) {
          p.speedMult = params.speedMult;
          const dur = params.statDuration || 0;
          if (dur) setTimeout(() => { p.speedMult = 1; }, dur * 1000);
        }
        break;
      }
      default: break;
    }
  }

  // The "undo" half of a button/plate's forward/reverse alternation (see
  // _fireTrigger): instead of applying the action, put back whatever it
  // would have changed. A moved element returns to its authored position;
  // world/player state goes back to what the level/player started with;
  // boolean flags return to their authored defaults. Never used for
  // TRIGGER, which always plays forward.
  _runActionReversed(action) {
    const target = (action.targetId === 'player' || action.targetId === 'player2') ? null : this.runtime.get(action.targetId);
    const params = action.params || {};
    switch (action.type) {
      case ACTION_TYPES.MOVE_ELEMENT: {
        if (!target) return;
        target.anim = {
          fromX: target.x, fromY: target.y,
          toX: target.def.x * CELL, toY: target.def.y * CELL,
          startTime: this.simTime,
          duration: Math.max(0.05, params.duration || 0.5),
        };
        break;
      }
      case ACTION_TYPES.TELEPORT: {
        if (action.targetId === 'player' || action.targetId === 'player2') {
          const p = this._resolveActionPlayer(action.targetId);
          // player 2's own respawn point is always player 1's respawn anchor
          // offset by their authored spawn-to-spawn delta — see _resetPlayer.
          if (action.targetId === 'player2' && this.player2) {
            const lvl = this.level;
            const dx = (lvl.playerStart2.x - lvl.playerStart.x), dy = (lvl.playerStart2.y - lvl.playerStart.y);
            p.x = (this.respawn.x + dx) * CELL; p.y = (this.respawn.y + dy) * CELL;
          } else {
            p.x = this.respawn.x * CELL; p.y = this.respawn.y * CELL;
          }
        } else if (target) {
          target.x = target.def.x * CELL; target.y = target.def.y * CELL;
          target.anim = null;
        }
        break;
      }
      case ACTION_TYPES.SET_STATE: {
        if (target) {
          if ('passable' in params) target.passable = !!target.def.passable;
          if ('invisible' in params) target.invisible = !!target.def.invisible;
          if ('harmless' in params) target.harmless = !!target.def.harmless;
          if ('deadly' in params) target.deadly = !!target.def.deadly;
          if ('facing' in params && target.def.props) target.facing = target.def.props.facing || 'up';
        }
        break;
      }
      case ACTION_TYPES.SET_WORLD_STATE: {
        if ('gravityScale' in params) this.level.gravityScale = this._authoredGravityScale;
        if ('background' in params) this.level.background = this._authoredBackground;
        break;
      }
      case ACTION_TYPES.SET_PLAYER_STATE: {
        const p = this._resolveStatePlayer(params);
        const ps = (Number(params.player) === 2 ? this.level.playerStart2 : this.level.playerStart) || {};
        if ('gravity' in params) p.gravityDir = ps.gravityDir || 'down';
        if ('invert' in params) {
          const axis = params.invert;
          if (axis === 'both') { p.invert.horizontal = false; p.invert.vertical = false; }
          else p.invert[axis] = false;
        }
        if ('invisible' in params) this._setPlayerInvisible(!!ps.invisible, p);
        if ('jumpMult' in params) p.jumpMult = 1;
        if ('speedMult' in params) p.speedMult = 1;
        break;
      }
      default: break;
    }
  }

  // Toggling visibility mid-game gets a small "poof" — particles + a sound —
  // right at the moment it changes, so it reads as a deliberate effect
  // rather than the player silently popping in/out. No-ops if the value
  // doesn't actually change (e.g. an action re-setting invisible:true twice).
  _setPlayerInvisible(value, p = this.player) {
    if (p.invisible === value) return;
    p.invisible = value;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    this.particles.poof(cx, cy);
    if (value) sfx.vanish(); else sfx.appear();
  }

  // Shared by both the single camera and the 2-player split-screen cameras
  // below — given a group of players and the pixel size of the viewport
  // they're sharing, centers on their midpoint and clamps to the level's
  // edges (or centers on the level itself, when it's smaller than the
  // viewport — see the render-centering comment this replaced).
  _computeCameraFor(players, vpW, vpH) {
    const lvl = this.level;
    const levelW = lvl.cols * CELL, levelH = lvl.rows * CELL;
    const midX = players.reduce((s, p) => s + p.x + p.w / 2, 0) / players.length;
    const midY = players.reduce((s, p) => s + p.y + p.h / 2, 0) / players.length;
    let cx = midX - vpW / 2;
    let cy = midY - vpH / 2;
    cx = levelW <= vpW ? (levelW - vpW) / 2 : Math.max(0, Math.min(cx, levelW - vpW));
    cy = levelH <= vpH ? (levelH - vpH) / 2 : Math.max(0, Math.min(cy, levelH - vpH));
    return { x: cx, y: cy };
  }

  _updateCamera() {
    const cv = this.canvas;
    if (this.player2) {
      // Split-screen: player 1 on top, player 2 below (game.js's
      // sizeCanvasToLevel doubles the canvas height for a 2-player level, so
      // each half is a full-size viewport — the same size a single-player
      // view would get — not two smaller halves of one shared canvas).
      // Nothing stops the other player from being visible too, in whichever
      // half their own position happens to land in — same as any camera, it
      // just draws whatever's in range.
      const halfH = Math.floor(cv.height / 2);
      this.camera1 = this._computeCameraFor([this.player], cv.width, halfH);
      this.camera2 = this._computeCameraFor([this.player2], cv.width, cv.height - halfH);
      this.camera = this.camera1; // keep the single-camera field in sync for any other reader
    } else {
      this.camera = this._computeCameraFor(this.players, cv.width, cv.height);
      this.camera1 = this.camera;
    }
  }

  // ---------------------------------------------------------------- render
  render() {
    const ctx = this.ctx, cv = this.canvas;
    // Cell-occupancy lookup for BLOCK entities, rebuilt once per frame (not
    // per viewport — split-screen draws the same set twice) so adjacent
    // blocks render as one seamless mass with no visible seam between them.
    this._blockCells = this._buildBlockCellSet();
    if (this.player2) {
      const halfH = Math.floor(cv.height / 2);
      this._renderViewport(this.camera1, 0, 0, cv.width, halfH);
      this._renderViewport(this.camera2, 0, halfH, cv.width, cv.height - halfH);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, halfH + 0.5); ctx.lineTo(cv.width, halfH + 0.5); ctx.stroke();
      ctx.restore();
    } else {
      this._renderViewport(this.camera, 0, 0, cv.width, cv.height);
    }
  }

  // Draws the full scene (background, grid, entities, players, particles)
  // once, clipped to a screenX/screenY/vpW/vpH rectangle of the canvas and
  // following the given camera — the single-viewport case just calls this
  // once over the whole canvas; split-screen calls it twice, once per half.
  _renderViewport(camera, screenX, screenY, vpW, vpH) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(screenX, screenY, vpW, vpH);
    ctx.clip();
    ctx.fillStyle = this.level.background || '#1b1e2b';
    ctx.fillRect(screenX, screenY, vpW, vpH);

    let shakeX = 0, shakeY = 0;
    if (this.shake.time > 0) {
      const mag = this.shake.magnitude * (this.shake.time / this.shake.duration);
      shakeX = (Math.random() * 2 - 1) * mag;
      shakeY = (Math.random() * 2 - 1) * mag;
    }
    ctx.translate(screenX - camera.x + shakeX, screenY - camera.y + shakeY);

    // grid backdrop — a build aid only: never shown in real gameplay, only in
    // the editor's debug/playtest view (same flag that reveals triggers).
    if (this.debugTriggers) {
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      const startCol = Math.floor(camera.x / CELL), endCol = startCol + Math.ceil(vpW / CELL) + 1;
      const startRow = Math.floor(camera.y / CELL), endRow = startRow + Math.ceil(vpH / CELL) + 1;
      for (let c = startCol; c <= endCol; c++) {
        ctx.beginPath(); ctx.moveTo(c * CELL, startRow * CELL); ctx.lineTo(c * CELL, endRow * CELL); ctx.stroke();
      }
      for (let r = startRow; r <= endRow; r++) {
        ctx.beginPath(); ctx.moveTo(startCol * CELL, r * CELL); ctx.lineTo(endCol * CELL, r * CELL); ctx.stroke();
      }
    }

    // Entities can be assigned a purely cosmetic paint-order layer (a free
    // integer, see constants.js's clampLayer) so a level author can tuck
    // decoration behind blocks or float something in front of the player —
    // collision/hazards/scripting are completely untouched by this, only
    // draw order changes.
    // A stable sort keeps every layer-0 entity in its original relative
    // order (matching the pre-layers single-pass draw exactly), and splits
    // around the player so layer<=0 draws behind them, layer>0 in front.
    const sorted = Array.from(this.runtime.values()).sort((a, b) => (a.def.layer || 0) - (b.def.layer || 0));
    for (const rt of sorted) { if ((rt.def.layer || 0) <= 0) this._renderEntity(rt); }
    for (const p of this.players) this._renderPlayer(p);
    for (const rt of sorted) { if ((rt.def.layer || 0) > 0) this._renderEntity(rt); }
    this.particles.render(ctx);

    ctx.restore();
  }

  _buildBlockCellSet() {
    const set = new Set();
    for (const rt of this.runtime.values()) {
      if (rt.def.type !== ENTITY_TYPES.BLOCK) continue;
      // Keyed off the block's CURRENT (runtime) position, not its authored
      // one — a block can now be moved by an action (see constants.js's note
      // on the retired PLATFORM type), and the seamless-merge highlight/
      // shadow needs to reflect whatever it's actually next to right now,
      // not what it happened to start next to.
      const cellX = Math.round(rt.x / CELL), cellY = Math.round(rt.y / CELL);
      for (let i = 0; i < rt.def.w; i++) {
        for (let j = 0; j < rt.def.h; j++) set.add(`${cellX + i},${cellY + j}`);
      }
    }
    return set;
  }

  _renderEntity(rt) {
    if (rt.invisible && !this.debugTriggers) return;
    const ctx = this.ctx;
    const w = rt.def.w * CELL, h = rt.def.h * CELL;
    // Deliberate: none of the passable/invisible/harmless toggles change an
    // entity's look (no dimming, no recoloring) — "invisible" not being
    // rendered at all is the one exception, and that's the point of the
    // toggle, not a stylistic effect. This keeps traps from being telegraphed.
    ctx.save();
    switch (rt.def.type) {
      case ENTITY_TYPES.BLOCK: {
        // Rendered per-cell (not as one wide rect) so neighboring BLOCK cells
        // — from this entity or any other, in any direction — merge into one
        // seamless mass. Deliberately a FLAT fill (no per-cell gradient): a
        // top-to-bottom fade recomputed on every single cell would itself
        // create a visible light/dark banding between vertically stacked
        // cells even with no highlight/shadow line drawn — exactly the seam
        // this is supposed to avoid. Depth comes only from the highlight/
        // shadow strips and outline below, which only ever appear on a
        // cell's genuinely exposed (non-adjacent) edges, in any direction.
        const cells = this._blockCells;
        const cellX = Math.round(rt.x / CELL), cellY = Math.round(rt.y / CELL);
        for (let i = 0; i < rt.def.w; i++) {
          for (let j = 0; j < rt.def.h; j++) {
            const cx = cellX + i, cy = cellY + j;
            const px = rt.x + i * CELL, py = rt.y + j * CELL;
            const hasUp = cells.has(`${cx},${cy - 1}`);
            const hasDown = cells.has(`${cx},${cy + 1}`);
            const hasLeft = cells.has(`${cx - 1},${cy}`);
            const hasRight = cells.has(`${cx + 1},${cy}`);
            ctx.fillStyle = '#181a26';
            ctx.fillRect(px, py, CELL, CELL);
            if (!hasUp) { ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(px, py, CELL, 3); }
            if (!hasDown) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(px, py + CELL - 3, CELL, 3); }
            if (!hasLeft) { ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(px, py, 3, CELL); }
            if (!hasRight) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(px + CELL - 3, py, 3, CELL); }
            ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
            ctx.beginPath();
            if (!hasUp) { ctx.moveTo(px, py + 0.5); ctx.lineTo(px + CELL, py + 0.5); }
            if (!hasDown) { ctx.moveTo(px, py + CELL - 0.5); ctx.lineTo(px + CELL, py + CELL - 0.5); }
            if (!hasLeft) { ctx.moveTo(px + 0.5, py); ctx.lineTo(px + 0.5, py + CELL); }
            if (!hasRight) { ctx.moveTo(px + CELL - 0.5, py); ctx.lineTo(px + CELL - 0.5, py + CELL); }
            ctx.stroke();
          }
        }
        break;
      }
      case ENTITY_TYPES.CRATE: {
        // A simple wooden crate: flat fill, a beveled edge, and a diagonal
        // "X" cross-brace so it reads as a pushable box at a glance (and
        // never gets mistaken for a static BLOCK, even camouflaged ones).
        ctx.fillStyle = '#8a5a34'; ctx.fillRect(rt.x, rt.y, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(rt.x, rt.y, w, 3);
        ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(rt.x, rt.y + h - 3, w, 3);
        ctx.strokeStyle = '#5c3a1e'; ctx.lineWidth = 2;
        ctx.strokeRect(rt.x + 2, rt.y + 2, w - 4, h - 4);
        ctx.beginPath();
        ctx.moveTo(rt.x + 4, rt.y + 4); ctx.lineTo(rt.x + w - 4, rt.y + h - 4);
        ctx.moveTo(rt.x + w - 4, rt.y + 4); ctx.lineTo(rt.x + 4, rt.y + h - 4);
        ctx.stroke();
        break;
      }
      case ENTITY_TYPES.SPIKE: {
        const grad = ctx.createLinearGradient(rt.x, rt.y, rt.x, rt.y + h);
        grad.addColorStop(0, '#ff6b73'); grad.addColorStop(1, '#c1121f');
        ctx.fillStyle = grad;
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.5;
        drawSpikeRow(ctx, rt.x, rt.y, w, h, rt.def.w, rt.facing || 'up', true);
        break;
      }
      case ENTITY_TYPES.SPRING: {
        const dir = (rt.def.props && rt.def.props.direction) || 'up';
        const baseColor = '#8a6d1a';
        const padY = rt.y + h * 0.42, padH = h * 0.58;
        // coils: a few stacked ellipse arcs suggesting a compressed spring
        ctx.strokeStyle = '#d9a52e'; ctx.lineWidth = 3;
        const coils = 3;
        for (let i = 0; i < coils; i++) {
          const cy = rt.y + h * 0.42 + (i + 0.5) * (h * 0.5 / coils);
          ctx.beginPath();
          ctx.ellipse(rt.x + w / 2, cy, w * 0.32, h * 0.09, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        const padGrad = ctx.createLinearGradient(rt.x, padY, rt.x, padY + padH);
        padGrad.addColorStop(0, '#ffe08a'); padGrad.addColorStop(1, '#ffb703');
        ctx.fillStyle = padGrad;
        ctx.fillRect(rt.x + 4, rt.y + h * 0.82, w - 8, h * 0.18);
        ctx.strokeStyle = baseColor; ctx.lineWidth = 2;
        ctx.strokeRect(rt.x + 4, rt.y + h * 0.82, w - 8, h * 0.18);
        ctx.fillStyle = baseColor;
        ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center';
        const arrow = { up: '↑', down: '↓', left: '←', right: '→' }[dir];
        ctx.fillText(arrow, rt.x + w / 2, rt.y + h * 0.35);
        break;
      }
      case ENTITY_TYPES.FAN: {
        const dir = (rt.def.props && rt.def.props.direction) || 'right';
        const cx = rt.x + w / 2, cy = rt.y + h / 2;
        const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, Math.max(w, h) * 0.6);
        grad.addColorStop(0, '#123f4d'); grad.addColorStop(1, '#08222b');
        ctx.fillStyle = grad; ctx.fillRect(rt.x, rt.y, w, h);
        ctx.strokeStyle = '#48cae4'; ctx.lineWidth = 2;
        ctx.strokeRect(rt.x + 2, rt.y + 2, w - 4, h - 4);
        const spin = (this.simTime || 0) * 8;
        ctx.strokeStyle = '#90e0ef';
        for (let i = 0; i < 3; i++) {
          const a = spin + (i / 3) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a) * w * 0.32, cy + Math.sin(a) * h * 0.32);
          ctx.lineWidth = 4;
          ctx.stroke();
        }
        ctx.fillStyle = '#e0fbff';
        ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#90e0ef';
        ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        const arrow = { up: '↑', down: '↓', left: '←', right: '→' }[dir];
        ctx.fillText(arrow, cx, rt.y + h - 6);
        break;
      }
      case ENTITY_TYPES.SPINNER: {
        const cx = rt.x + w / 2, cy = rt.y + h / 2;
        const r = CELL * ((rt.def.props && rt.def.props.radius) || 0.9) * (rt.def.w);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath(); ctx.ellipse(cx, cy + 3, r * 0.4, r * 0.15, 0, 0, Math.PI * 2); ctx.fill();
        const bladeGrad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
        bladeGrad.addColorStop(0, '#ff5c8a'); bladeGrad.addColorStop(1, '#8f0d34');
        ctx.strokeStyle = bladeGrad;
        const spikes = 8;
        for (let i = 0; i < spikes; i++) {
          const a = rt.angle + (i / spikes) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          ctx.lineWidth = 5;
          ctx.stroke();
        }
        const hubGrad = ctx.createRadialGradient(cx - r * 0.1, cy - r * 0.1, 1, cx, cy, r * 0.35);
        hubGrad.addColorStop(0, '#4a4d6b'); hubGrad.addColorStop(1, '#1e2030');
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = hubGrad; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1; ctx.stroke();
        break;
      }
      case ENTITY_TYPES.TELEPORTER: {
        const cx = rt.x + w / 2, cy = rt.y + h / 2;
        const freq = (rt.def.props && rt.def.props.frequency) || 1;
        const spin = (this.simTime || 0) * 3;
        const colors = ['#9d4edd', '#f72585', '#4cc9f0', '#f9c74f', '#43aa8b', '#f3722c', '#577590', '#90be6d'];
        const color = colors[(freq - 1) % colors.length];
        const glow = ctx.createRadialGradient(cx, cy, 1, cx, cy, Math.max(w, h) * 0.6);
        glow.addColorStop(0, color + 'aa'); glow.addColorStop(0.6, color + '33'); glow.addColorStop(1, 'rgba(0,0,0,0.4)');
        ctx.fillStyle = glow; ctx.fillRect(rt.x, rt.y, w, h);
        ctx.strokeStyle = color; ctx.lineWidth = 3;
        for (let ring = 0; ring < 2; ring++) {
          ctx.beginPath();
          ctx.ellipse(cx, cy, (w / 2 - 4) * (1 - ring * 0.3), (h / 2 - 4) * (1 - ring * 0.3), spin + ring, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(String(freq), cx, cy + 4);
        if (rt.def.props && rt.def.props.oneUse) {
          ctx.font = '9px sans-serif'; ctx.fillStyle = color;
          ctx.fillText(rt.usedOnce ? 'utilisé' : '1×', cx, rt.y + h - 4);
        }
        break;
      }
      case ENTITY_TYPES.GOAL: {
        // A recessed sci-fi/vault-style doorway with two fixed-width metal
        // leaves (like an elevator/blast door) that retract into pockets on
        // either side of the frame when open, and slide inward at constant
        // width to meet flush in the middle when the player walks in — see
        // _startDoorClose/_updateDoors. `doorProgress` itself stays linear
        // (it drives winLevel()'s timing), so only its drawing here is eased
        // for a more natural accelerate-then-settle motion.
        const progress = rt.doorProgress || 0; // 0 = open, 1 = fully sealed
        const visual = easeInOutCubic(progress);
        const insetX = Math.max(2, w * 0.08), insetY = Math.max(2, h * 0.04);

        // Recessed frame: a beveled sunken border (light top-left, dark
        // bottom-right) instead of a flat-filled rectangle, so the doorway
        // reads as set INTO a wall rather than painted on top of it.
        const frameGrad = ctx.createLinearGradient(rt.x, rt.y, rt.x, rt.y + h);
        frameGrad.addColorStop(0, '#2a3d68'); frameGrad.addColorStop(1, '#141d38');
        ctx.fillStyle = frameGrad; ctx.fillRect(rt.x, rt.y, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(rt.x + 0.5, rt.y + h - 0.5); ctx.lineTo(rt.x + 0.5, rt.y + 0.5); ctx.lineTo(rt.x + w - 0.5, rt.y + 0.5); ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.beginPath(); ctx.moveTo(rt.x + w - 0.5, rt.y + 0.5); ctx.lineTo(rt.x + w - 0.5, rt.y + h - 0.5); ctx.lineTo(rt.x + 0.5, rt.y + h - 0.5); ctx.stroke();

        const innerX = rt.x + insetX, innerY = rt.y + insetY;
        const innerW = w - insetX * 2, innerH = h - insetY;
        ctx.fillStyle = '#05060a';
        ctx.fillRect(innerX, innerY, innerW, innerH);

        // a bright threshold plate along the bottom of the opening
        const sillH = Math.max(1.5, h * 0.035);
        ctx.fillStyle = 'rgba(180,205,255,0.35)';
        ctx.fillRect(innerX, innerY + innerH - sillH, innerW, sillH);

        // Two fixed-width leaves sliding from each pocket toward the center.
        // At progress=0 each leaf is tucked almost entirely into its side
        // wall (only a sliver shows, hinting it's ready to slide); at
        // progress=1 they meet exactly in the middle with no gap.
        const halfW = innerW / 2;
        const restShow = halfW * 0.14; // sliver still visible when fully open
        const travel = halfW - restShow;
        const leafW = halfW; // constant width the whole time — a rigid leaf, not a stretching curtain
        const leftLeafX = innerX - (halfW - restShow) + travel * visual;
        const rightLeafX = innerX + innerW - restShow - travel * visual;

        const drawLeaf = (leafX, mirrored) => {
          ctx.save();
          ctx.beginPath();
          ctx.rect(innerX, innerY, innerW, innerH);
          ctx.clip(); // never spill past the doorway opening
          const grad = ctx.createLinearGradient(leafX, 0, leafX + leafW, 0);
          if (mirrored) {
            grad.addColorStop(0, '#2d6cdf'); grad.addColorStop(0.5, '#7fb0f5'); grad.addColorStop(1, '#3a78e6');
          } else {
            grad.addColorStop(0, '#3a78e6'); grad.addColorStop(0.5, '#7fb0f5'); grad.addColorStop(1, '#2d6cdf');
          }
          ctx.fillStyle = grad;
          ctx.fillRect(leafX, innerY, leafW, innerH);
          // horizontal panel grooves for a machined-metal feel
          ctx.strokeStyle = 'rgba(10,20,50,0.35)'; ctx.lineWidth = 1;
          for (let g = 1; g <= 3; g++) {
            const gy = innerY + (innerH * g) / 4;
            ctx.beginPath(); ctx.moveTo(leafX, gy); ctx.lineTo(leafX + leafW, gy); ctx.stroke();
          }
          // bright bevel on the leading edge (the edge that meets the other leaf)
          ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.5;
          const edgeX = mirrored ? leafX + 0.75 : leafX + leafW - 0.75;
          ctx.beginPath(); ctx.moveTo(edgeX, innerY + 1); ctx.lineTo(edgeX, innerY + innerH - 1); ctx.stroke();
          ctx.restore();
        };
        drawLeaf(leftLeafX, false);
        drawLeaf(rightLeafX, true);

        // a soft glow from the still-open gap between the leaves, fading out as it closes
        if (progress < 1) {
          const gapX = leftLeafX + leafW, gapW = rightLeafX - gapX;
          if (gapW > 0.5) {
            ctx.fillStyle = `rgba(120,190,255,${0.28 * (1 - visual)})`;
            ctx.fillRect(gapX, innerY, gapW, innerH);
          }
        }

        // Status light on the frame's lintel: red while open/closing, flips
        // to green once the leaves have actually sealed (progress >= 1).
        const lightX = rt.x + w / 2, lightY = rt.y + insetY * 0.55;
        const sealed = progress >= 1;
        ctx.fillStyle = sealed ? '#3ee06a' : '#e0463e';
        ctx.save();
        ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = sealed ? 6 : 3;
        ctx.beginPath(); ctx.arc(lightX, lightY, Math.max(1.5, w * 0.03), 0, Math.PI * 2); ctx.fill();
        ctx.restore();

        // the center bolt/handle, only visible once the leaves have met
        if (progress > 0.9) {
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          ctx.beginPath(); ctx.arc(innerX + innerW / 2, innerY + innerH * 0.55, Math.max(1.5, w * 0.035), 0, Math.PI * 2); ctx.fill();
        }
        break;
      }
      case ENTITY_TYPES.CHECKPOINT: {
        // A little flagpole planted in the ground: a soft contact shadow, a
        // gradient pole with a small ball cap, and a cloth flag that ripples
        // and glows once activated instead of a flat, static triangle.
        const active = rt.activated;
        const poleX = rt.x + w * 0.34;
        const poleW = Math.max(2, w * 0.07);
        const poleTopY = rt.y + h * 0.04;
        const groundY = rt.y + h;

        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(poleX + poleW / 2, groundY - 1, w * 0.22, Math.max(1.5, h * 0.035), 0, 0, Math.PI * 2);
        ctx.fill();

        const poleGrad = ctx.createLinearGradient(poleX, 0, poleX + poleW, 0);
        poleGrad.addColorStop(0, active ? '#d8f6fb' : '#6b7980');
        poleGrad.addColorStop(1, active ? '#5fa9bc' : '#37444b');
        ctx.fillStyle = poleGrad;
        ctx.fillRect(poleX, poleTopY, poleW, groundY - poleTopY);

        ctx.fillStyle = active ? '#eafdff' : '#87959c';
        ctx.beginPath();
        ctx.arc(poleX + poleW / 2, poleTopY, Math.max(2, w * 0.05), 0, Math.PI * 2);
        ctx.fill();

        const wave = active ? Math.sin((this.simTime || 0) * 5) * w * 0.045 : 0;
        const flagTop = poleTopY + h * 0.06;
        const flagH = h * 0.36;
        const flagW = w * 0.52;
        if (active) {
          ctx.save();
          ctx.shadowColor = 'rgba(90,220,255,0.55)';
          ctx.shadowBlur = 8;
        }
        const flagGrad = ctx.createLinearGradient(poleX, flagTop, poleX + flagW, flagTop);
        flagGrad.addColorStop(0, active ? '#5fe0f2' : '#526169');
        flagGrad.addColorStop(1, active ? '#0f8fae' : '#334147');
        ctx.fillStyle = flagGrad;
        ctx.beginPath();
        ctx.moveTo(poleX + poleW, flagTop);
        ctx.quadraticCurveTo(poleX + flagW * 0.6 + wave, flagTop + flagH * 0.16, poleX + flagW + wave, flagTop + flagH * 0.4);
        ctx.quadraticCurveTo(poleX + flagW * 0.6 + wave, flagTop + flagH * 0.64, poleX + poleW, flagTop + flagH);
        ctx.closePath();
        ctx.fill();
        if (active) ctx.restore();
        ctx.strokeStyle = active ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // a single fold line for a bit of cloth-like depth
        ctx.strokeStyle = active ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(poleX + poleW, flagTop + flagH * 0.14);
        ctx.quadraticCurveTo(poleX + flagW * 0.55 + wave, flagTop + flagH * 0.3, poleX + flagW * 0.88 + wave, flagTop + flagH * 0.4);
        ctx.stroke();
        break;
      }
      case ENTITY_TYPES.TRIGGER:
        // Triggers are always invisible in real play — only the editor's
        // debug/playtest view reveals their zone, never actual gameplay.
        if (this.debugTriggers) {
          ctx.fillStyle = 'rgba(255,255,0,0.15)';
          ctx.strokeStyle = 'rgba(255,255,0,0.6)';
          ctx.fillRect(rt.x, rt.y, w, h);
          ctx.strokeRect(rt.x, rt.y, w, h);
          if (rt.def.props && rt.def.props.loop) { ctx.font = '10px sans-serif'; ctx.fillStyle = '#ffff88'; ctx.textAlign = 'center'; ctx.fillText('∞', rt.x + w / 2, rt.y + h / 2 + 3); }
        }
        break;
      case ENTITY_TYPES.BUTTON: {
        // A button is deliberately visible (unlike a trigger) so the player
        // can tell it's there and understand it can be pressed again once
        // its actions have finished playing.
        // Purely cosmetic facing rotation (see _facingAngle) — the
        // activation area stays the full cell, overlap-based, unaffected.
        const facingAngle = this._facingAngle(rt.def.props && rt.def.props.facing);
        if (facingAngle) {
          const bcx = rt.x + w / 2, bcy = rt.y + h / 2;
          ctx.translate(bcx, bcy); ctx.rotate(facingAngle); ctx.translate(-bcx, -bcy);
        }
        const cooling = !rt.buttonReady;
        const housingGrad = ctx.createLinearGradient(rt.x, rt.y, rt.x, rt.y + h);
        housingGrad.addColorStop(0, '#383c52'); housingGrad.addColorStop(1, '#22242f');
        ctx.fillStyle = housingGrad; ctx.fillRect(rt.x, rt.y, w, h);
        ctx.strokeStyle = '#5b5f7a'; ctx.lineWidth = 2;
        ctx.strokeRect(rt.x + 2, rt.y + 2, w - 4, h - 4);
        const padH = cooling ? h * 0.22 : h * 0.32;
        const padColor = cooling ? ['#f6a35c', '#c9660f'] : ['#3ee9b8', '#06a879'];
        const padGrad = ctx.createLinearGradient(rt.x, rt.y + h - padH - h * 0.12, rt.x, rt.y + h - h * 0.12);
        padGrad.addColorStop(0, padColor[0]); padGrad.addColorStop(1, padColor[1]);
        ctx.fillStyle = padGrad;
        ctx.fillRect(rt.x + w * 0.18, rt.y + h - padH - h * 0.12, w * 0.64, padH);
        ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.strokeRect(rt.x + w * 0.18, rt.y + h - padH - h * 0.12, w * 0.64, padH);
        break;
      }
      case ENTITY_TYPES.PLATE: {
        // A pressure plate sits flush and low, and visibly compresses while
        // the player is standing on it (rt.holding / rt.looping).
        // Purely cosmetic facing rotation (see _facingAngle) — the
        // activation area stays the full cell, overlap-based, unaffected.
        const plateFacingAngle = this._facingAngle(rt.def.props && rt.def.props.facing);
        if (plateFacingAngle) {
          const pcx = rt.x + w / 2, pcy = rt.y + h / 2;
          ctx.translate(pcx, pcy); ctx.rotate(plateFacingAngle); ctx.translate(-pcx, -pcy);
        }
        const pressed = rt.holding || rt.looping;
        const plateH = pressed ? h * 0.18 : h * 0.28;
        const grad = ctx.createLinearGradient(rt.x, rt.y + h - plateH, rt.x, rt.y + h);
        grad.addColorStop(0, pressed ? '#ffe08a' : '#c98a2b');
        grad.addColorStop(1, pressed ? '#ff9f1c' : '#7a531a');
        ctx.fillStyle = grad;
        ctx.fillRect(rt.x + 3, rt.y + h - plateH, w - 6, plateH);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.5;
        ctx.strokeRect(rt.x + 3, rt.y + h - plateH, w - 6, plateH);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath(); ctx.moveTo(rt.x + 5, rt.y + h - plateH + 2); ctx.lineTo(rt.x + w - 5, rt.y + h - plateH + 2); ctx.stroke();
        break;
      }
    }
    ctx.restore();
  }

  // `p` defaults to player 1; player 2 (see this.players/reset) gets a
  // distinct blue palette instead of orange so the two are never confused at
  // a glance — everything else about the sprite (shape, rotation, face) is
  // identical between them.
  _renderPlayer(p = this.player) {
    if ((p.invisible || this._hidePlayerForDoor) && !this.debugTriggers) return;
    const ctx = this.ctx;
    const isP2 = p === this.player2;
    ctx.save();
    // Rotate the whole sprite around its own center so its "feet" always
    // face the current gravity direction — upside-down when gravity is
    // flipped, sideways when walking on a side wall. Inverted controls
    // (troll) are a pure gameplay effect now: no recolor, no mouth swap —
    // there is nothing to see, on purpose.
    const angle = { down: 0, up: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 }[this._effectiveGravityDir(p.gravityDir)] || 0;
    ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
    ctx.rotate(angle);
    ctx.translate(-p.w / 2, -p.h / 2);
    // Everything below is drawn in LOCAL coordinates — (0,0) is the
    // sprite's own top-left, as if gravity still pointed down.
    const w = p.w, h = p.h;

    // soft drop shadow for a bit of depth
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    roundRect(ctx, 2, h - 5, w - 4, 6, 3);
    ctx.fill();

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    if (isP2) { grad.addColorStop(0, '#2ec4ff'); grad.addColorStop(1, '#0d7fb8'); }
    else { grad.addColorStop(0, '#f77f00'); grad.addColorStop(1, '#d1600a'); }
    ctx.fillStyle = grad;
    roundRect(ctx, 0, 0, w, h, w * 0.28);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, 1, 1, w - 2, h - 2, w * 0.24);
    ctx.stroke();

    // face: two eyes looking in the facing direction, small mouth
    const eyeSize = Math.max(3, w * 0.16);
    const eyeY = h * 0.35;
    const spread = w * 0.22;
    const cx = w / 2;
    const lookOffset = p.facing * w * 0.06;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(cx - spread, eyeY, eyeSize, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + spread, eyeY, eyeSize, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1b1e2b';
    const pupilR = eyeSize * 0.55;
    ctx.beginPath(); ctx.arc(cx - spread + lookOffset, eyeY, pupilR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + spread + lookOffset, eyeY, pupilR, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = '#1b1e2b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.16, h * 0.62);
    ctx.quadraticCurveTo(cx, h * 0.74, cx + w * 0.16, h * 0.62);
    ctx.stroke();
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Draws a row (or column, for left/right-facing) of triangular spikes so the
// hazard visually points the way its `facing` prop says, even though the
// hitbox stays a simple axis-aligned box.
function drawSpikeRow(ctx, x, y, w, h, cellsWide, facing, stroke = false) {
  if (facing === 'up' || facing === 'down') {
    for (let i = 0; i < cellsWide; i++) {
      const bx = x + i * CELL;
      ctx.beginPath();
      if (facing === 'up') {
        ctx.moveTo(bx, y + h); ctx.lineTo(bx + CELL / 2, y); ctx.lineTo(bx + CELL, y + h);
      } else {
        ctx.moveTo(bx, y); ctx.lineTo(bx + CELL / 2, y + h); ctx.lineTo(bx + CELL, y);
      }
      ctx.closePath();
      ctx.fill();
      if (stroke) ctx.stroke();
    }
  } else {
    const rowsTall = Math.max(1, Math.round(h / CELL));
    for (let i = 0; i < rowsTall; i++) {
      const by = y + i * CELL;
      ctx.beginPath();
      if (facing === 'left') {
        ctx.moveTo(x + w, by); ctx.lineTo(x, by + CELL / 2); ctx.lineTo(x + w, by + CELL);
      } else {
        ctx.moveTo(x, by); ctx.lineTo(x + w, by + CELL / 2); ctx.lineTo(x, by + CELL);
      }
      ctx.closePath();
      ctx.fill();
      if (stroke) ctx.stroke();
    }
  }
}
