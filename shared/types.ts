export interface Player { id: string; name: string }
export interface LobbyPlayer extends Player { ready: boolean; connected: boolean }
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface MinigameInfo { id: string; name: string; rules: string }
export interface ResultGroup {
  players: string[];
  unfinished?: boolean;
  values?: Record<string, string | number>;
}
export interface RoundScore { playerId: string; place: number; points: number; total: number; unfinished: boolean; value?: string | number }
export interface RoundResult { round: number; minigameId: string; scores: RoundScore[] }
export interface TotalScore { playerId: string; place: number; total: number }
export type MatchPhase = 'rules' | 'countdown' | 'playing' | 'roundResults' | 'finalResults';
export interface MatchState {
  id: string;
  participants: readonly Readonly<Player>[];
  order: readonly Readonly<MinigameInfo>[];
  roundIndex: number;
  phase: MatchPhase;
  phaseEndsAt: number;
  gameData: JsonValue;
  rounds: RoundResult[];
  totals: TotalScore[];
  winnerIds: string[];
}
export interface LobbyState {
  code: string;
  started: boolean;
  adminId: string | null;
  players: LobbyPlayer[];
  roundCount: number;
  match: MatchState | null;
  error: string | null;
  serverTime: number;
}
