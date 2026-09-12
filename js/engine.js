// Core game engine: physics, collisions, triggers, rendering.
// Framework-free, canvas 2D. Designed to be driven by game.js (play mode)
// and reused (read-only, no input) by editor.js for in-editor testing.
import {
  CELL, ENTITY_TYPES, ENTITY_STATES, HAZARD_TYPES, SOLID_TYPES,
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

  reset() {
    const lvl = this.level;
    this.deaths = this.deaths || 0;
    this.simTime = 0;
    this.won = false;
    this.dead = false;
    this.respawn = { x: lvl.playerStart.x, y: lvl.playerStart.y };
    this.player = {
      x: this.respawn.x * CELL, y: this.respawn.y * CELL,
      w: CELL * 0.7, h: CELL * 0.7,
      vx: 0, vy: 0,
      gravityDir: 'down',
      invert: { horizontal: false, vertical: false },
      jumpMult: 1, speedMult: 1,
      onGround: false,
      facing: 1,
    };
    // center the smaller hitbox inside its cell
    this.player.x += (CELL - this.player.w) / 2;
    this.player.y += (CELL - this.player.h) / 2;

    this.runtime = new Map();
    for (const ent of lvl.entities) {
      this.runtime.set(ent.id, {
        def: ent,
        x: ent.x * CELL, y: ent.y * CELL,
        state: ent.state || ENTITY_STATES.NORMAL,
        anim: null, // { fromX,fromY,toX,toY,startTime,duration }
        dx: 0, dy: 0, // this-frame movement delta, for carrying the player along
        angle: 0,
        firedOnce: false,
        wasOverlapping: false,
        activated: false,
      });
    }
    this.scheduled = []; // [{time, run: fn}]
    this.camera = { x: 0, y: 0 };
    this.onStateChange({ deaths: this.deaths });
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
      this._respawnPlayer();
    }, 450);
  }

  _respawnPlayer() {
    const p = this.player;
    p.x = this.respawn.x * CELL + (CELL - p.w) / 2;
    p.y = this.respawn.y * CELL + (CELL - p.h) / 2;
    p.vx = 0; p.vy = 0;
    p.gravityDir = 'down';
    p.invert = { horizontal: false, vertical: false };
    p.jumpMult = 1; p.speedMult = 1;
  }

  winLevel() {
    if (this.won) return;
    this.won = true;
    this.onWin({ deaths: this.deaths });
  }

  // ---------------------------------------------------------------- update
  update(dt) {
    this.simTime += dt;
    this._runScheduled();
    this._updateMovers(dt);
    this._updatePhysics(dt);
    this._updateSpinnerAngles(dt);
    this._checkTriggers();
    this._checkHazardsAndGoal();
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

  _solidRects() {
    const rects = [];
    for (const rt of this.runtime.values()) {
      const t = rt.def.type;
      if (!SOLID_TYPES.has(t)) continue;
      if (rt.state === ENTITY_STATES.PASSABLE || rt.state === ENTITY_STATES.INVISIBLE) continue;
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
        if (rt.state === ENTITY_STATES.NORMAL) this.killPlayer();
        continue;
      }
      if (t === ENTITY_TYPES.SPRING && rt.state !== ENTITY_STATES.INVISIBLE) {
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
        }
      }
      if (!overlapping && rt.wasOverlapping && mode === TRIGGER_MODES.ON_EXIT) {
        this._fireTrigger(rt);
      }
      rt.wasOverlapping = overlapping;
    }
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
        if (target) target.state = action.params.state;
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
    if (rt.state === ENTITY_STATES.INVISIBLE && !this.debugTriggers) return;
    const ctx = this.ctx;
    const w = rt.def.w * CELL, h = rt.def.h * CELL;
    const alpha = rt.state === ENTITY_STATES.PASSABLE ? 0.35 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
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
        const harmless = rt.state === ENTITY_STATES.HARMLESS;
        ctx.fillStyle = harmless ? '#5b6b7a' : '#e63946';
        const n = rt.def.w;
        for (let i = 0; i < n; i++) {
          const bx = rt.x + i * CELL;
          ctx.beginPath();
          ctx.moveTo(bx, rt.y + h);
          ctx.lineTo(bx + CELL / 2, rt.y);
          ctx.lineTo(bx + CELL, rt.y + h);
          ctx.closePath();
          ctx.fill();
        }
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
      case ENTITY_TYPES.SPINNER: {
        const cx = rt.x + w / 2, cy = rt.y + h / 2;
        const r = CELL * ((rt.def.props && rt.def.props.radius) || 0.9) * (rt.def.w);
        const harmless = rt.state === ENTITY_STATES.HARMLESS;
        ctx.fillStyle = harmless ? '#5b6b7a' : '#c9184a';
        ctx.strokeStyle = harmless ? '#5b6b7a' : '#c9184a';
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
        if (this.debugTriggers) {
          ctx.fillStyle = 'rgba(255,255,0,0.15)';
          ctx.strokeStyle = 'rgba(255,255,0,0.6)';
          ctx.fillRect(rt.x, rt.y, w, h);
          ctx.strokeRect(rt.x, rt.y, w, h);
        }
        break;
      case ENTITY_TYPES.DECOR:
        ctx.fillStyle = '#4a4e69';
        ctx.fillRect(rt.x, rt.y, w, h);
        break;
    }
    ctx.restore();
  }

  _renderPlayer() {
    const ctx = this.ctx, p = this.player;
    ctx.save();
    ctx.fillStyle = this.player.invert.horizontal || this.player.invert.vertical ? '#b5179e' : '#f77f00';
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = '#1b1e2b';
    const eyeSize = 4;
    const ex = p.facing > 0 ? p.x + p.w - 10 : p.x + 6;
    ctx.fillRect(ex, p.y + 8, eyeSize, eyeSize);
    ctx.restore();
  }
}
