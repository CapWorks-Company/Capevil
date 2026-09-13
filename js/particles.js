// Minimal canvas particle system — plain arrays, no dependencies. Used for
// cosmetic-only feedback (death burst, win confetti, landing dust): nothing
// here affects gameplay, so it's safe to skip entirely (e.g. `reduce motion`
// or low-end devices) without touching engine logic.
export class ParticleSystem {
  constructor() {
    this.particles = [];
  }

  burst(x, y, {
    count = 18, colors = ['#ff5c8a', '#ffd166'], speed = 220,
    spread = Math.PI * 2, angle = 0, gravity = 900, life = 0.6, size = 4,
  } = {}) {
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.particles.push({
        x, y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        gravity,
        life: life * (0.7 + Math.random() * 0.6),
        age: 0,
        size: size * (0.6 + Math.random() * 0.8),
        color: colors[(Math.random() * colors.length) | 0],
      });
    }
  }

  // Small poof under the player's feet on landing or jumping.
  dust(x, y) {
    this.burst(x, y, { count: 7, colors: ['#e6e8f5', '#aab0d4'], speed: 90, spread: Math.PI * 0.9, angle: -Math.PI / 2, gravity: 400, life: 0.35, size: 3 });
  }

  // Red-ish burst on death.
  deathBurst(x, y) {
    this.burst(x, y, { count: 22, colors: ['#ff4d6d', '#ff8fa3', '#c9184a'], speed: 260, gravity: 700, life: 0.55, size: 4.5 });
  }

  // Colorful confetti shower on winning.
  confetti(x, y) {
    this.burst(x, y, { count: 46, colors: ['#ffd166', '#06d6a0', '#4cc9f0', '#f72585', '#ffffff'], speed: 280, angle: -Math.PI / 2, spread: Math.PI, gravity: 480, life: 1.2, size: 5 });
  }

  // A little magical "poof" when the player turns invisible or visible
  // again — a burst of light motes with no gravity, so it reads as a
  // dissolve/materialize rather than debris falling.
  poof(x, y) {
    this.burst(x, y, { count: 16, colors: ['#c9d6ff', '#8fa8ff', '#ffffff'], speed: 160, spread: Math.PI * 2, gravity: 0, life: 0.4, size: 3.5 });
  }

  // A brief streak blown in the wind's direction — called probabilistically
  // (not every frame) by the fan's continuous push, so it doesn't need to
  // self-throttle. `v` is one of the unit GRAVITY_VECTORS; `strength` (0-1+)
  // scales both how fast and how many particles fly off.
  wind(x, y, v, strength = 1) {
    const angle = Math.atan2(v.y, v.x);
    this.burst(x, y, {
      count: 2 + Math.round(Math.min(2, strength) * 2),
      colors: ['#e7f8ff', '#9fdcf2', '#ffffff'],
      speed: 240 * Math.max(0.35, strength),
      spread: 0.6,
      angle,
      gravity: 0,
      life: 0.3,
      size: 2.2,
    });
  }

  update(dt) {
    if (!this.particles.length) return;
    for (const p of this.particles) {
      p.age += dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
  }

  render(ctx) {
    if (!this.particles.length) return;
    ctx.save();
    for (const p of this.particles) {
      const t = p.age / p.life;
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.5, p.size * (1 - t * 0.5)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  clear() { this.particles.length = 0; }
}
