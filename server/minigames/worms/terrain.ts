import { WORMS as W, type WormTerrain } from '../../../shared/worms.js';

export function generateTerrain(random: () => number = Math.random): WormTerrain {
  const phase = random() * Math.PI * 2, phase2 = random() * Math.PI * 2;
  const columns = Array.from({ length: W.width / W.terrainStep }, (_, i) => {
    const x = i * W.terrainStep;
    const y = 430 + Math.sin(x / 160 + phase) * 43 + Math.sin(x / 77 + phase2) * 16;
    return [Math.round(y), W.height];
  });
  return { columns, revision: 0 };
}

export function solidAt(terrain: WormTerrain, x: number, y: number): boolean {
  const column = terrain.columns[Math.floor(x / W.terrainStep)];
  if (!column) return false;
  for (let i = 0; i < column.length; i += 2) if (y >= column[i] && y <= column[i + 1]) return true;
  return false;
}

export function hitsTerrain(terrain: WormTerrain, x: number, y: number, radius: number): boolean {
  const first = Math.max(0, Math.floor((x - radius) / W.terrainStep));
  const last = Math.min(terrain.columns.length - 1, Math.floor((x + radius) / W.terrainStep));
  for (let index = first; index <= last; index++) {
    const dx = Math.max(index * W.terrainStep - x, 0, x - (index + 1) * W.terrainStep);
    const column = terrain.columns[index];
    for (let i = 0; i < column.length; i += 2) {
      const dy = Math.max(column[i] - y, 0, y - column[i + 1]);
      if (dx * dx + dy * dy < radius * radius) return true;
    }
  }
  return false;
}

export function crater(terrain: WormTerrain, x: number, y: number, radius: number) {
  for (let index = 0; index < terrain.columns.length; index++) {
    const dx = (index + .5) * W.terrainStep - x;
    if (Math.abs(dx) >= radius) continue;
    const height = Math.sqrt(radius * radius - dx * dx), top = y - height, bottom = y + height;
    const next: number[] = [], column = terrain.columns[index];
    for (let i = 0; i < column.length; i += 2) {
      const a = column[i], b = column[i + 1];
      if (bottom <= a || top >= b) next.push(a, b);
      else { if (top > a) next.push(a, top); if (bottom < b) next.push(bottom, b); }
    }
    terrain.columns[index] = next;
  }
  terrain.revision++;
}
