import { db } from './auth.js';
import type { MatchState } from '../shared/types.js';

export function saveMatch(code: string, startedAt: number, state: MatchState) {
  db.prepare(`INSERT INTO matches (id, lobby_code, started_at, completed_at, participants_json, minigames_json, rounds_json, scores_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(state.id, code, startedAt, Date.now(),
    JSON.stringify(state.participants), JSON.stringify(state.order), JSON.stringify(state.rounds), JSON.stringify(state.totals));
}
