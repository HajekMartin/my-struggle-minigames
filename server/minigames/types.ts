import type { JsonValue, MinigameInfo, Player, ResultGroup } from '../../shared/types.js';

export interface MinigameContext {
  readonly participants: readonly Readonly<Player>[];
  isConnected(playerId: string): boolean;
  isAdmin(playerId: string): boolean;
  publish(data: JsonValue): void;
  // Shallow public-state update, sent separately from the lobby (e.g. realtime snapshots).
  update(data: { [key: string]: JsonValue }): void;
  complete(): void;
}

export interface RunningMinigame {
  prepare?(): void;
  start(): void;
  onDisconnect?(playerId: string): void;
  onMessage?(playerId: string, message: JsonValue): void;
  // Always evaluate every participant, including disconnected and unfinished players.
  finish(): ResultGroup[];
  // Release all game-owned timers, listeners and other resources, even after errors.
  dispose(): void;
}

export interface MinigameDefinition extends MinigameInfo {
  timeLimitMs: number;
  create(context: MinigameContext): RunningMinigame;
}
