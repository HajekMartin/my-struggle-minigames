import type { JsonValue, MatchPhase, MatchState } from '../shared/types.js';
import type { WormData } from '../shared/worms.js';
import type { WormView } from './worms.js';

let view: WormView | undefined;
let desired: { key: string; data: WormData; phase: MatchPhase; ownId: string; send: (data: JsonValue) => void } | undefined;
let loading = false;

export function stopWorms() {
  desired = undefined; view?.destroy(); view = undefined;
  document.getElementById('worms-panel')!.hidden = true; document.body.classList.remove('worms');
}
export function renderWorms(match: MatchState | null, ownId: string, send: (data: JsonValue) => void) {
  const data = match?.gameData as unknown as WormData | null;
  if (!match || match.order[match.roundIndex].id !== 'worms' || !['rules', 'countdown', 'playing'].includes(match.phase) || data?.kind !== 'worms') { stopWorms(); return; }
  const key = `${match.id}:${match.roundIndex}`;
  if (desired?.key !== key) { view?.destroy(); view = undefined; }
  desired = { key, data, phase: match.phase, ownId, send };
  document.getElementById('worms-panel')!.hidden = false; document.body.classList.add('worms');
  if (view) { view.ingest(data, match.phase); return; }
  if (loading) return;
  loading = true;
  void import('./worms.js').then(({ WormView }) => {
    loading = false;
    if (desired) view = new WormView(desired.data, desired.phase, desired.ownId, desired.send);
  }).catch(() => { loading = false; if (desired) document.getElementById('worms-help')!.textContent = 'Souboj se nepodařilo načíst. Obnovte stránku.'; });
}
