import type { JsonValue, MinigameInfo, Player, ResultGroup } from '../../shared/types.js';

export interface MinigameContext {
  readonly participants: readonly Readonly<Player>[];
  isConnected(playerId: string): boolean;
  isAdmin(playerId: string): boolean;
  publish(data: JsonValue): void;
  complete(): void;
}

export interface RunningMinigame {
  start(): void;
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
