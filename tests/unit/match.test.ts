import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Match, selectMinigames, RULES_MS, COUNTDOWN_MS, ROUND_RESULTS_MS, FINAL_RESULTS_MS } from '../../server/match.js';
import { scoreRound, rankTotals } from '../../server/scoring.js';
import { developmentGame } from '../../server/minigames/development.js';
import type { MinigameContext, MinigameDefinition } from '../../server/minigames/types.js';
import type { JsonValue, Player, ResultGroup } from '../../shared/types.js';

const players: Player[] = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id.toUpperCase() }));
const ids = players.map(p => p.id);
const zero = new Map(ids.map(id => [id, 0]));

test('průměr bodů za dělená místa, poslední místo, interní skóre a celkové remízy', () => {
  const scores = scoreRound(ids, [{ players: ['a', 'b'], values: { a: 100000, b: 1 } }, { players: ['c'] }, { players: ['d'], unfinished: true }], zero);
  assert.deepEqual(scores.map(s => [s.place, s.points]), [[1, 2.5], [1, 2.5], [3, 1], [4, 0]]);
  assert.equal(scores[0].total, scores[1].total);
  assert.equal(scores[0].value, 100000);
  assert.deepEqual(rankTotals(new Map(scores.map(s => [s.playerId, s.total]))).map(s => s.place), [1, 1, 3, 4]);
  assert.deepEqual(scoreRound(ids, [{ players: ['a'] }, { players: ['b'] }, { players: ['c', 'd'], unfinished: true }], zero).map(s => s.points), [3, 2, .5, .5]);
  assert.deepEqual(scoreRound(ids, [{ players: ids, unfinished: true }], zero).map(s => s.points), [1.5, 1.5, 1.5, 1.5]);
  assert.deepEqual([...zero.values()], [0, 0, 0, 0]);
});

test('neplatné, chybějící a duplicitní účastníky odmítne celé vyhodnocení', () => {
  const invalid: ResultGroup[][] = [[], [{ players: ['a', 'b', 'c'] }], [{ players: ['a', 'a', 'c', 'd'] }],
    [{ players: ['a', 'b', 'c', 'x'] }], [{ players: [] }, { players: ids }],
    [{ players: ['a'], unfinished: true }, { players: ['b', 'c', 'd'] }]];
  for (const groups of invalid) assert.throws(() => scoreRound(ids, groups, zero));
  assert.deepEqual([...zero.values()], [0, 0, 0, 0]);
});

test('náhodné sáčky: vyčerpání registru bez opakování, ani shoda na hranici', () => {
  for (let size = 1; size <= 5; size++) {
    const games = Array.from({ length: size }, (_, i) => ({ id: String(i) }));
    for (let attempt = 0; attempt < 100; attempt++) {
      const order = selectMinigames(games, 29);
      assert.equal(order.length, 29);
      for (let start = 0; start < order.length; start += size) {
        const bag = order.slice(start, start + size);
        assert.equal(new Set(bag.map(g => g.id)).size, bag.length);
      }
      if (size > 1) for (let i = 1; i < order.length; i++) assert.notEqual(order[i].id, order[i - 1].id);
    }
  }
  assert.throws(() => selectMinigames([], 1), /žádná minihra/);
  assert.throws(() => selectMinigames([{ id: 'a' }, { id: 'a' }], 1));
});

test('dvě kola, přesné přechody, dvojí complete, pozdní callback a úklid', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const contexts: MinigameContext[] = [];
  let disposed = 0, completed = 0, returned = 0;
  const game: MinigameDefinition = {
    id: 'fixture', name: 'Fixture', rules: 'Test', timeLimitMs: 1000,
    create(context) {
      contexts.push(context);
      return { start() {}, finish: () => [{ players: ['a', 'b'] }, { players: ['c'] }, { players: ['d'] }], dispose() { disposed++; } };
    }
  };
  const match = new Match(players, [game, game], { isConnected: () => true, isAdmin: id => id === 'a', changed() {}, error: message => assert.fail(message), completed() { completed++; }, returned() { returned++; } });
  match.start(); match.start();
  assert.equal(match.state.phase, 'rules');
  assert.equal(match.state.phaseEndsAt, 1000 + RULES_MS);
  for (let round = 0; round < 2; round++) {
    t.mock.timers.tick(RULES_MS); assert.equal(match.state.phase, 'countdown');
    t.mock.timers.tick(COUNTDOWN_MS); assert.equal(match.state.phase, 'playing');
    if (round) { contexts[0].complete(); await Promise.resolve(); assert.equal(match.state.rounds.length, 1); }
    contexts[round].complete(); contexts[round].complete();
    await Promise.resolve();
    assert.equal(match.state.rounds.length, round + 1);
    assert.equal(match.state.phase, 'roundResults');
    assert.equal(match.state.totals.find(s => s.playerId === 'a')!.total, (round + 1) * 2.5);
    assert.equal(disposed, round + 1);
    // The old hard time limit may fire during results; it must not award points again.
    t.mock.timers.tick(ROUND_RESULTS_MS);
  }
  assert.equal(match.state.phase, 'finalResults');
  assert.deepEqual(match.state.winnerIds, ['a', 'b']);
  assert.equal(completed, 1);
  t.mock.timers.tick(FINAL_RESULTS_MS);
  assert.equal(returned, 1);
  contexts[1].complete(); await Promise.resolve();
  match.start(); match.dispose();
  assert.equal(match.state.rounds.length, 2);
  assert.equal(completed, 1); assert.equal(disposed, 2);
});

test('časový limit vyhodnotí odpojené, zachová P a následně uklidí minihru', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const connected = new Set(ids);
  const match = new Match(players, [developmentGame], { isConnected: id => connected.has(id), isAdmin: () => false, changed() {}, error: message => assert.fail(message), completed() {}, returned() {} });
  match.start(); t.mock.timers.tick(RULES_MS); t.mock.timers.tick(COUNTDOWN_MS);
  connected.delete('c'); connected.delete('d');
  t.mock.timers.tick(developmentGame.timeLimitMs);
  assert.equal(match.state.phase, 'roundResults');
  assert.deepEqual(match.state.rounds[0].scores.map(s => [s.playerId, s.points, s.unfinished]), [['a', 2.5, false], ['b', 2.5, false], ['c', .5, true], ['d', .5, true]]);
  assert.equal(match.state.participants.length, 4);
  match.dispose(); t.mock.timers.tick(100000);
  assert.equal(match.state.phase, 'roundResults');
});

test('chybná minihra se nezasekne a úklid se zavolá i při neplatných výsledcích', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let errors = 0, cleaned = 0;
  const broken: MinigameDefinition = { id: 'broken', name: 'Broken', rules: '', timeLimitMs: 100,
    create: () => ({ start() {}, finish: () => [{ players: ['a', 'a'] }], dispose() { cleaned++; } }) };
  const match = new Match(players, [broken], { isConnected: () => false, isAdmin: () => false, changed() {}, error() { errors++; }, completed() {}, returned() {} });
  match.start(); t.mock.timers.tick(RULES_MS); t.mock.timers.tick(COUNTDOWN_MS); t.mock.timers.tick(100);
  assert.equal(cleaned, 1); assert.equal(errors, 1);
  assert.equal(match.state.rounds.length, 1);
  assert.ok(match.state.rounds[0].scores.every(s => s.unfinished && s.points === 1.5));
  match.dispose();
});

test('vývojová minihra přijme předem určené výsledky pouze od správce', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const match = new Match(players, [developmentGame], { isConnected: () => true, isAdmin: id => id === 'a', changed() {}, error: message => assert.fail(message), completed() {}, returned() {} });
  match.start(); t.mock.timers.tick(RULES_MS); t.mock.timers.tick(COUNTDOWN_MS);
  const data: JsonValue = { action: 'finish', groups: [{ players: ['d'] }, { players: ['b', 'c'] }, { players: ['a'], unfinished: true }] };
  match.message('b', 0, data); await Promise.resolve();
  assert.equal(match.state.phase, 'playing');
  match.message('a', 1, data); await Promise.resolve();
  assert.equal(match.state.phase, 'playing');
  match.message('a', 0, data); match.message('a', 0, data); await Promise.resolve();
  assert.equal(match.state.rounds.length, 1);
  assert.deepEqual(match.state.rounds[0].scores.map(s => [s.playerId, s.points]), [['d', 3], ['b', 1.5], ['c', 1.5], ['a', 0]]);
  match.dispose();
});

test('registr nabízí testovací minihru výhradně v development', () => {
  for (const mode of ['production', 'test', 'development']) {
    for (const fixture of ['0', '1']) {
      const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        "import { minigames } from './server/minigames/index.ts'; console.log(JSON.stringify(minigames.map(g => g.id)))"], { env: { ...process.env, NODE_ENV: mode, MINIGAME_TEST_ONLY: fixture }, encoding: 'utf8' });
      assert.deepEqual(JSON.parse(result), mode === 'development' && fixture === '1' ? ['development-test'] : ['car-race']);
    }
  }
});
