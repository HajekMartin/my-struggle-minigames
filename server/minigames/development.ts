import type { ResultGroup } from '../../shared/types.js';
import type { MinigameDefinition } from './types.js';

// Only imported by the registry in development. No player-supplied ranks in real games.
export const developmentGame: MinigameDefinition = {
  id: 'development-test',
  name: 'Testovací minihra',
  rules: 'Vývojový test: první dva připojení hráči sdílejí první místo, ostatní následují podle vstupu do zápasu. Odpojení hráči nedokončí. Správce může test ukončit dříve.',
  timeLimitMs: 5_000,
  create(context) {
    let predetermined: ResultGroup[] | undefined;
    return {
      start() { context.publish({ message: 'Čekáme na vyhodnocení testu.' }); },
      onMessage(playerId, message) {
        if (!context.isAdmin(playerId) || !message || typeof message !== 'object' || Array.isArray(message)) return;
        if (message.action !== 'finish') return;
        if (message.groups !== undefined) {
          // The common scorer validates even development results before awarding any points.
          predetermined = message.groups as unknown as ResultGroup[];
        }
        context.complete();
      },
      finish() {
        if (predetermined) return predetermined;
        const connected = context.participants.filter(p => context.isConnected(p.id)).map(p => p.id);
        const disconnected = context.participants.filter(p => !context.isConnected(p.id)).map(p => p.id);
        const groups: ResultGroup[] = [];
        if (connected.length) groups.push({ players: connected.slice(0, 2), values: Object.fromEntries(connected.slice(0, 2).map(id => [id, 'Testovací remíza'])) });
        for (const id of connected.slice(2)) groups.push({ players: [id] });
        if (disconnected.length) groups.push({ players: disconnected, unfinished: true });
        return groups;
      },
      dispose() { predetermined = undefined; }
    };
  }
};
