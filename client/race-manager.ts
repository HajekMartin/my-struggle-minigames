import type { JsonValue, MatchPhase, MatchState } from '../shared/types.js';
import type { RaceData } from '../shared/race.js';
import type { RaceView } from './race.js';

let view: RaceView | undefined;
let desired: { key: string; data: RaceData; phase: MatchPhase; ownId: string; send: (data: JsonValue) => void } | undefined;
let loading = false;

export function stopRace() {
  desired = undefined; view?.destroy(); view = undefined;
  document.getElementById('race-panel')!.hidden = true;
  document.body.classList.remove('racing');
}

export function renderRace(match: MatchState | null, ownId: string, send: (data: JsonValue) => void) {
  const data = match?.gameData as unknown as RaceData | null;
  if (!match || match.order[match.roundIndex].id !== 'car-race' || !['rules', 'countdown', 'playing'].includes(match.phase) || data?.kind !== 'car-race') { stopRace(); return; }
  const key = `${match.id}:${match.roundIndex}`;
  if (desired?.key !== key) { view?.destroy(); view = undefined; }
  desired = { key, data, phase: match.phase, ownId, send };
  document.getElementById('race-panel')!.hidden = false;
  document.body.classList.add('racing');
  if (view) { view.ingest(data.snapshot, match.phase); return; }
  if (loading) return;
  loading = true;
  void import('./race.js').then(({ RaceView }) => {
    loading = false;
    if (desired) view = new RaceView(desired.data, desired.phase, desired.ownId, desired.send);
  }).catch(() => {
    loading = false;
    if (desired) document.getElementById('race-status')!.textContent = 'Vykreslení závodu se nepodařilo načíst. Obnovte stránku.';
  });
}
