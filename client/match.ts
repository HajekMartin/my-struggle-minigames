import type { MatchState, RoundScore, TotalScore } from '../shared/types.js';
import type { JsonValue } from '../shared/types.js';
import { renderRace } from './race-manager.js';

const element = (id: string) => document.getElementById(id)!;
let current: MatchState | null = null;
let serverTime = 0;
let receivedAt = 0;
const number = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 });

export function syncMatchClock(now: number) { serverTime = now; receivedAt = performance.now(); }

export function updateCountdown() {
  if (!current) return;
  const seconds = Math.max(0, Math.ceil((current.phaseEndsAt - serverTime - (performance.now() - receivedAt)) / 1000));
  element('phase-time').textContent = `${seconds} s`;
  element('race-countdown').textContent = current.phase === 'rules' ? 'Připravte se' : current.phase === 'countdown' ? String(seconds) : '';
}

export function renderMatch(match: MatchState | null, isAdmin: boolean, ownId: string, send: (data: JsonValue) => void) {
  current = match;
  renderRace(match, ownId, send);
  element('match-panel').hidden = !match;
  if (!match) return;
  const game = match.order[match.roundIndex];
  element('match-round').textContent = `Kolo ${match.roundIndex + 1} / ${match.order.length}`;
  element('minigame-name').textContent = game.name;
  element('minigame-rules').textContent = game.rules;
  const phases = { rules: 'Pravidla', countdown: 'Společný odpočet', playing: 'Probíhá minihra', roundResults: 'Výsledky kola', finalResults: 'Celkové výsledky' };
  element('match-phase').textContent = phases[match.phase];
  element('phase-timer').setAttribute('aria-label', match.phase === 'finalResults' ? 'Návrat do lobby za' : 'Další fáze za');
  element('dev-finish').hidden = game.id !== 'development-test' || match.phase !== 'playing' || !isAdmin;
  const data = match.gameData;
  element('game-message').textContent = data && typeof data === 'object' && !Array.isArray(data) && typeof data.message === 'string' ? data.message : '';
  const results = match.phase === 'roundResults' || match.phase === 'finalResults';
  element('match-results').hidden = !results;
  element('winner').hidden = match.phase !== 'finalResults';
  const names = new Map(match.participants.map(p => [p.id, p.name]));
  element('winner').textContent = match.phase === 'finalResults' ? `${match.winnerIds.length > 1 ? 'Vítězové' : 'Vítěz'}: ${match.winnerIds.map(id => names.get(id)).join(', ')}` : '';
  const round = match.phase === 'roundResults' ? match.rounds.at(-1) : undefined;
  const rows: (TotalScore & Partial<RoundScore>)[] = round ? round.scores : match.totals;
  element('scores').replaceChildren(...rows.map(score => {
    const row = document.createElement('tr');
    if (match.phase === 'finalResults' && score.place === 1) row.className = 'winner-row';
    const values = [String(score.place) + '.', names.get(score.playerId) ?? '',
      score.points === undefined ? '—' : number.format(score.points), number.format(score.total),
      score.unfinished === undefined ? score.place === 1 ? 'Vítěz' : '—' : score.value !== undefined ? String(score.value) : score.unfinished ? 'Nedokončil/a' : 'Dokončil/a'];
    for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    return row;
  }));
  updateCountdown();
}
