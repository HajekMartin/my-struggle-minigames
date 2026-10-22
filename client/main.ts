import { Client, type Room, type SeatReservation } from '@colyseus/sdk';
import type { JsonValue, LobbyState, Player } from '../shared/types.js';
import { renderRace, stopRace } from './race-manager.js';
import { MAX_ROUNDS } from '../shared/config.js';
import { renderMatch, syncMatchClock, updateCountdown } from './match.js';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sdk = new Client(location.origin);
let player: Player | null = null;
let room: Room | undefined;
let state: LobbyState | undefined;
let busy = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryUntil = 0;

function error(message = '') { element('error').textContent = message; element('error').hidden = !message; }
function connection(message = '') { element('connection').textContent = message; element('connection').hidden = !message; }
function show(screen: 'identity' | 'choices' | 'lobby') {
  for (const id of ['identity', 'choices', 'lobby']) element(id).hidden = id !== screen;
  element('player-name').textContent = player?.name ?? '';
}
function setBusy(value: boolean) {
  busy = value;
  for (const button of document.querySelectorAll<HTMLButtonElement>('button')) button.disabled = value;
  element<HTMLButtonElement>('ready').disabled = value || !room || !!state?.started;
  element<HTMLSelectElement>('round-count').disabled = value || !room || !!state?.started || state?.adminId !== player?.id;
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Požadavek se nepodařil.');
  return data;
}
function render(next: LobbyState) {
  state = next;
  syncMatchClock(next.serverTime);
  error(next.error ?? '');
  show('lobby');
  if (element('lobby-code').textContent !== next.code) {
    element('copy-code').textContent = 'Kopírovat';
    element('copy-status').textContent = '';
  }
  element('lobby-code').textContent = next.code;
  element('lobby-title').textContent = next.started ? 'Hra spuštěna' : 'Lobby';
  element<HTMLSelectElement>('round-count').value = String(next.roundCount);
  element('lobby-settings').hidden = next.started;
  renderMatch(next.match, next.adminId === player?.id, player?.id ?? '', sendGame);
  element('count').textContent = `${next.players.length} / 8`;
  element('players').replaceChildren(...next.players.map(p => {
    const row = document.createElement('li');
    row.classList.toggle('is-self', p.id === player?.id);
    const label = document.createElement('span'); label.className = 'player-label';
    const initial = document.createElement('span'); initial.className = 'initial'; initial.textContent = [...p.name][0]?.toUpperCase() ?? '';
    const name = document.createElement('span'); name.textContent = p.name;
    label.append(initial, name);
    if (p.id === player?.id) { const you = document.createElement('span'); you.className = 'you'; you.textContent = '(vy)'; label.append(you); }
    if (p.id === next.adminId) { const admin = document.createElement('span'); admin.className = 'admin-badge'; admin.textContent = 'Správce'; label.append(admin); }
    const status = document.createElement('span'); status.className = `status${p.connected && (p.ready || next.started) ? ' is-ready' : ''}`;
    const statusIcon = document.createElement('span'); statusIcon.className = 'status-icon'; statusIcon.setAttribute('aria-hidden', 'true');
    statusIcon.textContent = p.connected && (p.ready || next.started) ? '✓' : '○';
    status.append(statusIcon, document.createTextNode(!p.connected ? 'Odpojen/a · čekáme na návrat' : next.started ? 'Připojen' : p.ready ? 'Připraven' : 'Čeká'));
    const actions = document.createElement('span'); actions.className = 'player-actions'; actions.append(status);
    if (next.adminId === player?.id && p.id !== player.id) {
      const kick = document.createElement('button'); kick.type = 'button'; kick.className = 'kick-button';
      kick.textContent = 'Vyhodit'; kick.setAttribute('aria-label', `Vyhodit hráče ${p.name}`);
      kick.addEventListener('click', () => { if (room && !busy) room.send('kick', p.id); });
      actions.append(kick);
    }
    row.append(label, actions); return row;
  }));
  const own = next.players.find(p => p.id === player?.id);
  element('ready').textContent = own?.ready ? 'Zrušit připravenost' : 'Jsem připraven/a';
  element('ready').classList.toggle('ready-confirmed', !!own?.ready);
  element('ready').setAttribute('aria-pressed', String(!!own?.ready));
  element('ready').hidden = next.started;
  element('ready').parentElement!.hidden = next.started;
  element('lobby-hint').textContent = next.started ? 'Všichni byli připraveni. Hra spuštěna.' : next.players.length < 2 ? 'Pozvěte alespoň jednoho dalšího hráče pomocí kódu.' : 'Hra se spustí automaticky, až budou všichni připojení a připravení.';
  setBusy(busy);
}

async function join(action: 'create' | 'join' | 'resume', code?: string) {
  const { seat } = await api<{ seat: SeatReservation }>('/api/lobby', { action, code });
  const joined = await sdk.consumeSeatReservation(seat);
  // Reload recovery uses the HttpOnly identity, never a stored reconnection token.
  joined.reconnection.enabled = false;
  room = joined;
  joined.onMessage<LobbyState>('lobby', next => { if (room === joined) render(next); });
  joined.onMessage<{ matchId: string; roundIndex: number; data: { [key: string]: JsonValue } }>('minigameUpdate', update => {
    const match = state?.match;
    if (room !== joined || !match || match.id !== update.matchId || match.roundIndex !== update.roundIndex || !match.gameData || typeof match.gameData !== 'object' || Array.isArray(match.gameData)) return;
    match.gameData = { ...match.gameData, ...update.data };
    renderRace(match, player?.id ?? '', sendGame);
  });
  joined.onMessage<string>('error', message => { if (room === joined) error(message); });
  joined.onError((_code, message) => error(message || 'Chyba připojení.'));
  joined.onLeave(code => {
    if (room !== joined) return;
    stopRace();
    room = undefined;
    setBusy(false);
    if (code === 4000) {
      state = undefined; connection(); show('choices'); return;
    }
    if (code === 4001) { connection(); error('Lobby je otevřena v jiné kartě. Tuto stránku můžete zavřít nebo obnovit.'); return; }
    if (code === 4002) { error('Platnost přihlášení vypršela. Obnovte stránku a zadejte jméno.'); return; }
    if (code === 4004) {
      clearTimeout(retryTimer);
      state = undefined; connection(); show('choices'); error('Správce vás vyhodil z lobby.'); return;
    }
    connection('Spojení bylo přerušeno. Pokoušíme se o návrat do lobby (nejvýše 30 sekund).');
    retryUntil = Date.now() + 30_000;
    retryTimer = setTimeout(retry, 500);
  });
  joined.send('sync');
  error(); connection();
}

function sendGame(data: JsonValue) {
  if (room && state?.match && !busy) room.send('minigame', { matchId: state.match.id, roundIndex: state.match.roundIndex, data });
}

async function retry() {
  if (room) return;
  try {
    const me = await api<{ player: Player | null; lobbyCode: string | null }>('/api/me');
    if (!me.player) { player = null; show('identity'); connection(); error('Platnost přihlášení vypršela. Zadejte jméno znovu.'); return; }
    if (!me.lobbyCode) { state = undefined; show('choices'); connection(); error('Původní lobby už neexistuje nebo vypršel čas na návrat.'); return; }
    await join('resume');
  } catch {
    if (Date.now() < retryUntil) retryTimer = setTimeout(retry, 1_000);
    else { connection(); error('Spojení se nepodařilo obnovit. Zkontrolujte síť a obnovte stránku.'); }
  }
}

async function run(action: () => Promise<void>) {
  if (busy) return;
  setBusy(true); error();
  try { await action(); } catch (e) { error(e instanceof Error ? e.message : 'Server není dostupný. Zkuste to znovu.'); }
  finally { setBusy(false); }
}
element('name-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    const result = await api<{ player: Player }>('/api/player', { name: element<HTMLInputElement>('name').value });
    player = result.player; show('choices');
  });
});
element('create').addEventListener('click', () => { void run(() => join('create')); });
element('join-form').addEventListener('submit', event => {
  event.preventDefault(); void run(() => join('join', element<HTMLInputElement>('code-input').value));
});
element('ready').addEventListener('click', () => {
  if (!room || !state || state.started) return;
  room.send('ready', !state.players.find(p => p.id === player?.id)?.ready);
});
for (let count = 1; count <= MAX_ROUNDS; count++) {
  const option = document.createElement('option'); option.value = String(count); option.textContent = String(count);
  element('round-count').append(option);
}
element('round-count').addEventListener('change', () => {
  if (room && !busy && !state?.started) room.send('roundCount', Number(element<HTMLSelectElement>('round-count').value));
});
element('dev-finish').addEventListener('click', () => {
  if (room && state?.match && !busy) room.send('minigame', { matchId: state.match.id, roundIndex: state.match.roundIndex, data: { action: 'finish' } });
});
element('leave').addEventListener('click', () => {
  if (!room) return;
  setBusy(true); room.send('leave');
});
element('race-leave').addEventListener('click', () => element('leave').click());
element('copy-code').addEventListener('click', async () => {
  const code = state?.code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    if (state?.code !== code) return;
    element('copy-code').textContent = 'Zkopírováno';
    element('copy-status').textContent = 'Kód lobby byl zkopírován do schránky.';
  } catch {
    error('Kód se nepodařilo zkopírovat. Označte jej a zkopírujte ručně.');
  }
});
const countdownTimer = setInterval(updateCountdown, 200);
window.addEventListener('pagehide', () => { stopRace(); clearTimeout(retryTimer); clearInterval(countdownTimer); });

void run(async () => {
  const me = await api<{ player: Player | null; lobbyCode: string | null }>('/api/me');
  player = me.player;
  if (!player) show('identity');
  else if (me.lobbyCode) await join('resume');
  else show('choices');
  connection();
}).then(() => { connection(); if (element('identity').hidden && element('choices').hidden && element('lobby').hidden) show('identity'); });
