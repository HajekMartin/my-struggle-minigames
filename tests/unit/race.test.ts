import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec2 } from 'planck';
import { RaceSimulation } from '../../server/minigames/race/simulation.js';
import { generateTrack, validTrack } from '../../server/minigames/race/track.js';
import { raceGame } from '../../server/minigames/race/index.js';
import { RACE, catchupMultiplier, crossedGate, pointAt, projectDistance, angleDifference, clamp, predictMotion, type Gate, type RaceData } from '../../shared/race.js';
import type { JsonValue } from '../../shared/types.js';
import { scoreRound } from '../../server/scoring.js';

const players = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => ({ id, name: id }));
function random(seed: number) { return () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; }; }
const straight = () => generateTrack(() => .5, 0, 400);
function pose(sim: RaceSimulation, id: string, x: number, y: number, angle = 0, speed = 0) {
  const car = sim.cars.get(id)!;
  car.body!.setTransform(Vec2(x, y), angle);
  car.body!.setLinearVelocity(Vec2(Math.cos(angle) * speed, Math.sin(angle) * speed));
  car.body!.setAngularVelocity(0);
  car.x = x; car.y = y; car.angle = angle; car.vx = Math.cos(angle) * speed; car.vy = Math.sin(angle) * speed;
}
function cross(sim: RaceSimulation, id: string, gate: Gate, forward = true) {
  const sign = forward ? -1 : 1;
  pose(sim, id, gate.x + sign * .04 * Math.cos(gate.angle), gate.y + sign * .04 * Math.sin(gate.angle), gate.angle, forward ? 12 : -12);
  sim.step();
}

test('různé generované tratě jsou souvislé, široké, bez překřížení a mají správnou délku', () => {
  const shapes = new Set<string>();
  for (let seed = 1; seed <= 24; seed++) {
    const track = generateTrack(random(seed));
    assert.ok(validTrack(track)); assert.equal(track.fallback, false);
    assert.equal(track.length, RACE.cruiseSpeed * RACE.targetSeconds);
    assert.equal(track.width, RACE.roadWidth);
    assert.ok(track.center.some(p => Math.abs(p.y) > 10));
    assert.ok(Math.abs(track.finish.distance - track.start.distance - track.length) < .01);
    assert.ok(track.checkpoints.length > 40);
    shapes.add(JSON.stringify(track.center.slice(300, 305)));
  }
  assert.ok(shapes.size > 20);
  const fallback = generateTrack(random(1), 0);
  assert.ok(fallback.fallback && validTrack(fallback));
  assert.ok(fallback.center.every(p => p.y === 0));
});

test('startovní místa jsou náhodná a bez překryvů; před startem jsou vstupy blokované', () => {
  const sim = new RaceSimulation(straight(), players, random(12));
  const before = sim.snapshot();
  for (const car of before.cars) {
    assert.ok(car.x < 0);
    sim.acceptInput(car.id, { throttle: 1, steer: 1, reset: false, seq: 1 });
    for (const other of before.cars) if (car.id !== other.id) assert.ok(Math.hypot(car.x - other.x, car.y - other.y) > Math.hypot(RACE.carLength, RACE.carWidth));
  }
  for (let i = 0; i < 60; i++) sim.step();
  assert.deepEqual(sim.snapshot(), before);
  const other = new RaceSimulation(straight(), players, random(38));
  assert.notDeepEqual(before.cars.map(c => [c.x, c.y]), other.snapshot().cars.map(c => [c.x, c.y]));
  sim.dispose(); other.dispose();
});

test('autorita vstupů, pevný krok, brzda, zpátečka a predikce stejného volného pohybu', () => {
  const sim = new RaceSimulation(straight(), players.slice(0, 2), random(1)); sim.start();
  const a = sim.cars.get('a')!, before = a.x;
  sim.acceptInput('a', { throttle: 2, steer: 0, reset: false, seq: 1 });
  sim.acceptInput('a', { throttle: NaN, steer: 0, reset: false, seq: 2 });
  sim.step(); assert.equal(a.x, before);
  let predicted = { x: a.x, y: a.y, angle: a.angle, vx: 0, vy: 0, angularVelocity: 0 };
  for (let i = 1; i <= 60; i++) {
    const input = { throttle: 1, steer: 0, reset: false, seq: i };
    sim.acceptInput('a', { ...input, x: 1e9, y: 1e9, finishMs: 0 });
    sim.step(); predicted = predictMotion(predicted, input, 1 / RACE.physicsHz);
  }
  assert.ok(a.x > before + 3 && a.x < before + 6);
  assert.ok(Math.abs(predicted.x - a.x) < .01);
  for (let i = 61; i <= 180; i++) { sim.acceptInput('a', { throttle: -1, steer: 0, reset: false, seq: i }); sim.step(); }
  assert.ok(a.vx < 0 && a.vx >= -RACE.reverseSpeed);
  const lastAck = a.ack;
  sim.acceptInput('a', { throttle: 1, steer: 0, reset: false, seq: 1 }); sim.step(); assert.equal(a.ack, lastAck);
  for (let i = 0; i < 120; i++) sim.step();
  assert.ok(Math.abs(a.vx) < RACE.reverseSpeed);
  sim.dispose(); assert.equal(sim.world.getBodyCount(), 0);
});

test('Planck počítá nárazy dvou aut, odstrčení a neprůjezdné bariéry', () => {
  const sim = new RaceSimulation(straight(), players.slice(0, 2), random(1)); sim.start();
  for (let i = 1; i <= 180; i++) {
    for (const car of sim.cars.values()) sim.acceptInput(car.id, { throttle: 1, steer: car.id === 'a' ? (sim.snapshot().cars.find(c => c.id === 'a')!.y < 0 ? 1 : -1) : (sim.snapshot().cars.find(c => c.id === 'b')!.y < 0 ? 1 : -1), reset: false, seq: i });
    sim.step();
  }
  assert.ok(sim.cars.get('a')!.collisions > 0 && sim.cars.get('b')!.collisions > 0);
  assert.ok(sim.cars.get('a')!.body!.getAngle() !== 0);
  for (let i = 181; i <= 1000; i++) {
    for (const car of sim.cars.values()) sim.acceptInput(car.id, { throttle: 1, steer: 1, reset: false, seq: i });
    sim.step();
    for (const car of sim.cars.values()) assert.ok(Math.abs(car.y) < sim.track.width / 2);
  }
  sim.dispose();
});

test('checkpointy jsou sekvenční a jednosměrné, opakování ani přeskočení neuzná cíl', () => {
  const sim = new RaceSimulation(straight(), players.slice(0, 2)); sim.start();
  const a = sim.cars.get('a')!;
  cross(sim, 'a', sim.track.finish); assert.equal(a.status, 'racing'); assert.equal(a.nextCheckpoint, 0);
  cross(sim, 'a', sim.track.checkpoints[1]); assert.equal(a.nextCheckpoint, 0);
  cross(sim, 'a', sim.track.start, false); assert.equal(a.nextCheckpoint, 0);
  cross(sim, 'a', sim.track.start); assert.equal(a.nextCheckpoint, 1);
  cross(sim, 'a', sim.track.start); assert.equal(a.nextCheckpoint, 1);
  for (const gate of sim.track.checkpoints.slice(1)) cross(sim, 'a', gate);
  assert.equal(a.nextCheckpoint, sim.track.checkpoints.length);
  cross(sim, 'a', sim.track.finish, false); assert.equal(a.status, 'racing');
  cross(sim, 'a', sim.track.finish); assert.equal(a.status, 'finished'); assert.ok(a.finishMs! > 0);
  sim.exclude('a'); assert.equal(a.status, 'finished');
  assert.equal(crossedGate({ x: 0, y: 100 }, { x: 2, y: 100 }, { x: 1, y: 0, angle: 0, distance: 1 }, 20), null);
  sim.dispose();
});

test('R vrací pouze zpět bez zlepšení postupu, mimo jiné auto a se zámkem na dvě sekundy', () => {
  const sim = new RaceSimulation(straight(), players.slice(0, 2)); sim.start();
  const a = sim.cars.get('a')!;
  cross(sim, 'a', sim.track.start); cross(sim, 'a', sim.track.checkpoints[1]);
  pose(sim, 'a', 110, 0); sim.step();
  const before = a.progress, checkpoint = a.nextCheckpoint;
  const safe = pointAt(sim.track, sim.track.checkpoints[1].distance - 4);
  pose(sim, 'b', safe.x, safe.y);
  sim.acceptInput('a', { throttle: 1, steer: 1, reset: true, seq: 1 }); sim.step();
  assert.equal(a.resetSerial, 1); assert.equal(a.nextCheckpoint, checkpoint); assert.ok(a.progress <= before);
  assert.ok(a.x < 110);
  assert.ok(Math.hypot(a.x - sim.cars.get('b')!.x, a.y - sim.cars.get('b')!.y) > Math.hypot(RACE.carLength, RACE.carWidth));
  const x = a.x, y = a.y;
  for (let i = 2; i <= 100; i++) { sim.acceptInput('a', { throttle: 1, steer: 1, reset: false, seq: i }); sim.step(); }
  assert.ok(Math.hypot(a.x - x, a.y - y) < .01); assert.equal(a.vx, 0);
  for (let i = 101; i <= 150; i++) { sim.acceptInput('a', { throttle: 1, steer: 0, reset: false, seq: i }); sim.step(); }
  assert.ok(a.x > x);
  // Even after reversing behind the last passed checkpoint, R cannot move the car forward.
  pose(sim, 'a', 30, -7); sim.step(); const reverseBefore = a.progress;
  sim.acceptInput('a', { throttle: 0, steer: 0, reset: true, seq: 151 }); sim.step();
  assert.ok(a.x <= 30 + .01); assert.ok(a.progress <= reverseBefore);
  sim.dispose();
  const rear = new RaceSimulation(straight(), players.slice(0, 2)); rear.start();
  pose(rear, 'a', -37, 0);
  rear.acceptInput('a', { throttle: 0, steer: 0, reset: true, seq: 1 }); rear.step();
  assert.equal(rear.cars.get('a')!.resetSerial, 1);
  assert.ok(rear.cars.get('a')!.x <= -37 + .001);
  rear.dispose();
});

test('pořadí podle času, checkpointů a úseku; vyloučení sdílejí poslední místo', () => {
  const sim = new RaceSimulation(straight(), players.slice(0, 5)); sim.start();
  Object.assign(sim.cars.get('a')!, { status: 'finished', finishMs: 1000 });
  Object.assign(sim.cars.get('b')!, { status: 'finished', finishMs: 900 });
  Object.assign(sim.cars.get('c')!, { nextCheckpoint: 3, progress: 200 });
  sim.exclude('d'); sim.exclude('e'); sim.exclude('d');
  assert.equal(sim.cars.get('d')!.body, null);
  sim.acceptInput('d', { throttle: 1, steer: 1, reset: true, seq: 100 });
  assert.equal(sim.cars.get('d')!.status, 'excluded');
  sim.exclude('a'); assert.equal(sim.cars.get('a')!.status, 'finished');
  const result = sim.results();
  assert.deepEqual(result.map(g => g.players), [['b'], ['a'], ['c'], ['d', 'e']]);
  assert.deepEqual(result.map(g => !!g.unfinished), [false, false, true, true]);
  assert.deepEqual(scoreRound(players.slice(0, 5).map(p => p.id), result, new Map()).map(s => s.points), [4, 3, 2, .5, .5]);
  sim.cars.get('b')!.finishMs = 1000;
  assert.deepEqual(sim.results()[0].players, ['a', 'b']);
  sim.dispose();
});

test('po limitu mají přednost checkpointy a vzdálenost po úseku, nikoli vzdálenost k cíli', () => {
  const sim = new RaceSimulation(straight(), players.slice(0, 4));
  Object.assign(sim.cars.get('a')!, { nextCheckpoint: 3, progress: 180, x: 0, y: 0 });
  Object.assign(sim.cars.get('b')!, { nextCheckpoint: 2, progress: 200, x: sim.track.finish.x, y: sim.track.finish.y });
  Object.assign(sim.cars.get('c')!, { nextCheckpoint: 3, progress: 190, x: -50, y: 0 });
  sim.exclude('d');
  assert.deepEqual(sim.results().map(group => group.players), [['c'], ['a'], ['b'], ['d']]);
  assert.deepEqual(scoreRound(players.slice(0, 4).map(p => p.id), sim.results(), new Map()).map(score => score.points), [3, 2, 1, 0]);
  sim.dispose();
});

test('plný průjezd v serverové fyzice přes všechny checkpointy trvá přibližně tři minuty', () => {
  // An input-only test driver; no bot or automated driving is included in the application.
  for (const seed of [1, 123, 913]) {
    const rng = random(seed), track = generateTrack(rng), sim = new RaceSimulation(track, players.slice(0, 2), rng);
    sim.exclude('b'); sim.start();
    const car = sim.cars.get('a')!;
    let seq = 0;
    while (sim.elapsedMs < RACE.limitSeconds * 1000 && car.status === 'racing') {
      const p = car.body!.getPosition(), distance = projectDistance(track, p).distance;
      const goal = pointAt(track, distance + Math.max(12, Math.hypot(car.vx, car.vy) * .8));
      const error = angleDifference(Math.atan2(goal.y - p.y, goal.x - p.x), car.body!.getAngle());
      sim.acceptInput('a', { throttle: Math.abs(error) > .6 ? 0 : 1, steer: clamp(error * 2.8 - car.angularVelocity * .3, -1, 1), reset: false, seq: ++seq });
      sim.step();
    }
    assert.equal(car.status, 'finished');
    assert.equal(car.nextCheckpoint, track.checkpoints.length);
    assert.ok(car.finishMs! > 145_000 && car.finishMs! < 240_000);
    sim.dispose();
  }
});

test('minihra reaguje na odpojení okamžitě, návrat neobnoví auto a ukončí se právě jednou', () => {
  let data: RaceData | undefined, completions = 0;
  const game = raceGame.create({ participants: players.slice(0, 2), isConnected: () => true, isAdmin: () => false,
    publish(value) { data = value as unknown as RaceData; }, update(patch) { data = { ...data!, ...patch } as unknown as RaceData; }, complete() { completions++; } });
  game.prepare!(); assert.equal(data!.snapshot.running, false);
  game.start(); game.onDisconnect!('a');
  assert.equal(data!.snapshot.cars.find(c => c.id === 'a')!.status, 'excluded');
  game.onMessage!('a', { throttle: 1, steer: 0, reset: true, seq: 100 } as JsonValue);
  assert.equal(data!.snapshot.cars.find(c => c.id === 'a')!.status, 'excluded');
  game.onDisconnect!('b'); game.onDisconnect!('a');
  assert.equal(completions, 1);
  assert.deepEqual(game.finish().map(group => group.players), [['a', 'b']]); game.dispose();
});

test('pomoc při dohánění je plynulá, omezená a na serveru zmenšuje odstup', () => {
  assert.equal(catchupMultiplier(-100), 1);
  assert.equal(catchupMultiplier(0), 1);
  assert.equal(catchupMultiplier(RACE.catchupStartDistance), 1);
  assert.ok(catchupMultiplier(80) > 1 && catchupMultiplier(80) < 1 + RACE.catchupMaxBoost);
  assert.equal(catchupMultiplier(10000), 1 + RACE.catchupMaxBoost);
  const sim = new RaceSimulation(generateTrack(() => .5, 0, 1500), players.slice(0, 2));
  sim.start();
  for (const gate of sim.track.checkpoints.slice(0, 3)) cross(sim, 'a', gate);
  cross(sim, 'b', sim.track.start);
  pose(sim, 'a', 180, -4); pose(sim, 'b', 0, 4); sim.step();
  const before = sim.cars.get('a')!.progress - sim.cars.get('b')!.progress;
  for (let seq = 1; seq <= 1800; seq++) {
    for (const id of ['a', 'b']) sim.acceptInput(id, { throttle: 1, steer: 0, reset: false, seq });
    sim.step();
  }
  const a = sim.cars.get('a')!, b = sim.cars.get('b')!;
  assert.equal(a.catchupBoost, 1);
  assert.ok(b.catchupBoost > 1 && b.catchupBoost <= 1 + RACE.catchupMaxBoost);
  assert.ok(a.progress - b.progress < before - 40);
  assert.ok(b.vx > a.vx);
  sim.exclude('a'); sim.step();
  assert.equal(b.catchupBoost, 1); // Excluded cars never set the leader's distance.
  sim.dispose();
});
