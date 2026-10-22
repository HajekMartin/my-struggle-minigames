import type { MinigameDefinition } from './types.js';
import { raceGame } from './race/index.js';

// Add future implemented games here. No placeholder games enter production selection.
export const minigames: MinigameDefinition[] = [raceGame];
// Opt in only for automated regression tests; normal development also plays real games.
if (process.env.NODE_ENV === 'development' && process.env.MINIGAME_TEST_ONLY === '1') {
  const { developmentGame } = await import('./development.js');
  minigames.splice(0, minigames.length, developmentGame);
}
