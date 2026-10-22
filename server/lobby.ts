import { randomBytes, randomInt } from 'node:crypto';
import { Room, ServerError, type Client, type AuthContext } from '@colyseus/core';
import { findSession, sameOrigin, sessionValid, type Session } from './auth.js';
import type { JsonValue, LobbyPlayer, LobbyState } from '../shared/types.js';
import { DEFAULT_ROUNDS, MAX_ROUNDS } from '../shared/config.js';
import { Match, selectMinigames } from './match.js';
import { minigames } from './minigames/index.js';
import { saveMatch } from './history.js';

export const roomsByCode = new Map<string, LobbyRoom>();
export const roomByPlayer = new Map<string, LobbyRoom>();
// Only our HTTP API can create rooms, including when public matchmaking is called directly.
export const creationKey = randomBytes(32).toString('hex');
interface Member { player: LobbyPlayer; client?: Client; session: Session; timeout?: NodeJS.Timeout; expiry: NodeJS.Timeout }

export class LobbyRoom extends Room {
  code = '';
  started = false;
  roundCount = DEFAULT_ROUNDS;
  private match?: Match;
  private matchError: string | null = null;
  adminId: string | null = null;
  members = new Map<string, Member>();
  private emptyTimeout?: NodeJS.Timeout;

  onCreate(options: { creationKey?: string; adminId?: string }) {
    if (options.creationKey !== creationKey) throw new ServerError(403, 'Lobby vytvářejte tlačítkem Vytvořit lobby.');
    this.adminId = options.adminId ?? null;
    this.autoDispose = false;
    // The eight-player limit counts identities, including disconnected members.
    // A replacement socket must be allowed even when all eight seats are occupied.
    this.maxClients = Infinity;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do { this.code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); }
    while (roomsByCode.has(this.code));
    roomsByCode.set(this.code, this);
    void this.setPrivate(true);
    this.emptyTimeout = setTimeout(() => { if (!this.members.size) void this.disconnect(); }, 15_000);
    this.onMessage('sync', () => this.publish());
    this.onMessage('roundCount', (client, value: unknown) => {
      const member = this.ownMember(client);
      if (!member || !sessionValid(member.session)) return;
      if (member.player.id !== this.adminId) { client.send('error', 'Počet kol může změnit pouze správce lobby.'); return; }
      if (this.started || typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_ROUNDS) {
        client.send('error', `Počet kol musí být celé číslo od 1 do ${MAX_ROUNDS} a lze ho změnit jen v lobby.`);
        return;
      }
      if (value === this.roundCount) return;
      this.roundCount = value;
      this.matchError = null;
      this.resetReady();
      this.publish();
    });
    this.onMessage('minigame', (client, payload: unknown) => {
      const member = this.ownMember(client);
      if (!member || !sessionValid(member.session) || !payload || typeof payload !== 'object') return;
      const message = payload as { matchId?: string; roundIndex?: number; data?: JsonValue };
      // Reject late packets from earlier rounds and earlier matches in the same room.
      const match = this.match;
      if (!match || message.matchId !== match.state.id || message.roundIndex === undefined || message.data === undefined) return;
      match.message(member.player.id, message.roundIndex, message.data);
    });
    this.onMessage('ready', (client, value: unknown) => {
      const member = this.ownMember(client);
      if (!member || !sessionValid(member.session) || this.started || typeof value !== 'boolean') return;
      member.player.ready = value;
      if (this.members.size >= 2 && [...this.members.values()].every(m => m.player.connected && m.player.ready && sessionValid(m.session))) {
        this.startMatch();
      }
      this.publish();
    });
    this.onMessage('leave', client => {
      const member = this.ownMember(client);
      if (!member) return;
      this.remove(member.player.id);
      void client.leave(4000);
    });
    this.onMessage('kick', (client, targetId: unknown) => {
      const admin = this.ownMember(client);
      if (!admin || !sessionValid(admin.session) || admin.player.id !== this.adminId) {
        client.send('error', 'Hráče může vyhodit pouze správce lobby.');
        return;
      }
      if (typeof targetId !== 'string' || targetId === admin.player.id) return;
      const target = this.members.get(targetId);
      if (!target) return;
      this.remove(targetId);
      // Remove membership first so a late close event cannot reserve a reconnect seat.
      void target.client?.leave(4004);
    });
  }

  private startMatch() {
    try {
      const order = selectMinigames(minigames, this.roundCount);
      this.matchError = null;
      this.match = new Match([...this.members.values()].map(m => ({ id: m.player.id, name: m.player.name })), order, {
        isConnected: id => {
          const member = this.members.get(id);
          return !!member?.player.connected && sessionValid(member.session);
        },
        isAdmin: id => id === this.adminId,
        changed: () => this.publish(),
        error: message => { this.matchError = message; },
        completed: state => {
          try { saveMatch(this.code, this.match!.startedAt, state); }
          catch (error) {
            console.error('Uložení zápasu selhalo:', error);
            this.matchError = 'Výsledky zápasu se nepodařilo uložit do databáze.';
            this.publish();
          }
        },
        returned: () => {
          this.match = undefined;
          this.started = false;
          this.resetReady();
          this.publish();
          if (!this.members.size) { roomsByCode.delete(this.code); void this.disconnect(); }
        }
      });
      this.started = true;
      this.resetReady();
      this.match.start();
    } catch (error) {
      this.match?.dispose();
      this.match = undefined;
      this.started = false;
      this.matchError = (error as Error).message;
      this.resetReady();
    }
  }

  onAuth(_client: Client, _options: unknown, context: AuthContext) {
    if (!sameOrigin(context.headers.get('origin') ?? undefined, context.headers.get('host') ?? undefined)) {
      throw new ServerError(403, 'Připojení z jiné stránky není povoleno.');
    }
    const session = findSession(context.headers.get('cookie') ?? undefined);
    if (!session) throw new ServerError(401, 'Platnost přihlášení vypršela. Obnovte stránku.');
    this.checkJoin(session.id);
    return session;
  }

  checkJoin(id: string) {
    const existing = roomByPlayer.get(id);
    if (existing && existing !== this) throw new ServerError(409, 'Už jste v jiné lobby. Nejdříve ji opusťte.');
    if (this.members.has(id)) return;
    if (this.started) throw new ServerError(409, 'Hra už byla spuštěna.');
    if (this.members.size >= 8) throw new ServerError(409, 'Lobby je plná (maximálně 8 hráčů).');
  }

  onJoin(client: Client) {
    const session = client.auth as Session;
    // Repeat after asynchronous authentication: simultaneous joins must not bypass limits.
    this.checkJoin(session.id);
    clearTimeout(this.emptyTimeout);
    let member = this.members.get(session.id);
    if (member) {
      const oldClient = member.client;
      clearTimeout(member.timeout);
      member.client = client;
      member.player.connected = true;
      member.player.ready = false;
      if (oldClient && oldClient !== client) void oldClient.leave(4001);
    } else {
      member = {
        player: { id: session.id, name: session.name, ready: false, connected: true },
        session, client,
        expiry: setTimeout(() => {
          const current = this.members.get(session.id);
          this.remove(session.id);
          void current?.client?.leave(4002);
        }, Math.max(0, session.expiresAt - Date.now()))
      };
      this.members.set(session.id, member);
      roomByPlayer.set(session.id, this);
      this.resetReady();
    }
    this.publish();
  }

  onLeave(client: Client) {
    const member = this.ownMember(client);
    if (!member) return;
    member.client = undefined;
    member.player.connected = false;
    member.player.ready = false;
    member.timeout = setTimeout(() => this.remove(member.player.id), 30_000);
    this.publish();
  }

  private ownMember(client: Client) {
    const member = this.members.get((client.auth as Session | undefined)?.id ?? '');
    return member?.client === client ? member : undefined;
  }

  remove(id: string) {
    const member = this.members.get(id);
    if (!member) return;
    clearTimeout(member.timeout);
    clearTimeout(member.expiry);
    this.members.delete(id);
    roomByPlayer.delete(id);
    if (this.adminId === id) this.adminId = this.members.keys().next().value ?? null;
    this.resetReady();
    this.publish();
    if (!this.members.size && !this.match) {
      roomsByCode.delete(this.code);
      void this.disconnect();
    }
  }

  private resetReady() { for (const member of this.members.values()) member.player.ready = false; }
  private publish() {
    const state: LobbyState = {
      code: this.code, started: this.started, adminId: this.adminId,
      players: [...this.members.values()].map(m => m.player), roundCount: this.roundCount,
      match: this.match?.state ?? null, error: this.matchError, serverTime: Date.now()
    };
    this.broadcast('lobby', state);
  }

  onDispose() {
    this.match?.dispose();
    clearTimeout(this.emptyTimeout);
    roomsByCode.delete(this.code);
    for (const [id, member] of this.members) {
      clearTimeout(member.timeout);
      clearTimeout(member.expiry);
      if (roomByPlayer.get(id) === this) roomByPlayer.delete(id);
    }
  }
}
