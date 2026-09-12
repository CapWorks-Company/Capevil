// Core game engine: physics, collisions, triggers, rendering.
// Framework-free, canvas 2D. Designed to be driven by game.js (play mode)
// and reused (read-only, no input) by editor.js for in-editor testing.
import {
  CELL, ENTITY_TYPES, HAZARD_TYPES, SOLID_TYPES,
  GRAVITY_VECTORS, ACTION_TYPES, TRIGGER_MODES, PHYSICS,
} from './constants.js';

const KEY_MAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  Space: 'jump',
};

export class Engine {
  constructor(canvas, level, { onDeath, onWin, onStateChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.level = level;
    this.onDeath = onDeath || (() => {});
    this.onWin = onWin || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.raw = { left: false, right: false, up: false, down: false, jump: false };
    this.debugTriggers = false;
    this._keydown = (e) => this._setKey(e.code, true);
    this._keyup = (e) => this._setKey(e.code, false);
    window.addEventListener('keydown', this._keydown);
    window.addEventListener('keyup', this._keyup);
    this.reset();
  }

  destroy() {
    window.removeEventListener('keydown', this._keydown);
    window.removeEventListener('keyup', this._keyup);
    cancelAnimationFrame(this._raf);
  }

  _setKey(code, val) {
    const k = KEY_MAP[code];
    if (!k) return;
    this.raw[k] = val;
    if (val) this._lastJumpPress = k === 'jump' ? performance.now() : this._lastJumpPress;
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
    this.respawn = { x: lvl.playerStart.x, y: lvl.playerStart.y };
    this._buildRuntime();
    this._resetPlayer();
    this.scheduled = []; // [{time, run}]
    this._teleportCooldown = 0;
    this.camera = { x: 0, y: 0 };
    this.onStateChange({ deaths: this.deaths });
  }

  _buildRuntime() {
    this.runtime = new Map();
    for (const ent of this.level.entities) {
      this.runtime.set(ent.id, {
        def: ent,
        x: ent.x * CELL, y: ent.y * CELL,
        passable: !!ent.passable, invisible: !!ent.invisible, harmless: !!ent.harmless,
        anim: null, // { fromX,fromY,toX,toY,startTime,duration }
        dx: 0, dy: 0, // this-frame movement delta, for carrying the player along
        angle: 0,
        firedOnce: false,
        wasOverlapping: false,
        activated: false,
        usedOnce: false,
        buttonReadyAt: 0,
      });
    }
  }

  _resetPlayer() {
    const lvl = this.level;
    this.player = {
      x: this.respawn.x * CELL, y: this.respawn.y * CELL,
      w: CELL * 0.7, h: CELL * 0.7,
      vx: 0, vy: 0,
      gravityDir: 'down',
      invert: { horizontal: false, vertical: false },
      jumpMult: 1, speedMult: 1,
      onGround: false,
      facing: 1,
      windVx: 0, windVy: 0, // persistent push from FAN zones, layered on top of input-driven velocity
    };
    // center the smaller hitbox inside its cell
    this.player.x += (CELL - this.player.w) / 2;
    this.player.y += (CELL - this.player.h) / 2;
  }

  // Puts every runtime entity back to its authored definition (position,
  // toggles, animation) and clears trigger/scheduled-action state, without
  // touching `this.respawn` (checkpoints must survive a death).
  _resetRuntimeState() {
    this.scheduled = [];
    this._teleportCooldown = 0;
    for (const rt of this.runtime.values()) {
      const def = rt.def;
      rt.x = def.x * CELL; rt.y = def.y * CELL;
      rt.passable = !!def.passable; rt.invisible = !!def.invisible; rt.harmless = !!def.harmless;
      rt.anim = null; rt.dx = 0; rt.dy = 0; rt.angle = 0;
      rt.firedOnce = false; rt.wasOverlapping = false; rt.usedOnce = false;
      rt.buttonReadyAt = 0;
      if (def.type !== ENTITY_TYPES.CHECKPOINT) rt.activated = false;
    }
  }

  start() {
    this._last = performance.now();
    const loop = (t) => {
      const dt = Math.min((t - this._last) / 1000, 1 / 30);
      this._last = t;
      if (!this.dead && !this.won) this.update(dt);
      this.render();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() { cancelAnimationFrame(this._raf); }

  // ---- effective input, accounting for troll inversion ----
  _input() {
    let { left, right, up, down, jump } = this.raw;
    if (this.player.invert.horizontal) [left, right] = [right, left];
    if (this.player.invert.vertical) [up, down] = [down, up];
    return { left, right, up, down, jump };
  }

  killPlayer() {
    if (this.dead) return;
    this.dead = true;
    this.deaths++;
    this.onStateChange({ deaths: this.deaths });
    this.onDeath();
    setTimeout(() => {
      this.dead = false;
      this._resetRuntimeState();
      this._resetPlayer();
    }, 450);
  }

  winLevel() {
    if (this.won) return;
    this.won = true;
    this.onWin({ deaths: this.deaths });
  }

  // ---------------------------------------------------------------- update
  update(dt) {
    this.simTime += dt;
    if (this._teleportCooldown > 0) this._teleportCooldown -= dt;
    this._runScheduled();
    this._updateMovers(dt);
    this._applyFans(dt);
    this._updatePhysics(dt);
    this._updateSpinnerAngles(dt);
    this._checkTriggers();
    this._checkButtons();
    this._checkHazardsAndGoal();
    this._checkTeleporters();
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
        rt.angle += speed * dt;
      }
    }
  }

  // Continuous wind push from FAN zones while the player overlaps them
  // (unlike a spring's one-shot impulse). Left/right is the main use case
  // requested, but any direction works. Builds up in `player.windVx/windVy`
  // — a persistent contribution layered on top of whatever `_updatePhysics`
  // computes for input/gravity that same frame — rather than writing
  // straight into `vx`/`vy`, which would get overwritten immediately by the
  // movement-axis input logic (that logic unconditionally sets velocity from
  // the arrow keys each frame, Level-Devil-style, with no separate friction
  // step to layer external forces onto).
  _applyFans(dt) {
    const p = this.player;
    let pushedX = false, pushedY = false;
    for (const rt of this.runtime.values()) {
      if (rt.def.type !== ENTITY_TYPES.FAN || rt.passable) continue;
      const box = { x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL };
      if (!this._overlap(p, box)) continue;
      const dir = (rt.def.props && rt.def.props.direction) || 'right';
      const v = GRAVITY_VECTORS[dir];
      const force = (rt.def.props && rt.def.props.force) ?? 1;
      const accel = PHYSICS.GRAVITY_ACCEL * force;
      const maxSpeed = PHYSICS.MOVE_SPEED * 1.8 * force;
      if (v.x) { pushedX = true; p.windVx += v.x * accel * dt; p.windVx = Math.max(-maxSpeed, Math.min(maxSpeed, p.windVx)); }
      if (v.y) { pushedY = true; p.windVy += v.y * accel * dt; p.windVy = Math.max(-maxSpeed, Math.min(maxSpeed, p.windVy)); }
    }
    // decay back to zero once the player leaves every fan zone
    if (!pushedX) p.windVx *= 0.8;
    if (!pushedY) p.windVy *= 0.8;
    if (Math.abs(p.windVx) < 1) p.windVx = 0;
    if (Math.abs(p.windVy) < 1) p.windVy = 0;
  }

  _solidRects() {
    const rects = [];
    for (const rt of this.runtime.values()) {
      const t = rt.def.type;
      if (!SOLID_TYPES.has(t)) continue;
      if (rt.passable) continue; // invisible solids are still fully solid
      rects.push({ id: rt.def.id, x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL, dx: rt.dx || 0, dy: rt.dy || 0 });
    }
    return rects;
  }

  _updatePhysics(dt) {
    const p = this.player;
    const g = GRAVITY_VECTORS[p.gravityDir];
    const input = this._input();

    // acceleration due to gravity
    p.vx += g.x * PHYSICS.GRAVITY_ACCEL * dt;
    p.vy += g.y * PHYSICS.GRAVITY_ACCEL * dt;
    // clamp fall speed along gravity axis
    const fallSpeed = p.vx * g.x + p.vy * g.y;
    if (fallSpeed > PHYSICS.MAX_FALL_SPEED) {
      p.vx = g.x * PHYSICS.MAX_FALL_SPEED + p.vx * (1 - Math.abs(g.x));
      p.vy = g.y * PHYSICS.MAX_FALL_SPEED + p.vy * (1 - Math.abs(g.y));
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
    }

    // integrate + resolve collisions on each axis separately
    const rects = this._solidRects();
    p.onGround = false;

    p.x += p.vx * dt;
    this._resolveAxis(p, rects, 'x', g);
    p.y += p.vy * dt;
    this._resolveAxis(p, rects, 'y', g);

    // out of level bounds -> death
    const margin = CELL * 2;
    if (p.x < -margin || p.y < -margin ||
        p.x > this.level.cols * CELL + margin || p.y > this.level.rows * CELL + margin) {
      this.killPlayer();
    }
  }

  _resolveAxis(p, rects, axis, g) {
    for (const r of rects) {
      if (!this._overlap(p, r)) continue;
      if (axis === 'x') {
        if (p.vx > 0) p.x = r.x - p.w;
        else if (p.vx < 0) p.x = r.x + r.w;
        p.vx = 0;
      } else {
        if (p.vy > 0) p.y = r.y - p.h;
        else if (p.vy < 0) p.y = r.y + r.h;
        p.vy = 0;
      }
      // grounded if the collision happened against the side gravity pushes into
      const pushingInto = (axis === 'x' && g.x !== 0) || (axis === 'y' && g.y !== 0);
      if (pushingInto) {
        p.onGround = true;
        // Conveyor behaviour: carry the player along with a moving platform
        // (the axis perpendicular to gravity, i.e. the one the player walks on).
        if (axis === 'y' && r.dx) p.x += r.dx;
        if (axis === 'x' && r.dy) p.y += r.dy;
      }
    }
  }

  _overlap(p, r) {
    return p.x < r.x + r.w && p.x + p.w > r.x && p.y < r.y + r.h && p.y + p.h > r.y;
  }

  _checkHazardsAndGoal() {
    const p = this.player;
    for (const rt of this.runtime.values()) {
      const t = rt.def.type;
      const box = { x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL };
      if (!this._overlap(p, box)) continue;

      if (HAZARD_TYPES.has(t)) {
        if (!rt.harmless && !rt.passable) this.killPlayer();
        continue;
      }
      if (t === ENTITY_TYPES.SPRING && !rt.passable) {
        const dir = (rt.def.props && rt.def.props.direction) || 'up';
        const power = ((rt.def.props && rt.def.props.power) || 1.6) * PHYSICS.JUMP_POWER;
        const v = GRAVITY_VECTORS[dir]; // direct push direction (not opposed like gravity)
        p.vx = v.x * power; p.vy = v.y * power;
      }
      if (t === ENTITY_TYPES.GOAL) {
        this.winLevel();
      }
      if (t === ENTITY_TYPES.CHECKPOINT && !rt.activated) {
        rt.activated = true;
        this.respawn = { x: rt.def.x, y: rt.def.y };
      }
    }
  }

  // Teleporters sharing the same `frequency` cycle the player through the
  // group in authored order. A `oneUse` teleporter disables only itself
  // (its entrance) once used, so you can't walk straight back through it.
  _checkTeleporters() {
    if (this._teleportCooldown > 0) return;
    const p = this.player;
    for (const rt of this.runtime.values()) {
      if (rt.def.type !== ENTITY_TYPES.TELEPORTER) continue;
      if (rt.passable || rt.usedOnce) continue;
      const box = { x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL };
      if (!this._overlap(p, box)) continue;
      this._teleportViaGroup(rt);
      break; // at most one teleport per frame
    }
  }

  _teleportViaGroup(rt) {
    const freq = (rt.def.props && rt.def.props.frequency) || 1;
    const group = this.level.entities.filter(e => e.type === ENTITY_TYPES.TELEPORTER && ((e.props && e.props.frequency) || 1) === freq);
    if (group.length < 2) return;
    const idx = group.findIndex(e => e.id === rt.def.id);
    const nextDef = group[(idx + 1) % group.length];
    const targetRt = this.runtime.get(nextDef.id);
    if (!targetRt) return;
    const p = this.player;
    p.x = targetRt.x + (nextDef.w * CELL - p.w) / 2;
    p.y = targetRt.y + (nextDef.h * CELL - p.h) / 2;
    this._teleportCooldown = 0.5;
    if (rt.def.props && rt.def.props.oneUse) rt.usedOnce = true;
  }

  _checkTriggers() {
    const p = this.player;
    for (const rt of this.runtime.values()) {
      if (rt.def.type !== ENTITY_TYPES.TRIGGER) continue;
      const box = { x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL };
      const overlapping = this._overlap(p, box);
      const mode = (rt.def.props && rt.def.props.mode) || TRIGGER_MODES.ONCE;

      if (overlapping && !rt.wasOverlapping) {
        if (mode === TRIGGER_MODES.ONCE) {
          if (!rt.firedOnce) { rt.firedOnce = true; this._fireTrigger(rt); }
        } else if (mode === TRIGGER_MODES.REPEAT) {
          this._fireTrigger(rt);
        } else if (mode === TRIGGER_MODES.LOOP) {
          if (!rt.firedOnce) { rt.firedOnce = true; this._startLoop(rt); }
        }
      }
      if (!overlapping && rt.wasOverlapping && mode === TRIGGER_MODES.ON_EXIT) {
        this._fireTrigger(rt);
      }
      rt.wasOverlapping = overlapping;
    }
  }

  // A button is a visible, physical switch: unlike a trigger it can be
  // pressed again and again, gated only by its own reset cooldown — no
  // "once/repeat/onExit" mode to configure. Fires on entry (edge-triggered,
  // like triggers) whenever the cooldown from its last press has elapsed.
  _checkButtons() {
    const p = this.player;
    for (const rt of this.runtime.values()) {
      if (rt.def.type !== ENTITY_TYPES.BUTTON) continue;
      const box = { x: rt.x, y: rt.y, w: rt.def.w * CELL, h: rt.def.h * CELL };
      const overlapping = this._overlap(p, box);
      if (overlapping && !rt.wasOverlapping && this.simTime >= rt.buttonReadyAt) {
        this._fireTrigger(rt);
        const cooldown = Math.max(0.05, (rt.def.props && rt.def.props.cooldown) ?? 1);
        rt.buttonReadyAt = this.simTime + cooldown;
      }
      rt.wasOverlapping = overlapping;
    }
  }

  // Fires the trigger's action list once, then re-schedules itself after
  // `loopInterval` seconds — an autonomous, self-repeating behaviour (e.g.
  // "go left 3 cells, wait 1s, come back, wait 2s...") that keeps running
  // without the player needing to re-enter the zone. Cleared automatically
  // on death/reset because `this.scheduled` is wiped there.
  _startLoop(triggerRt) {
    const interval = Math.max(0.2, (triggerRt.def.props && triggerRt.def.props.loopInterval) || 2);
    const run = () => {
      this._fireTrigger(triggerRt);
      this.scheduled.push({ time: this.simTime + interval, run });
    };
    run();
  }

  _fireTrigger(triggerRt) {
    const actions = (triggerRt.def.props && triggerRt.def.props.actions) || [];
    for (const action of actions) {
      const runAt = this.simTime + (action.delay || 0);
      this.scheduled.push({ time: runAt, run: () => this._runAction(action) });
    }
  }

  _runAction(action) {
    const p = this.player;
    const target = action.targetId === 'player' ? null : this.runtime.get(action.targetId);
    switch (action.type) {
      case ACTION_TYPES.MOVE_ELEMENT: {
        if (!target) return;
        const dx = (action.params.dx || 0) * CELL;
        const dy = (action.params.dy || 0) * CELL;
        target.anim = {
          fromX: target.x, fromY: target.y,
          toX: target.x + dx, toY: target.y + dy,
          startTime: this.simTime,
          duration: Math.max(0.05, action.params.duration || 0.5),
        };
        break;
      }
      case ACTION_TYPES.TELEPORT: {
        if (action.targetId === 'player') {
          p.x = action.params.x * CELL; p.y = action.params.y * CELL;
        } else if (target) {
          target.x = action.params.x * CELL; target.y = action.params.y * CELL;
          target.anim = null;
        }
        break;
      }
      case ACTION_TYPES.SET_STATE: {
        if (target) {
          const params = action.params || {};
          if ('passable' in params) target.passable = !!params.passable;
          if ('invisible' in params) target.invisible = !!params.invisible;
          if ('harmless' in params) target.harmless = !!params.harmless;
        }
        break;
      }
      case ACTION_TYPES.SET_GRAVITY: {
        p.gravityDir = action.params.direction;
        break;
      }
      case ACTION_TYPES.INVERT_CONTROLS: {
        const axis = action.params.axis || 'horizontal';
        const enabled = action.params.enabled !== false;
        if (axis === 'both') { p.invert.horizontal = enabled; p.invert.vertical = enabled; }
        else p.invert[axis] = enabled;
        if (action.params.duration) {
          setTimeout(() => {
            if (axis === 'both') { p.invert.horizontal = false; p.invert.vertical = false; }
            else p.invert[axis] = false;
          }, action.params.duration * 1000);
        }
        break;
      }
      case ACTION_TYPES.SET_JUMP_POWER: {
        p.jumpMult = action.params.value;
        if (action.params.duration) setTimeout(() => { p.jumpMult = 1; }, action.params.duration * 1000);
        break;
      }
      case ACTION_TYPES.SET_SPEED: {
        p.speedMult = action.params.value;
        if (action.params.duration) setTimeout(() => { p.speedMult = 1; }, action.params.duration * 1000);
        break;
      }
      default: break;
    }
  }

  _updateCamera() {
    const cv = this.canvas;
    const lvl = this.level;
    const levelW = lvl.cols * CELL, levelH = lvl.rows * CELL;
    let cx = this.player.x - cv.width / 3;
    let cy = this.player.y - cv.height / 2;
    cx = Math.max(0, Math.min(cx, Math.max(0, levelW - cv.width)));
    cy = Math.max(0, Math.min(cy, Math.max(0, levelH - cv.height)));
    this.camera.x = cx; this.camera.y = cy;
  }

  // ---------------------------------------------------------------- render
  render() {
    const ctx = this.ctx, cv = this.canvas;
    ctx.fillStyle = '#1b1e2b';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.translate(-this.camera.x, -this.camera.y);

    // grid backdrop
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    const startCol = Math.floor(this.camera.x / CELL), endCol = startCol + Math.ceil(cv.width / CELL) + 1;
    const startRow = Math.floor(this.camera.y / CELL), endRow = startRow + Math.ceil(cv.height / CELL) + 1;
    for (let c = startCol; c <= endCol; c++) {
      ctx.beginPath(); ctx.moveTo(c * CELL, startRow * CELL); ctx.lineTo(c * CELL, endRow * CELL); ctx.stroke();
    }
    for (let r = startRow; r <= endRow; r++) {
      ctx.beginPath(); ctx.moveTo(startCol * CELL, r * CELL); ctx.lineTo(endCol * CELL, r * CELL); ctx.stroke();
    }

    for (const rt of this.runtime.values()) this._renderEntity(rt);
    this._renderPlayer();

    ctx.restore();
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
      case ENTITY_TYPES.BLOCK:
        ctx.fillStyle = '#111319';
        ctx.strokeStyle = '#3a3f52';
        ctx.lineWidth = 2;
        ctx.fillRect(rt.x, rt.y, w, h);
        ctx.strokeRect(rt.x + 1, rt.y + 1, w - 2, h - 2);
        break;
      case ENTITY_TYPES.PLATFORM:
        ctx.fillStyle = '#2d6cdf';
        ctx.fillRect(rt.x, rt.y, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fillRect(rt.x, rt.y, w, 4);
        break;
      case ENTITY_TYPES.SPIKE: {
        ctx.fillStyle = '#e63946';
        drawSpikeRow(ctx, rt.x, rt.y, w, h, rt.def.w, (rt.def.props && rt.def.props.facing) || 'up');
        break;
      }
      case ENTITY_TYPES.SPRING: {
        ctx.fillStyle = '#ffd166';
        ctx.fillRect(rt.x + 4, rt.y + h * 0.4, w - 8, h * 0.6);
        ctx.strokeStyle = '#8a6d1a'; ctx.lineWidth = 2;
        ctx.strokeRect(rt.x + 4, rt.y + h * 0.4, w - 8, h * 0.6);
        const dir = (rt.def.props && rt.def.props.direction) || 'up';
        ctx.fillStyle = '#8a6d1a';
        ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
        const arrow = { up: '↑', down: '↓', left: '←', right: '→' }[dir];
        ctx.fillText(arrow, rt.x + w / 2, rt.y + h * 0.35);
        break;
      }
      case ENTITY_TYPES.FAN: {
        const dir = (rt.def.props && rt.def.props.direction) || 'right';
        ctx.fillStyle = '#0d3b4a';
        ctx.fillRect(rt.x, rt.y, w, h);
        ctx.strokeStyle = '#48cae4'; ctx.lineWidth = 2;
        ctx.strokeRect(rt.x + 2, rt.y + 2, w - 4, h - 4);
        // little swirl blades
        const cx = rt.x + w / 2, cy = rt.y + h / 2;
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
        ctx.fillStyle = '#90e0ef';
        ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
        const arrow = { up: '↑', down: '↓', left: '←', right: '→' }[dir];
        ctx.fillText(arrow, cx, rt.y + h - 6);
        break;
      }
      case ENTITY_TYPES.SPINNER: {
        const cx = rt.x + w / 2, cy = rt.y + h / 2;
        const r = CELL * ((rt.def.props && rt.def.props.radius) || 0.9) * (rt.def.w);
        ctx.fillStyle = '#c9184a';
        ctx.strokeStyle = '#c9184a';
        const spikes = 8;
        for (let i = 0; i < spikes; i++) {
          const a = rt.angle + (i / spikes) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          ctx.lineWidth = 5;
          ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = '#2b2d42'; ctx.fill();
        break;
      }
      case ENTITY_TYPES.TELEPORTER: {
        const cx = rt.x + w / 2, cy = rt.y + h / 2;
        const freq = (rt.def.props && rt.def.props.frequency) || 1;
        const spin = (this.simTime || 0) * 3;
        const colors = ['#9d4edd', '#f72585', '#4cc9f0', '#f9c74f', '#43aa8b', '#f3722c', '#577590', '#90be6d'];
        const color = colors[(freq - 1) % colors.length];
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(rt.x, rt.y, w, h);
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
      case ENTITY_TYPES.GOAL:
        ctx.fillStyle = '#2ec4b6';
        ctx.fillRect(rt.x, rt.y, w, h);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('⚑', rt.x + w / 2, rt.y + h / 2 + 5);
        break;
      case ENTITY_TYPES.CHECKPOINT:
        ctx.fillStyle = rt.activated ? '#118ab2' : '#3a6b7a';
        ctx.fillRect(rt.x + w * 0.35, rt.y, w * 0.1, h);
        ctx.beginPath();
        ctx.moveTo(rt.x + w * 0.45, rt.y + h * 0.15);
        ctx.lineTo(rt.x + w * 0.9, rt.y + h * 0.3);
        ctx.lineTo(rt.x + w * 0.45, rt.y + h * 0.45);
        ctx.closePath(); ctx.fill();
        break;
      case ENTITY_TYPES.TRIGGER:
        // Triggers are always invisible in real play — only the editor's
        // debug/playtest view reveals their zone, never actual gameplay.
        if (this.debugTriggers) {
          ctx.fillStyle = 'rgba(255,255,0,0.15)';
          ctx.strokeStyle = 'rgba(255,255,0,0.6)';
          ctx.fillRect(rt.x, rt.y, w, h);
          ctx.strokeRect(rt.x, rt.y, w, h);
        }
        break;
      case ENTITY_TYPES.BUTTON: {
        // A button is deliberately visible (unlike a trigger) so the player
        // can tell it's there and understand it can be pressed again once
        // its cooldown has elapsed.
        const cooling = this.simTime < rt.buttonReadyAt;
        ctx.fillStyle = '#2b2d3d';
        ctx.fillRect(rt.x, rt.y, w, h);
        ctx.strokeStyle = '#5b5f7a'; ctx.lineWidth = 2;
        ctx.strokeRect(rt.x + 2, rt.y + 2, w - 4, h - 4);
        const padH = cooling ? h * 0.22 : h * 0.32;
        ctx.fillStyle = cooling ? '#e07a2c' : '#06d6a0';
        ctx.fillRect(rt.x + w * 0.18, rt.y + h - padH - h * 0.12, w * 0.64, padH);
        break;
      }
      case ENTITY_TYPES.DECOR:
        ctx.fillStyle = '#4a4e69';
        ctx.fillRect(rt.x, rt.y, w, h);
        break;
    }
    ctx.restore();
  }

  _renderPlayer() {
    const ctx = this.ctx, p = this.player;
    const troll = p.invert.horizontal || p.invert.vertical;
    ctx.save();
    // soft drop shadow for a bit of depth
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    roundRect(ctx, p.x + 2, p.y + p.h - 5, p.w - 4, 6, 3);
    ctx.fill();

    const bodyColor = troll ? '#b5179e' : '#f77f00';
    const bodyColor2 = troll ? '#7209b7' : '#d1600a';
    const grad = ctx.createLinearGradient(p.x, p.y, p.x, p.y + p.h);
    grad.addColorStop(0, bodyColor);
    grad.addColorStop(1, bodyColor2);
    ctx.fillStyle = grad;
    roundRect(ctx, p.x, p.y, p.w, p.h, p.w * 0.28);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, p.x + 1, p.y + 1, p.w - 2, p.h - 2, p.w * 0.24);
    ctx.stroke();

    // face: two eyes looking in the facing direction, small mouth
    const eyeSize = Math.max(3, p.w * 0.16);
    const eyeY = p.y + p.h * 0.35;
    const spread = p.w * 0.22;
    const cx = p.x + p.w / 2;
    const lookOffset = p.facing * p.w * 0.06;
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
    if (troll) {
      // worried wavy mouth when controls are inverted
      ctx.moveTo(cx - p.w * 0.18, p.y + p.h * 0.68);
      ctx.quadraticCurveTo(cx, p.y + p.h * 0.6, cx + p.w * 0.18, p.y + p.h * 0.68);
    } else {
      ctx.moveTo(cx - p.w * 0.16, p.y + p.h * 0.62);
      ctx.quadraticCurveTo(cx, p.y + p.h * 0.74, cx + p.w * 0.16, p.y + p.h * 0.62);
    }
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
function drawSpikeRow(ctx, x, y, w, h, cellsWide, facing) {
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
    }
  }
}
