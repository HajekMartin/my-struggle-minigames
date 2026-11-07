import type { MinigameDefinition } from './types.js';
import { MINIGAME_CONFIG } from '../../shared/minigames.config.js';
import { raceGame } from './race/index.js';
import { wormsGame } from './worms/index.js';

// Add future implemented games here. No placeholder games enter production selection.
export const minigames: MinigameDefinition[] = [
  ...(MINIGAME_CONFIG['car-race'].enabled ? [raceGame] : []),
  ...(MINIGAME_CONFIG.worms.enabled ? [wormsGame] : []),
];
// Opt in only for automated regression tests; normal development also plays real games.
if (process.env.NODE_ENV === 'development' && process.env.MINIGAME_TEST_ONLY === '1') {
  const { developmentGame } = await import('./development.js');
  minigames.splice(0, minigames.length, developmentGame);
}
