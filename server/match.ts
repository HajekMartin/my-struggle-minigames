import { randomInt, randomUUID } from 'node:crypto';
import type { JsonValue, MatchPhase, MatchState, Player, ResultGroup } from '../shared/types.js';
import type { MinigameDefinition, RunningMinigame } from './minigames/types.js';
import { rankTotals, scoreRound } from './scoring.js';

export const RULES_MS = 3_000;
export const COUNTDOWN_MS = 3_000;
export const ROUND_RESULTS_MS = 5_000;
export const FINAL_RESULTS_MS = 8_000;

export function selectMinigames<T extends { id: string }>(games: readonly T[], count: number): T[] {
  if (!games.length) throw new Error('Zatím není dostupná žádná minihra. Zápas nelze spustit.');
  if (!Number.isInteger(count) || count < 1 || new Set(games.map(g => g.id)).size !== games.length) throw new Error('Neplatný registr miniher nebo počet kol.');
  const result: T[] = [];
  while (result.length < count) {
    const bag = [...games];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    if (bag.length > 1 && bag[0].id === result.at(-1)?.id) {
      const other = 1 + randomInt(bag.length - 1);
      [bag[0], bag[other]] = [bag[other], bag[0]];
    }
    result.push(...bag.slice(0, count - result.length));
  }
  return result;
}

interface MatchCallbacks {
  isConnected(id: string): boolean;
  isAdmin(id: string): boolean;
  changed(): void;
  completed(state: MatchState): void;
  returned(): void;
  error(message: string): void;
  updated?(data: { [key: string]: JsonValue }): void;
}

export class Match {
  readonly state: MatchState;
  readonly startedAt = Date.now();
  private totals: Map<string, number>;
  private timer?: NodeJS.Timeout;
  private game?: RunningMinigame;
  private roundToken = 0;
  private settling = false;
  private disposed = false;
  private completed = false;
  private started = false;
  private roundFailed = false;
  private readonly games: readonly MinigameDefinition[];

  constructor(participants: Player[], order: MinigameDefinition[], private callbacks: MatchCallbacks) {
    if (participants.length < 2 || new Set(participants.map(p => p.id)).size !== participants.length || !order.length ||
        order.some(g => !Number.isFinite(g.timeLimitMs) || g.timeLimitMs <= 0 || g.timeLimitMs > 2_147_483_647)) throw new Error('Neplatné nastavení zápasu.');
    this.games = Object.freeze(order.map(game => Object.freeze({ ...game })));
    const locked = Object.freeze(participants.map(p => Object.freeze({ id: p.id, name: p.name })));
    this.totals = new Map(locked.map(p => [p.id, 0]));
    this.state = {
      id: randomUUID(), participants: locked,
      order: Object.freeze(order.map(g => Object.freeze({ id: g.id, name: g.name, rules: g.rules }))),
      roundIndex: 0, phase: 'rules', phaseEndsAt: 0, gameData: null,
      rounds: [], totals: rankTotals(this.totals), winnerIds: []
    };
  }

  start() { if (!this.started && !this.disposed) { this.started = true; this.showRules(); } }

  private transition(phase: MatchPhase, duration: number, next: () => void) {
    clearTimeout(this.timer);
    this.state.phase = phase;
    this.state.phaseEndsAt = Date.now() + duration;
    this.timer = setTimeout(() => { if (!this.disposed) next(); }, duration);
    this.callbacks.changed();
  }

  private showRules() {
    this.roundToken++;
    this.state.gameData = null;
    this.transition('rules', RULES_MS, () => this.transition('countdown', COUNTDOWN_MS, () => this.play()));
    const token = this.roundToken;
    const definition = this.games[this.state.roundIndex];
    const current = () => !this.disposed && this.roundToken === token && !this.settling && ['rules', 'countdown', 'playing'].includes(this.state.phase);
    this.roundFailed = false;
    try {
      this.game = definition.create({
        participants: this.state.participants,
        isConnected: id => this.callbacks.isConnected(id),
        isAdmin: id => this.callbacks.isAdmin(id),
        publish: data => { if (current()) { this.state.gameData = data; this.callbacks.changed(); } },
        update: data => {
          if (!current()) return;
          const previous = this.state.gameData;
          if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return;
          this.state.gameData = { ...previous, ...data };
          this.callbacks.updated?.(data);
        },
        complete: () => {
          // Defer synchronous completion from start(), and ignore other phases or old rounds.
          queueMicrotask(() => { if (current() && this.state.phase === 'playing') this.finishRound(); });
        }
      });
      this.game.prepare?.();
    } catch {
      this.roundFailed = true;
      this.callbacks.error('Minihru se nepodařilo připravit. Účastníci budou vyhodnoceni jako nedokončivší.');
    }
  }

  private play() {
    const definition = this.games[this.state.roundIndex];
    this.state.phase = 'playing';
    this.state.phaseEndsAt = Date.now() + definition.timeLimitMs;
    if (this.roundFailed) { this.finishRound(true); return; }
    try {
      this.timer = setTimeout(() => this.finishRound(), definition.timeLimitMs);
      this.game!.start();
      this.callbacks.changed();
    } catch {
      this.callbacks.error('Minihru se nepodařilo spustit. Účastníci jsou vyhodnoceni jako nedokončivší.');
      this.finishRound(true);
    }
  }

  disconnected(playerId: string) {
    if (this.disposed || !['rules', 'countdown', 'playing'].includes(this.state.phase)) return;
    try { this.game?.onDisconnect?.(playerId); }
    catch { this.callbacks.error('Minihra nedokázala zpracovat odpojení hráče.'); }
  }

  message(playerId: string, roundIndex: number, data: JsonValue) {
    if (this.disposed || this.settling || this.state.phase !== 'playing' || roundIndex !== this.state.roundIndex || !this.state.participants.some(p => p.id === playerId)) return;
    try { this.game?.onMessage?.(playerId, data); }
    catch { this.callbacks.error('Minihra odmítla neplatnou zprávu.'); }
  }

  private finishRound(failed = false) {
    if (this.disposed || this.settling || this.state.phase !== 'playing' || this.state.rounds.some(r => r.round === this.state.roundIndex + 1)) return;
    this.settling = true;
    clearTimeout(this.timer);
    const ids = this.state.participants.map(p => p.id);
    const unfinished: ResultGroup[] = [{ players: ids, unfinished: true }];
    let scores;
    try {
      const results = failed ? unfinished : this.game!.finish();
      scores = scoreRound(ids, results, this.totals);
    } catch {
      this.callbacks.error('Minihra vrátila neplatné výsledky. Všichni účastníci jsou vyhodnoceni jako nedokončivší.');
      scores = scoreRound(ids, unfinished, this.totals);
    } finally { this.cleanupGame(); }
    // No total is mutated until the entire ranking passes validation.
    for (const score of scores) this.totals.set(score.playerId, score.total);
    this.state.rounds.push({ round: this.state.roundIndex + 1, minigameId: this.games[this.state.roundIndex].id, scores });
    this.state.totals = rankTotals(this.totals);
    this.state.gameData = null;
    this.settling = false;
    this.transition('roundResults', ROUND_RESULTS_MS, () => {
      if (this.state.roundIndex + 1 < this.games.length) { this.state.roundIndex++; this.showRules(); }
      else this.finishMatch();
    });
  }

  private finishMatch() {
    if (this.completed) return;
    this.completed = true;
    this.state.winnerIds = this.state.totals.filter(s => s.place === 1).map(s => s.playerId);
    this.transition('finalResults', FINAL_RESULTS_MS, () => { this.dispose(); this.callbacks.returned(); });
    this.callbacks.completed(this.state);
  }

  private cleanupGame() {
    try { this.game?.dispose(); }
    catch { this.callbacks.error('Úklid minihry skončil chybou.'); }
    this.game = undefined;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.roundToken++;
    this.cleanupGame();
  }
}
