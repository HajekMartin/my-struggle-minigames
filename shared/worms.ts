// Pixels, seconds and milliseconds; parameters are shared with the renderer.
import { MINIGAME_CONFIG } from './minigames.config.js';

export const WORMS = MINIGAME_CONFIG.worms;

// Each column contains pairs [top, bottom, top, bottom, ...]. A circular crater
// subtracts an interval from each intersected column, including caves/overhangs.
export interface WormTerrain { columns: number[][]; revision: number }
export interface WormCharacter {
  id: string; name: string; color: number; x: number; y: number; vx: number; vy: number;
  hp: number; stamina: number; grounded: boolean;
  status: 'alive' | 'dead' | 'disconnected'; eliminatedGroup: number | null;
}
export interface WormProjectile { x: number; y: number; vx: number; vy: number; ownerId: string; bornAt: number }
export interface WormExplosion { x: number; y: number; serial: number }
export interface WormSnapshot {
  elapsedMs: number; running: boolean; over: boolean;
  phase: 'waiting' | 'turn' | 'effects' | 'finished';
  order: string[]; activeId: string | null; turnNumber: number; turnEndsAt: number;
  aim: number; chargeStartedAt: number | null; shotUsed: boolean;
  characters: WormCharacter[]; projectile: WormProjectile | null; explosion: WormExplosion | null;
}
export interface WormData { kind: 'worms'; terrain: WormTerrain; snapshot: WormSnapshot }
export type WormInput =
  | { type: 'control'; move: number; jump: boolean; aim: number }
  | { type: 'charge' | 'fire' | 'end' | 'neutral' };
