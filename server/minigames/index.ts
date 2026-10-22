import type { MinigameDefinition } from './types.js';

// Add future implemented games here. No placeholder games enter production selection.
export const minigames: MinigameDefinition[] = [];
if (process.env.NODE_ENV === 'development') {
  const { developmentGame } = await import('./development.js');
  minigames.push(developmentGame);
}
