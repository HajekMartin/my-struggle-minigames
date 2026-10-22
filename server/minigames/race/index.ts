import type { JsonValue } from '../../../shared/types.js';
import { RACE } from '../../../shared/race.js';
import type { MinigameDefinition } from '../types.js';
import { generateTrack } from './track.js';
import { RaceSimulation } from './simulation.js';

export const raceGame: MinigameDefinition = {
  id: 'car-race',
  name: 'Závod aut',
  rules: 'WASD / šipky: plyn, brzda a zatáčení. Jeden průjezd od STARTU do CÍLE přes všechny checkpointy. R: návrat za bezpečný checkpoint a 2 s bez ovládání. Odpojení znamená vyloučení z tohoto závodu; po návratu pouze sledujete. Limit 5 minut.',
  timeLimitMs: RACE.limitSeconds * 1000,
  create(context) {
    const simulation = new RaceSimulation(generateTrack(), context.participants);
    let interval: NodeJS.Timeout | undefined;
    let previous = 0, accumulator = 0, publishAccumulator = 0;
    let stopped = false;
    let completionRequested = false;
    const complete = () => {
      if (completionRequested) return;
      completionRequested = true; clearInterval(interval); context.complete();
    };
    const publish = () => context.update({ snapshot: simulation.snapshot() as unknown as JsonValue });
    const disconnected = (id: string) => {
      simulation.exclude(id);
      publish();
      if (simulation.running && simulation.over) complete();
    };
    return {
      prepare() { context.publish({ kind: 'car-race', track: simulation.track, snapshot: simulation.snapshot() } as unknown as JsonValue); },
      start() {
        simulation.start();
        for (const participant of context.participants) if (!context.isConnected(participant.id)) simulation.exclude(participant.id);
        publish();
        if (simulation.over) { complete(); return; }
        previous = performance.now();
        interval = setInterval(() => {
          if (stopped) return;
          const now = performance.now();
          accumulator += Math.min((now - previous) / 1000, .25); previous = now;
          for (const participant of context.participants) if (!context.isConnected(participant.id)) simulation.exclude(participant.id);
          while (accumulator >= 1 / RACE.physicsHz) {
            simulation.step(); accumulator -= 1 / RACE.physicsHz; publishAccumulator++;
          }
          if (publishAccumulator >= RACE.physicsHz / RACE.snapshotHz) { publishAccumulator = 0; publish(); }
          if (simulation.over) complete();
        }, 1000 / RACE.physicsHz);
      },
      onMessage(id, message) { simulation.acceptInput(id, message); },
      onDisconnect: disconnected,
      finish() {
        stopped = true; clearInterval(interval);
        for (const participant of context.participants) if (!context.isConnected(participant.id)) simulation.exclude(participant.id);
        return simulation.results();
      },
      dispose() { stopped = true; clearInterval(interval); simulation.dispose(); }
    };
  }
};
