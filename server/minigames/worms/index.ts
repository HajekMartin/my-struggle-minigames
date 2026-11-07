import type { JsonValue } from '../../../shared/types.js';
import { WORMS as W } from '../../../shared/worms.js';
import type { MinigameDefinition } from '../types.js';
import { WormSimulation } from './simulation.js';

export const wormsGame: MinigameDefinition = {
  id: 'worms', name: 'Bazukový souboj',
  rules: 'Poslední přeživší vyhrává. A/D nebo šipky: pohyb, mezerník: skok. Pohyb a skoky spotřebují staminu. Myší miřte, podržením levého tlačítka nabijte sílu a uvolněním vystřelte. Jeden výstřel za tah, nejvýše 25 sekund. Výbuchy ničí terén a zraňují i střelce. Voda a odpojení vyřazují. Limit 5 minut, poté rozhodují životy.',
  // The game stops opening turns at exactly five minutes. The shared engine's
  // safety timer leaves room only for resolving the final shot and its aftermath.
  timeLimitMs: W.matchMs + W.effectsMs + 1000,
  create(context) {
    const sim = new WormSimulation(context.participants);
    let interval: NodeJS.Timeout | undefined, previous = 0, accumulator = 0, ticks = 0;
    let completed = false, stopped = false, revision = -1;
    const publish = () => {
      const patch: Record<string, JsonValue> = { snapshot: sim.snapshot() as unknown as JsonValue };
      if (revision !== sim.terrain.revision) { patch.terrain = sim.terrain as unknown as JsonValue; revision = sim.terrain.revision; }
      context.update(patch);
    };
    const checkComplete = () => {
      if (!sim.over || completed) return;
      completed = true; clearInterval(interval); publish(); context.complete();
    };
    return {
      prepare() { revision = sim.terrain.revision; context.publish({ kind: 'worms', terrain: sim.terrain, snapshot: sim.snapshot() } as unknown as JsonValue); },
      start() {
        for (const p of context.participants) if (!context.isConnected(p.id)) sim.disconnect(p.id);
        sim.start(); publish(); checkComplete();
        if (completed) return;
        previous = performance.now();
        interval = setInterval(() => {
          if (stopped) return;
          const now = performance.now(); accumulator += Math.min((now - previous) / 1000, .25); previous = now;
          for (const p of context.participants) if (!context.isConnected(p.id)) sim.disconnect(p.id);
          while (accumulator >= 1 / W.physicsHz && !sim.over) { sim.step(); accumulator -= 1 / W.physicsHz; ticks++; }
          if (ticks >= W.physicsHz / W.snapshotHz) { ticks = 0; publish(); }
          checkComplete();
        }, 1000 / W.physicsHz);
      },
      onMessage(id, message) { sim.input(id, message); },
      onDisconnect(id) { sim.disconnect(id); publish(); checkComplete(); },
      finish() { stopped = true; clearInterval(interval); return sim.results(); },
      dispose() { stopped = true; clearInterval(interval); sim.dispose(); }
    };
  }
};
