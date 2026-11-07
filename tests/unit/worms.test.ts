import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORMS as W, type WormData } from '../../shared/worms.js';
import type { JsonValue } from '../../shared/types.js';
import { WormSimulation } from '../../server/minigames/worms/simulation.js';
import { crater, generateTerrain, hitsTerrain, solidAt } from '../../server/minigames/worms/terrain.js';
import { wormsGame } from '../../server/minigames/worms/index.js';
import { scoreRound } from '../../server/scoring.js';

const players = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id }));
const make = (count = 3) => new WormSimulation(players.slice(0, count), () => .5);
function step(sim: WormSimulation, seconds: number) { for (let i = 0; i < Math.ceil(seconds * W.physicsHz); i++) sim.step(); }
function resolve(sim: WormSimulation) {
  const turn = sim.turnNumber;
  for (let i = 0; i < W.physicsHz * (W.effectsMs / 1000 + 1) && !sim.over && sim.turnNumber === turn; i++) sim.step();
}
function flat(sim: WormSimulation, y = 500) {
  for (let i = 0; i < sim.terrain.columns.length; i++) sim.terrain.columns[i] = [y, W.height];
  sim.terrain.revision++;
}
function place(sim: WormSimulation, id: string, x: number, y = 500 - W.radius) {
  Object.assign(sim.characters.get(id)!, { x, y, vx: 0, vy: 0, grounded: true });
}
function fire(sim: WormSimulation, aim: number, seconds = .1) {
  const id = sim.activeId!;
  sim.input(id, { type: 'control', move: 0, jump: false, aim });
  sim.input(id, { type: 'charge' }); step(sim, seconds); sim.input(id, { type: 'fire' });
}

test('terén je kopcovitý a společný, postavy stojí bezpečně a mají rozestupy i při osmi hráčích', () => {
  const terrain = generateTerrain(() => .1), other = generateTerrain(() => .9);
  assert.notDeepEqual(terrain.columns, other.columns);
  const sim = new WormSimulation(Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: '<hráč>' })), () => .5);
  const before = sim.snapshot();
  for (const c of before.characters) {
    assert.equal(c.hp, 100); assert.ok(c.y + W.radius < W.waterY);
    assert.equal(hitsTerrain(sim.terrain, c.x, c.y, W.radius), false);
    assert.equal(hitsTerrain(sim.terrain, c.x, c.y + 2, W.radius), true);
    for (const b of before.characters) if (b.id !== c.id) assert.ok(Math.hypot(c.x - b.x, c.y - b.y) > 100);
  }
  sim.input(before.order[0], { type: 'charge' }); sim.step();
  assert.deepEqual(sim.snapshot(), before);
  sim.dispose();
});

test('tahy používají stejný zamíchaný seznam, doplňují staminu, cizí vstupy odmítají a vyřazené přeskakují', () => {
  const sim = make(); flat(sim); players.slice(0, 3).forEach((p, i) => place(sim, p.id, 200 + i * 300));
  assert.notDeepEqual(sim.order, players.slice(0, 3).map(p => p.id));
  sim.start(); const order = [...sim.order], active = sim.activeId!, other = order[1];
  sim.input(other, { type: 'control', move: 1, jump: true, aim: 10 }); sim.input(other, { type: 'charge' }); sim.input(other, { type: 'end' });
  assert.equal(sim.phase, 'turn'); assert.equal(sim.chargeStartedAt, null);
  sim.characters.get(active)!.stamina = 0;
  sim.input(active, { type: 'end' }); resolve(sim);
  assert.equal(sim.activeId, order[1]);
  sim.characters.get(order[2])!.hp = 0;
  Object.assign(sim.characters.get(order[2])!, { status: 'dead', eliminatedGroup: 1 });
  sim.input(sim.activeId!, { type: 'end' }); resolve(sim);
  assert.equal(sim.activeId, active); assert.equal(sim.characters.get(active)!.stamina, W.stamina);
  assert.deepEqual(sim.order, order);
  sim.dispose();
});

test('stání nic nestojí, pohyb spotřebuje vzdálenost, skok staminu a vyčerpaný hráč stále vystřelí', () => {
  const sim = make(2); flat(sim); place(sim, 'a', 250); place(sim, 'b', 900); sim.start();
  const c = sim.characters.get(sim.activeId!)!;
  step(sim, 1); assert.equal(c.stamina, W.stamina);
  const before = c.x;
  for (let i = 0; i < W.physicsHz * 3; i++) {
    sim.input(c.id, { type: 'control', move: 1, jump: false, aim: -Math.PI / 2 }); sim.step();
  }
  assert.equal(c.stamina, 0); assert.ok(Math.abs(c.x - before - W.stamina) < .01);
  sim.input(c.id, { type: 'control', move: 1, jump: true, aim: -Math.PI / 2 }); sim.step();
  assert.equal(c.stamina, 0); assert.equal(c.vy, 0);
  fire(sim, -Math.PI / 2); assert.ok(sim.projectile); assert.equal(sim.shotUsed, true);
  const projectile = sim.projectile;
  sim.input(c.id, { type: 'charge' }); sim.input(c.id, { type: 'fire' });
  sim.input(c.id, { type: 'control', move: -1, jump: true, aim: 0 });
  assert.equal(sim.projectile, projectile); assert.equal(sim.phase, 'effects');
  const x = c.x; step(sim, .1); assert.ok(Math.abs(c.x - x) < .01);
  sim.dispose();
  const jumping = make(2); flat(jumping); place(jumping, 'a', 250); place(jumping, 'b', 900); jumping.start();
  const jumper = jumping.characters.get(jumping.activeId!)!;
  jumping.input(jumper.id, { type: 'control', move: 0, jump: true, aim: 0 }); jumping.step();
  assert.equal(jumper.stamina, W.stamina - W.jumpCost); assert.ok(jumper.vy < 0);
  step(jumping, .1); assert.equal(jumper.stamina, W.stamina - W.jumpCost);
  jumping.dispose();
});

test('čas tahu a tlačítko konec pokračují až po ustálení; neplatné zprávy a přehnaná síla se nepřijímají', () => {
  const sim = make(); sim.start(); const first = sim.activeId;
  sim.input(first!, { type: 'control', move: NaN, jump: true, aim: Infinity });
  sim.input(first!, { type: 'fire', power: 100000 }); assert.equal(sim.projectile, null);
  step(sim, 25); assert.equal(sim.phase, 'effects'); assert.equal(sim.activeId, first);
  resolve(sim); assert.notEqual(sim.activeId, first); assert.equal(sim.turnNumber, 2);
  sim.input(sim.activeId!, { type: 'control', move: 0, jump: false, aim: -Math.PI / 2 });
  sim.input(sim.activeId!, { type: 'charge' }); step(sim, 2);
  sim.input(sim.activeId!, { type: 'fire', power: 100000 });
  assert.ok(Math.abs(sim.projectile!.vy + W.maxShotSpeed) < .01);
  const turn = sim.turnNumber; step(sim, .2); assert.equal(sim.turnNumber, turn);
  resolve(sim); assert.ok(sim.turnNumber > turn || sim.over); sim.dispose();
});

test('kruhový kráter odebere i skutečnou kolizi a může vytvořit díru pod převisem', () => {
  const sim = make(); flat(sim, 300);
  assert.equal(solidAt(sim.terrain, 600, 450), true);
  crater(sim.terrain, 600, 450, 50);
  assert.equal(solidAt(sim.terrain, 600, 450), false);
  assert.equal(hitsTerrain(sim.terrain, 600, 450, 10), false);
  assert.equal(solidAt(sim.terrain, 600, 350), true);
  assert.equal(solidAt(sim.terrain, 600, 550), true);
  assert.equal(solidAt(sim.terrain, 670, 450), true);
  assert.equal(sim.terrain.revision, 2);
  sim.dispose();
});

test('projektil trefí tenký terén, exploduje jednou, zasáhne i střelce a kráter způsobí pád', () => {
  const sim = make(2); flat(sim); place(sim, 'a', 300); place(sim, 'b', 700); sim.start();
  const c = sim.characters.get(sim.activeId!)!;
  // A one-pixel vertical sliver in the path of a maximum-speed projectile.
  const wall = Math.floor((c.x + 30) / W.terrainStep);
  sim.terrain.columns[wall] = [c.y - 10, c.y + 10, 500, W.height];
  const startY = c.y; fire(sim, 0, 1.5);
  const hp = c.hp, revision = sim.terrain.revision;
  step(sim, .1);
  assert.equal(sim.projectile, null); assert.ok(sim.explosion);
  assert.equal(sim.terrain.revision, revision + 1);
  assert.ok(c.hp < hp && hp - c.hp <= W.maxDamage);
  const after = c.hp; step(sim, 1);
  assert.equal(c.hp, after); assert.equal(sim.terrain.revision, revision + 1);
  assert.ok(c.y > startY || c.vy !== 0);
  sim.dispose();
});

test('balistická střela zasáhne soupeřovu postavu před terénem a vzdáleného střelce nezraní', () => {
  const sim = make(2); flat(sim); sim.start();
  const shooter = sim.characters.get(sim.activeId!)!, target = [...sim.characters.values()].find(c => c !== shooter)!;
  place(sim, shooter.id, 200); place(sim, target.id, 400);
  fire(sim, -Math.PI / 18, 1.5);
  step(sim, .5);
  assert.equal(sim.projectile, null);
  assert.ok(target.hp < W.health && target.hp >= W.health - W.maxDamage);
  assert.equal(shooter.hp, W.health);
  assert.ok(sim.explosion!.x > 380 && sim.explosion!.x < 400);
  sim.dispose();
});

test('výbuch a následné pády mají společné umístění nezávisle na pořadí zpracování', () => {
  for (const reverse of [false, true]) {
    const sim = make(); flat(sim, W.waterY - 8);
    if (reverse) { const entries = [...sim.characters.entries()].reverse(); sim.characters.clear(); for (const [id, c] of entries) sim.characters.set(id, c); }
    sim.start(); const id = sim.activeId!;
    for (const c of sim.characters.values()) { c.x = 600; c.y = W.waterY - 20; c.hp = c.id === id ? 1 : 100; c.grounded = false; }
    // Shooter dies in the blast; the others lose their thin support and fall into water.
    sim.input(id, { type: 'charge' }); sim.input(id, { type: 'fire' });
    sim.projectile!.x = 600; sim.projectile!.y = W.waterY - 8;
    resolve(sim);
    assert.equal(sim.over, true);
    assert.ok([...sim.characters.values()].every(c => c.status === 'dead'));
    assert.equal(new Set([...sim.characters.values()].map(c => c.eliminatedGroup)).size, 1);
    assert.equal(sim.results().length, 1);
    assert.deepEqual(new Set(sim.results()[0].players), new Set(['a', 'b', 'c']));
    assert.deepEqual(scoreRound(['a', 'b', 'c'], sim.results(), new Map()).map(s => s.points), [1, 1, 1]);
    sim.dispose();
  }
});

test('voda, pořadí vyřazení, odpojení, zachování dřívějšího výsledku a zákaz návratu do souboje', () => {
  const sim = make(4); sim.start();
  const a = sim.characters.get('a')!; a.y = W.waterY; sim.step();
  const earned = a.eliminatedGroup; sim.disconnect('a'); assert.equal(a.status, 'dead'); assert.equal(a.eliminatedGroup, earned);
  sim.disconnect('b'); sim.disconnect('c');
  sim.input('b', { type: 'charge' }); sim.input('b', { type: 'fire' });
  resolve(sim); assert.equal(sim.over, true);
  assert.deepEqual(sim.results().map(g => g.players), [['d'], ['a'], ['b', 'c']]);
  assert.equal(sim.characters.get('b')!.status, 'disconnected'); sim.dispose();
});

test('po pěti minutách se dokončí letící výstřel, nové tahy nevzniknou a životy rozhodují včetně remíz', () => {
  const sim = make(4); flat(sim); [...sim.characters.values()].forEach((c, i) => place(sim, c.id, 150 + i * 250));
  sim.start(); sim.elapsedMs = W.matchMs - 100; sim.turnEndsAt = sim.elapsedMs + W.turnMs;
  fire(sim, -Math.PI / 2, .02);
  assert.equal(sim.phase, 'effects'); assert.ok(sim.projectile);
  const turn = sim.turnNumber;
  step(sim, .2); assert.ok(sim.elapsedMs > W.matchMs); assert.equal(sim.over, false);
  sim.input(sim.activeId!, { type: 'charge' });
  resolve(sim); assert.equal(sim.over, true); assert.equal(sim.turnNumber, turn);
  Object.assign(sim.characters.get('a')!, { status: 'alive', hp: 70 });
  Object.assign(sim.characters.get('b')!, { status: 'alive', hp: 70 });
  Object.assign(sim.characters.get('c')!, { status: 'dead', hp: 0, eliminatedGroup: 2 });
  Object.assign(sim.characters.get('d')!, { status: 'dead', hp: 0, eliminatedGroup: 1 });
  assert.deepEqual(sim.results().map(g => g.players), [['a', 'b'], ['c'], ['d']]);
  sim.dispose();
});

test('bezpečnostní limit ustálí účinky a po dispose se simulace nepohybuje', () => {
  const sim = make(2); sim.start(); fire(sim, -Math.PI / 2);
  sim.elapsedMs += W.effectsMs + 1; sim.step();
  assert.ok(sim.turnNumber === 2 || sim.over); assert.equal(sim.projectile, null);
  sim.dispose(); const before = sim.snapshot(); step(sim, 1); assert.deepEqual(sim.snapshot(), before);
});

test('napojení vyhodnotí všechny účastníky právě jednou a uklidí interval', () => {
  let data: WormData | undefined, completed = 0;
  const game = wormsGame.create({ participants: players.slice(0, 2), isConnected: () => false, isAdmin: () => false,
    publish(value) { data = value as unknown as WormData; }, update(value) { data = { ...data!, ...value } as unknown as WormData; }, complete() { completed++; } });
  game.prepare!(); assert.equal(data!.snapshot.running, false);
  game.start(); game.onDisconnect!('a'); game.onDisconnect!('b');
  assert.equal(completed, 1);
  assert.deepEqual(new Set(game.finish()[0].players), new Set(['a', 'b']));
  const before = JSON.stringify(data); game.dispose(); game.onMessage!('a', { type: 'charge' } as JsonValue);
  assert.equal(JSON.stringify(data), before);
});
