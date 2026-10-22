import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Player } from '../shared/types.js';

const file = resolve(process.env.SQLITE_PATH || './data/lobby.sqlite');
mkdirSync(dirname(file), { recursive: true });
export const db = new DatabaseSync(file);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    lobby_code TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER NOT NULL,
    participants_json TEXT NOT NULL,
    minigames_json TEXT NOT NULL,
    rounds_json TEXT NOT NULL,
    scores_json TEXT NOT NULL
  );
`);
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
export interface Session extends Player { tokenHash: string; expiresAt: number }
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function findSession(cookie?: string): Session | undefined {
  const token = cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('session='))?.slice(8);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
  return db.prepare(`SELECT players.id, players.name, sessions.token_hash AS tokenHash,
    sessions.expires_at AS expiresAt FROM sessions JOIN players ON players.id = sessions.player_id
    WHERE token_hash = ? AND expires_at > ?`).get(hash(token), Date.now()) as Session | undefined;
}

export function sessionValid(session: Session): boolean {
  return !!db.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?').get(session.tokenHash, Date.now());
}

export function createPlayer(rawName: unknown): { player: Player; cookie: string } {
  if (typeof rawName !== 'string') throw new Error('Zadejte jméno o délce 1–20 znaků.');
  const name = rawName.trim();
  if ([...name].length < 1 || [...name].length > 20) throw new Error('Jméno musí mít 1–20 znaků.');
  const player = { id: randomUUID(), name };
  const token = randomBytes(32).toString('hex');
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO players (id, name) VALUES (?, ?)').run(player.id, name);
    db.prepare('INSERT INTO sessions (token_hash, player_id, expires_at) VALUES (?, ?, ?)')
      .run(hash(token), player.id, Date.now() + 24 * 60 * 60 * 1000);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { player, cookie: `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` };
}

export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // Non-browser clients still need the session cookie.
  try { return new URL(origin).host === host; } catch { return false; }
}
