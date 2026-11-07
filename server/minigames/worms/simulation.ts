import { WORMS as W, type WormCharacter, type WormSnapshot, type WormTerrain, type WormProjectile, type WormExplosion } from '../../../shared/worms.js';
import { CAR_COLORS, clamp } from '../../../shared/race.js';
import type { Player, ResultGroup } from '../../../shared/types.js';
import { crater, generateTerrain, hitsTerrain } from './terrain.js';

export class WormSimulation {
  readonly terrain: WormTerrain;
  readonly characters = new Map<string, WormCharacter>();
  readonly order: string[];
  elapsedMs = 0;
  running = false;
  over = false;
  phase: WormSnapshot['phase'] = 'waiting';
  activeId: string | null = null;
  turnNumber = 0;
  turnEndsAt = 0;
  aim = -Math.PI / 4;
  chargeStartedAt: number | null = null;
  shotUsed = false;
  projectile: WormProjectile | null = null;
  explosion: WormExplosion | null = null;
  private orderIndex = -1;
  private move = 0;
  private jump = false;
  private lastInputAt = -Infinity;
  private eventSerial = 0;
  private effectGroup = 0;
  private effectsStartedAt = 0;
  private settledAt: number | null = null;
  private disposed = false;

  constructor(participants: readonly Readonly<Player>[], random: () => number = Math.random) {
    this.terrain = generateTerrain(random);
    this.order = participants.map(p => p.id);
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
    // Use the shuffled order for spawn assignment as well, keeping ample spacing.
    this.order.forEach((id, index) => {
      const player = participants.find(p => p.id === id)!;
      const x = (index + 1) * W.width / (participants.length + 1);
      let y = this.terrain.columns[Math.floor(x / W.terrainStep)][0] - W.radius;
      while (hitsTerrain(this.terrain, x, y, W.radius)) y--;
      this.characters.set(id, { id, name: player.name, color: CAR_COLORS[index % CAR_COLORS.length],
        x, y, vx: 0, vy: 0, hp: W.health, stamina: W.stamina, grounded: true,
        status: 'alive', eliminatedGroup: null });
    });
  }

  start() { if (this.disposed || this.running) return; this.running = true; this.nextTurn(); }
  private alive() { return [...this.characters.values()].filter(c => c.status === 'alive'); }
  private stop() { this.over = true; this.phase = 'finished'; this.activeId = null; this.move = 0; this.jump = false; this.chargeStartedAt = null; }

  private nextTurn() {
    if (this.alive().length <= 1 || this.elapsedMs >= W.matchMs) { this.stop(); return; }
    for (let i = 0; i < this.order.length; i++) {
      this.orderIndex = (this.orderIndex + 1) % this.order.length;
      if (this.characters.get(this.order[this.orderIndex])!.status === 'alive') break;
    }
    this.activeId = this.order[this.orderIndex];
    const active = this.characters.get(this.activeId)!;
    active.stamina = W.stamina;
    this.aim = active.x < W.width / 2 ? -Math.PI / 4 : -Math.PI * 3 / 4;
    this.turnNumber++; this.phase = 'turn'; this.turnEndsAt = this.elapsedMs + W.turnMs;
    this.move = 0; this.jump = false; this.shotUsed = false; this.chargeStartedAt = null;
    this.lastInputAt = -Infinity; this.effectGroup = 0;
  }

  private beginEffects() {
    if (this.phase === 'effects') return;
    this.phase = 'effects'; this.effectsStartedAt = this.elapsedMs;
    this.effectGroup = ++this.eventSerial; this.settledAt = null;
    this.move = 0; this.jump = false; this.chargeStartedAt = null;
  }

  input(id: string, value: unknown) {
    if (!this.running || this.over || this.phase !== 'turn' || this.elapsedMs >= W.matchMs ||
        id !== this.activeId || this.characters.get(id)?.status !== 'alive' || !value || typeof value !== 'object') return;
    const data = value as Record<string, unknown>;
    if (data.type === 'control') {
      if (typeof data.move !== 'number' || !Number.isFinite(data.move) || Math.abs(data.move) > 1 ||
          typeof data.jump !== 'boolean' || typeof data.aim !== 'number' || !Number.isFinite(data.aim)) return;
      this.move = data.move; this.jump ||= data.jump; this.aim = Math.atan2(Math.sin(data.aim), Math.cos(data.aim)); this.lastInputAt = this.elapsedMs;
    } else if (data.type === 'neutral') {
      this.move = 0; this.jump = false; this.chargeStartedAt = null;
    } else if (data.type === 'end') this.beginEffects();
    else if (data.type === 'charge' && this.chargeStartedAt === null && !this.shotUsed) this.chargeStartedAt = this.elapsedMs;
    else if (data.type === 'fire' && this.chargeStartedAt !== null && !this.shotUsed) {
      const power = clamp((this.elapsedMs - this.chargeStartedAt) / W.chargeMs, 0, 1);
      const speed = W.minShotSpeed + (W.maxShotSpeed - W.minShotSpeed) * power;
      const c = this.characters.get(id)!;
      // Start at the body centre. Ignore the shooter briefly, but sweep all terrain
      // from here to the muzzle too, so aiming into a thin wall cannot shoot through it.
      this.projectile = { x: c.x, y: c.y, vx: Math.cos(this.aim) * speed, vy: Math.sin(this.aim) * speed, ownerId: id, bornAt: this.elapsedMs };
      this.shotUsed = true; this.beginEffects();
    }
  }

  disconnect(id: string) {
    const c = this.characters.get(id);
    if (!c || c.status !== 'alive') return; // A previously earned elimination result stays intact.
    c.status = 'disconnected'; c.vx = 0; c.vy = 0;
    if (this.running && !this.over && (id === this.activeId || this.alive().length <= 1)) this.beginEffects();
  }

  private kill(c: WormCharacter, group: number) {
    if (c.status !== 'alive') return;
    c.hp = 0; c.status = 'dead'; c.eliminatedGroup = group; c.vx = 0; c.vy = 0;
  }

  private explode(x: number, y: number) {
    if (!this.projectile) return; // Clear before applying effects: one explosion per projectile.
    this.projectile = null;
    this.explosion = { x, y, serial: this.effectGroup };
    crater(this.terrain, x, y, W.blastRadius);
    for (const c of this.alive()) {
      const dx = c.x - x, dy = c.y - y, distance = Math.hypot(dx, dy);
      if (distance > W.blastRadius) continue;
      const strength = 1 - distance / W.blastRadius;
      c.hp = Math.max(0, c.hp - Math.round(W.maxDamage * strength));
      if (!c.hp) this.kill(c, this.effectGroup);
      else {
        c.vx += dx / Math.max(distance, 1) * W.knockback * strength;
        c.vy += dy / Math.max(distance, 1) * W.knockback * strength - 75 * strength;
        c.grounded = false;
      }
    }
  }

  private stepProjectile(dt: number) {
    const p = this.projectile;
    if (!p) return;
    p.vy += W.gravity * dt;
    const dx = p.vx * dt, dy = p.vy * dt;
    // Swept substeps smaller than the projectile radius prevent thin-terrain tunnelling.
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 2));
    for (let i = 0; i < steps && this.projectile; i++) {
      p.x += dx / steps; p.y += dy / steps;
      const hitCharacter = this.alive().some(c => (c.id !== p.ownerId || this.elapsedMs - p.bornAt > 150) && Math.hypot(c.x - p.x, c.y - p.y) < W.radius + W.projectileRadius);
      if (hitsTerrain(this.terrain, p.x, p.y, W.projectileRadius) || hitCharacter || p.y >= W.waterY ||
          p.x < 0 || p.x > W.width || this.elapsedMs - p.bornAt >= W.projectileMs) this.explode(p.x, p.y);
    }
  }

  private stepCharacter(c: WormCharacter, dt: number, hazardGroup: number) {
    const active = c.id === this.activeId && this.phase === 'turn' && this.elapsedMs - this.lastInputAt < W.inputTimeoutMs;
    const supported = c.grounded || (c.vy >= 0 && hitsTerrain(this.terrain, c.x, c.y + 2, W.radius));
    if (active && this.jump && supported && c.stamina >= W.jumpCost) {
      c.stamina -= W.jumpCost; c.vy = -W.jumpSpeed; c.grounded = false;
    }
    const walking = active ? this.move * Math.min(W.moveSpeed * dt, c.stamina) : 0;
    if (walking) {
      const x = c.x + walking;
      let stepUp = 0;
      if (c.grounded) while (stepUp <= 9 && hitsTerrain(this.terrain, x, c.y - stepUp, W.radius)) stepUp++;
      if (stepUp <= 9 && !hitsTerrain(this.terrain, x, c.y - stepUp, W.radius) &&
          !this.alive().some(other => other !== c && Math.hypot(other.x - x, other.y - c.y + stepUp) < W.radius * 2)) {
        c.x = x; c.y -= stepUp; c.stamina = Math.max(0, c.stamina - Math.abs(walking));
      }
    }
    c.vy = Math.min(W.maxFallSpeed, c.vy + W.gravity * dt);
    const dx = c.vx * dt, dy = c.vy * dt;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 2));
    c.grounded = false;
    for (let i = 0; i < steps; i++) {
      if (!hitsTerrain(this.terrain, c.x + dx / steps, c.y, W.radius)) c.x += dx / steps;
      else c.vx = 0;
      if (!hitsTerrain(this.terrain, c.x, c.y + dy / steps, W.radius)) c.y += dy / steps;
      else { if (dy > 0) c.grounded = true; c.vy = 0; }
    }
    c.vx *= Math.exp(-(c.grounded ? 8 : .5) * dt);
    if (Math.abs(c.vx) < .5) c.vx = 0;
    if (c.y + W.radius >= W.waterY || c.x < -W.radius || c.x > W.width + W.radius) this.kill(c, hazardGroup);
  }

  step() {
    if (!this.running || this.over || this.disposed) return;
    const dt = 1 / W.physicsHz;
    this.elapsedMs += dt * 1000;
    if (this.phase === 'turn' && (this.elapsedMs >= this.turnEndsAt || this.elapsedMs >= W.matchMs)) this.beginEffects();
    this.stepProjectile(dt);
    const hazardGroup = this.phase === 'effects' ? this.effectGroup : ++this.eventSerial;
    for (const c of this.alive()) this.stepCharacter(c, dt, hazardGroup);
    this.jump = false;
    if (this.phase === 'turn' && (this.characters.get(this.activeId!)?.status !== 'alive' || this.alive().length <= 1)) this.beginEffects();
    if (this.phase === 'effects') {
      // Bound the whole resolution, including projectile lifetime and falling. At the
      // deadline settle onto the next support, or into water, in this same effect group.
      if (this.elapsedMs - this.effectsStartedAt >= W.effectsMs) {
        if (this.projectile) this.explode(this.projectile.x, this.projectile.y);
        for (const c of this.alive()) {
          for (let y = c.y; y < W.waterY; y += 1) {
            if (hitsTerrain(this.terrain, c.x, y + 1, W.radius)) break;
            c.y = y;
          }
          if (c.y + W.radius >= W.waterY - 1 || c.x < 0 || c.x > W.width) this.kill(c, this.effectGroup);
          else { c.vx = 0; c.vy = 0; c.grounded = true; }
        }
        this.nextTurn();
      } else if (!this.projectile && this.alive().every(c => c.grounded && Math.abs(c.vx) < 3 && Math.abs(c.vy) < 3)) {
        this.settledAt ??= this.elapsedMs;
        if (this.elapsedMs - this.settledAt >= W.settleMs) this.nextTurn();
      } else this.settledAt = null;
    }
  }

  snapshot(): WormSnapshot {
    return { elapsedMs: this.elapsedMs, running: this.running, over: this.over, phase: this.phase,
      order: [...this.order], activeId: this.activeId, turnNumber: this.turnNumber, turnEndsAt: this.turnEndsAt,
      aim: this.aim, chargeStartedAt: this.chargeStartedAt, shotUsed: this.shotUsed,
      characters: [...this.characters.values()].map(c => ({ ...c })),
      projectile: this.projectile && { ...this.projectile }, explosion: this.explosion && { ...this.explosion } };
  }

  results(): ResultGroup[] {
    const all = [...this.characters.values()], groups: ResultGroup[] = [];
    const survivors = this.alive().sort((a, b) => b.hp - a.hp);
    const dead = all.filter(c => c.status === 'dead').sort((a, b) => b.eliminatedGroup! - a.eliminatedGroup!);
    for (const c of [...survivors, ...dead]) {
      const last = groups.at(-1), previous = last && this.characters.get(last.players[0]);
      const tie = previous?.status === c.status && (c.status === 'alive' ? previous.hp === c.hp : previous.eliminatedGroup === c.eliminatedGroup);
      const value = c.status === 'alive' ? `${c.hp} životů` : 'Vyřazen/a';
      if (tie && last) { last.players.push(c.id); last.values![c.id] = value; }
      else groups.push({ players: [c.id], values: { [c.id]: value } });
    }
    const disconnected = all.filter(c => c.status === 'disconnected');
    if (disconnected.length) groups.push({ players: disconnected.map(c => c.id), unfinished: true,
      values: Object.fromEntries(disconnected.map(c => [c.id, 'Vyloučen/a po odpojení'])) });
    return groups;
  }

  dispose() { this.disposed = true; this.running = false; this.projectile = null; this.move = 0; this.jump = false; }
}
