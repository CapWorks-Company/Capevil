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
