import { World, Vec2, Box, type Body } from 'planck';
import type { Player, ResultGroup } from '../../../shared/types.js';
import { CAR_COLORS, NEUTRAL_INPUT, RACE, catchupMultiplier, clamp, crossedGate, driveVelocity, pointAt, projectDistance,
  type DriveInput, type Point, type RaceCarState, type RaceSnapshot, type RaceTrack } from '../../../shared/race.js';

interface Car extends RaceCarState {
  body: Body | null;
  input: DriveInput;
  lastInputMs: number;
}

export class RaceSimulation {
  readonly world = new World(Vec2(0, 0));
  readonly cars = new Map<string, Car>();
  elapsedMs = 0;
  running = false;
  private disposed = false;

  constructor(readonly track: RaceTrack, participants: readonly Readonly<Player>[], random: () => number = Math.random) {
    const wall = this.world.createBody();
    const barrier = (a: Point, b: Point) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      wall.createFixture(Box(Math.hypot(dx, dy) / 2 + .04, .35, Vec2((a.x + b.x) / 2, (a.y + b.y) / 2), Math.atan2(dy, dx)), { friction: .15, restitution: .15 });
    };
    for (const side of [track.left, track.right]) for (let i = 1; i < side.length; i++) barrier(side[i - 1], side[i]);
    barrier(track.left[0], track.right[0]); barrier(track.left.at(-1)!, track.right.at(-1)!);
    const slots = Array.from({ length: participants.length }, (_, i) => i);
    for (let i = slots.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
    participants.forEach((player, index) => {
      const slot = slots[index], x = -7 - Math.floor(slot / 2) * 6, y = slot % 2 ? 3.2 : -3.2;
      const body = this.world.createDynamicBody({ position: Vec2(x, y), angle: 0, bullet: true, angularDamping: .4, userData: player.id });
      body.createFixture(Box(RACE.carLength / 2, RACE.carWidth / 2), { density: 1, friction: .12, restitution: .22 });
      this.cars.set(player.id, {
        id: player.id, name: player.name, color: CAR_COLORS[index % CAR_COLORS.length],
        x, y, angle: 0, vx: 0, vy: 0, angularVelocity: 0, status: 'racing', progress: 0,
        nextCheckpoint: 0, finishMs: null, ack: 0, lockedUntil: 0, resetPending: false,
        resetSerial: 0, collisions: 0, catchupBoost: 1, body, input: { ...NEUTRAL_INPUT }, lastInputMs: -Infinity
      });
    });
    this.world.on('begin-contact', contact => {
      const a = this.cars.get(contact.getFixtureA().getBody().getUserData() as string);
      const b = this.cars.get(contact.getFixtureB().getBody().getUserData() as string);
      if (a && b) { a.collisions++; b.collisions++; }
    });
  }

  start() { if (!this.disposed) this.running = true; }

  acceptInput(id: string, value: unknown) {
    const car = this.cars.get(id);
    if (!this.running || !car || car.status !== 'racing' || !value || typeof value !== 'object') return;
    const data = value as Partial<DriveInput>;
    if (typeof data.throttle !== 'number' || !Number.isFinite(data.throttle) || Math.abs(data.throttle) > 1 ||
        typeof data.steer !== 'number' || !Number.isFinite(data.steer) || Math.abs(data.steer) > 1 ||
        typeof data.reset !== 'boolean' || !Number.isSafeInteger(data.seq) || data.seq! <= car.input.seq) return;
    car.input = { throttle: data.throttle, steer: data.steer, reset: car.input.reset || data.reset, seq: data.seq! };
    car.lastInputMs = this.elapsedMs;
  }

  exclude(id: string) {
    const car = this.cars.get(id);
    if (!car || car.status !== 'racing') return;
    car.status = 'excluded'; car.input = { ...NEUTRAL_INPUT }; car.resetPending = false; car.catchupBoost = 1;
    if (car.body) this.world.destroyBody(car.body);
    car.body = null;
  }

  get over() { return [...this.cars.values()].every(car => car.status !== 'racing'); }

  private reset(car: Car): boolean {
    if (!car.body || this.elapsedMs < car.lockedUntil) return false;
    const distance = projectDistance(this.track, car.body.getPosition()).distance;
    const safe = car.nextCheckpoint ? this.track.checkpoints[car.nextCheckpoint - 1].distance : this.track.start.distance - 2;
    const maximum = Math.min(safe - 4, distance);
    const radius = Math.hypot(RACE.carLength, RACE.carWidth) / 2;
    // Try the last passed gate, then progressively farther behind it; never farther forward.
    for (let back = 0; back <= 30; back += 5) for (const lateral of [0, -4, 4, -7, 7]) {
      const at = pointAt(this.track, clamp(maximum - back, RACE.carLength / 2 + .35, this.track.finish.distance - 5));
      if (at.distance > distance + .001) continue;
      const x = at.x - Math.sin(at.angle) * lateral, y = at.y + Math.cos(at.angle) * lateral;
      const occupied = [...this.cars.values()].some(other => other !== car && other.body && Math.hypot(other.body.getPosition().x - x, other.body.getPosition().y - y) < 2 * radius + .5);
      if (occupied) continue;
      car.body.setTransform(Vec2(x, y), at.angle);
      car.body.setLinearVelocity(Vec2(0, 0)); car.body.setAngularVelocity(0);
      car.x = x; car.y = y; car.vx = 0; car.vy = 0; car.angle = at.angle; car.angularVelocity = 0;
      car.lockedUntil = this.elapsedMs + RACE.resetLockMs;
      car.resetPending = false; car.resetSerial++;
      car.input = { ...NEUTRAL_INPUT, seq: car.input.seq };
      return true;
    }
    car.resetPending = true;
    return false;
  }

  step() {
    if (this.disposed || !this.running) return;
    const dt = 1 / RACE.physicsHz;
    const leaderProgress = Math.max(0, ...[...this.cars.values()].filter(car => car.status !== 'excluded').map(car => car.progress));
    for (const car of this.cars.values()) {
      if (!car.body || car.status !== 'racing') continue;
      car.catchupBoost = catchupMultiplier(leaderProgress - car.progress);
      if ((car.input.reset || car.resetPending) && this.elapsedMs >= car.lockedUntil) this.reset(car);
      car.input.reset = false;
      car.ack = car.input.seq;
      if (this.elapsedMs < car.lockedUntil || car.resetPending) {
        car.body.setLinearVelocity(Vec2(0, 0)); car.body.setAngularVelocity(0); continue;
      }
      const velocity = car.body.getLinearVelocity(), position = car.body.getPosition();
      const input = this.elapsedMs - car.lastInputMs > RACE.inputTimeoutMs ? NEUTRAL_INPUT : car.input;
      const motion = driveVelocity({ x: position.x, y: position.y, vx: velocity.x, vy: velocity.y, angle: car.body.getAngle(), angularVelocity: car.body.getAngularVelocity() }, input, dt, car.catchupBoost);
      car.body.setLinearVelocity(Vec2(motion.vx, motion.vy)); car.body.setAngularVelocity(motion.angularVelocity);
    }
    this.world.step(dt, 8, 3);
    const previousMs = this.elapsedMs;
    this.elapsedMs += dt * 1000;
    for (const car of this.cars.values()) {
      if (!car.body || car.status !== 'racing') continue;
      const before = { x: car.x, y: car.y }, after = car.body.getPosition();
      const next = this.track.checkpoints[car.nextCheckpoint];
      if (next && crossedGate(before, after, next, this.track.width - RACE.carWidth) !== null) car.nextCheckpoint++;
      if (car.nextCheckpoint === this.track.checkpoints.length) {
        const crossed = crossedGate(before, after, this.track.finish, this.track.width - RACE.carWidth);
        if (crossed !== null) { car.status = 'finished'; car.finishMs = previousMs + crossed * dt * 1000; }
      }
      const projected = projectDistance(this.track, after).distance;
      const low = car.nextCheckpoint ? this.track.checkpoints[car.nextCheckpoint - 1].distance : this.track.start.distance;
      const high = this.track.checkpoints[car.nextCheckpoint]?.distance ?? this.track.finish.distance;
      car.progress = car.status === 'finished' ? this.track.length : clamp(clamp(projected, low, high) - this.track.start.distance, 0, this.track.length);
      const velocity = car.body.getLinearVelocity();
      Object.assign(car, { x: after.x, y: after.y, angle: car.body.getAngle(), vx: velocity.x, vy: velocity.y, angularVelocity: car.body.getAngularVelocity() });
      if (car.status === 'finished') { this.world.destroyBody(car.body); car.body = null; }
    }
  }

  snapshot(): RaceSnapshot {
    return { elapsedMs: this.elapsedMs, running: this.running, cars: [...this.cars.values()].map(({ body, input, lastInputMs, ...state }) => ({ ...state })) };
  }

  results(): ResultGroup[] {
    const cars = [...this.cars.values()];
    const finishers = cars.filter(c => c.status === 'finished').sort((a, b) => a.finishMs! - b.finishMs!);
    const unfinished = cars.filter(c => c.status === 'racing').sort((a, b) => b.nextCheckpoint - a.nextCheckpoint || b.progress - a.progress);
    const excluded = cars.filter(c => c.status === 'excluded');
    const groups: ResultGroup[] = [];
    for (const car of [...finishers, ...unfinished]) {
      const last = groups.at(-1), previous = cars.find(c => c.id === last?.players[0]);
      const tie = previous && previous.status === car.status && (car.status === 'finished' ? previous.finishMs === car.finishMs : previous.nextCheckpoint === car.nextCheckpoint && Math.abs(previous.progress - car.progress) < .001);
      const value = car.status === 'finished' ? `${(car.finishMs! / 1000).toFixed(2)} s` : `Limit · ${Math.floor(car.progress / this.track.length * 100)} %`;
      if (tie && last) { last.players.push(car.id); last.values![car.id] = value; }
      else groups.push({ players: [car.id], unfinished: car.status !== 'finished', values: { [car.id]: value } });
    }
    if (excluded.length) groups.push({ players: excluded.map(c => c.id), unfinished: true, values: Object.fromEntries(excluded.map(c => [c.id, 'Vyloučen/a po odpojení'])) });
    return groups;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.running = false;
    for (let body = this.world.getBodyList(); body;) { const next = body.getNext(); this.world.destroyBody(body); body = next; }
    for (const car of this.cars.values()) car.body = null;
  }
}
