import { MINIGAME_CONFIG } from './minigames.config.js';

export const RACE = MINIGAME_CONFIG['car-race'];

export interface Point { x: number; y: number }
export interface Gate extends Point { angle: number; distance: number }
export interface RaceTrack {
  center: Point[];
  left: Point[];
  right: Point[];
  distances: number[];
  checkpoints: Gate[];
  start: Gate;
  finish: Gate;
  width: number;
  length: number;
  fallback: boolean;
}
export interface DriveInput { throttle: number; steer: number; reset: boolean; seq: number }
export interface CarMotion extends Point { angle: number; vx: number; vy: number; angularVelocity: number }
export interface RaceCarState extends CarMotion {
  id: string;
  name: string;
  color: number;
  status: 'racing' | 'finished' | 'excluded';
  progress: number;
  nextCheckpoint: number;
  finishMs: number | null;
  ack: number;
  lockedUntil: number;
  resetPending: boolean;
  resetSerial: number;
  collisions: number;
  catchupBoost: number;
}
export interface RaceSnapshot {
  elapsedMs: number;
  running: boolean;
  cars: RaceCarState[];
}
export interface RaceData { kind: 'car-race'; track: RaceTrack; snapshot: RaceSnapshot }
export const NEUTRAL_INPUT: DriveInput = { throttle: 0, steer: 0, reset: false, seq: 0 };
export const CAR_COLORS = [0x33cfff, 0xffca3a, 0xff7755, 0xa990ff, 0x62df9a, 0xff82cb, 0xe1e7ef, 0xf9a14a];
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const angleDifference = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

// Shared drive model: Planck resolves contacts on the server; the client only predicts free motion.
export function catchupMultiplier(gap: number): number {
  const t = clamp((gap - RACE.catchupStartDistance) / (RACE.catchupFullDistance - RACE.catchupStartDistance), 0, 1);
  return 1 + RACE.catchupMaxBoost * t * t * (3 - 2 * t);
}

export function packMultiplier(gap: number): number {
  const t = clamp((gap - RACE.packSlowStartDistance) / (RACE.packMaxDistance - RACE.packSlowStartDistance), 0, 1);
  return 1 - (1 - RACE.packMinSpeed) * t * t * (3 - 2 * t);
}

export function driveVelocity(car: CarMotion, input: DriveInput, dt: number, catchupBoost = 1): CarMotion {
  const fx = Math.cos(car.angle), fy = Math.sin(car.angle);
  let forward = car.vx * fx + car.vy * fy;
  let lateral = -car.vx * fy + car.vy * fx;
  const acceleration = input.throttle < 0 && forward > 0 ? RACE.braking : RACE.acceleration * (input.throttle > 0 ? catchupBoost : 1);
  forward += input.throttle * acceleration * dt;
  forward *= Math.exp(-RACE.drag * dt);
  forward = clamp(forward, -RACE.reverseSpeed, RACE.maxSpeed * catchupBoost);
  const drift = Math.abs(input.steer) * clamp(Math.abs(forward) / 16, 0, 1);
  const grip = RACE.lateralGrip + (RACE.driftGrip - RACE.lateralGrip) * drift;
  lateral *= Math.exp(-grip * dt);
  const turn = input.steer * RACE.steeringRate * clamp(Math.abs(forward) / 12, 0, 1) * Math.sign(forward);
  return { ...car, vx: fx * forward - fy * lateral, vy: fy * forward + fx * lateral,
    angularVelocity: car.angularVelocity + (turn - car.angularVelocity) * (1 - Math.exp(-7 * dt)) };
}

export function predictMotion(car: CarMotion, input: DriveInput, dt: number, catchupBoost = 1): CarMotion {
  const next = driveVelocity(car, input, dt, catchupBoost);
  return { ...next, x: next.x + next.vx * dt, y: next.y + next.vy * dt, angle: next.angle + next.angularVelocity * dt };
}

export function pointAt(track: RaceTrack, distance: number): Gate {
  const s = clamp(distance, 0, track.distances.at(-1)!);
  let lo = 0, hi = track.distances.length - 1;
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (track.distances[mid] <= s) lo = mid; else hi = mid; }
  const a = track.center[lo], b = track.center[lo + 1];
  const t = (s - track.distances[lo]) / (track.distances[lo + 1] - track.distances[lo]);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x), distance: s };
}

export function projectDistance(track: RaceTrack, p: Point): { distance: number; lateral: number } {
  let best = Infinity, distance = 0, lateral = 0;
  for (let i = 0; i < track.center.length - 1; i++) {
    const a = track.center[i], b = track.center[i + 1], dx = b.x - a.x, dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length2, 0, 1);
    const px = p.x - a.x - t * dx, py = p.y - a.y - t * dy, d = px * px + py * py;
    if (d < best) { best = d; distance = track.distances[i] + t * Math.sqrt(length2); lateral = (-dy * (p.x - a.x) + dx * (p.y - a.y)) / Math.sqrt(length2); }
  }
  return { distance, lateral };
}

export function crossedGate(before: Point, after: Point, gate: Gate, width: number): number | null {
  const fx = Math.cos(gate.angle), fy = Math.sin(gate.angle);
  const a = (before.x - gate.x) * fx + (before.y - gate.y) * fy;
  const b = (after.x - gate.x) * fx + (after.y - gate.y) * fy;
  if (a > 0 || b <= 0 || b <= a) return null;
  const t = -a / (b - a);
  const x = before.x + (after.x - before.x) * t - gate.x, y = before.y + (after.y - before.y) * t - gate.y;
  return Math.abs(-fy * x + fx * y) <= width / 2 ? t : null;
}
