import type { ResultGroup, RoundScore, TotalScore } from '../shared/types.js';

export function scoreRound(participantIds: readonly string[], groups: ResultGroup[], totals: ReadonlyMap<string, number>): RoundScore[] {
  const expected = new Set(participantIds);
  if (!expected.size || expected.size !== participantIds.length || !Array.isArray(groups) || !groups.length) throw new Error('Neplatný seznam výsledků.');
  const seen = new Set<string>();
  const scores: RoundScore[] = [];
  let offset = 0;
  for (const [index, group] of groups.entries()) {
    if (!group || !Array.isArray(group.players) || !group.players.length ||
        (group.unfinished !== undefined && typeof group.unfinished !== 'boolean') ||
        (group.unfinished && index !== groups.length - 1)) throw new Error('Neplatné umístění nebo nedokončivší hráči.');
    const points = participantIds.length - offset - (group.players.length + 1) / 2;
    for (const id of group.players) {
      if (!expected.has(id) || seen.has(id)) throw new Error('Každý účastník musí být ve výsledcích právě jednou.');
      seen.add(id);
      const value = group.values?.[id];
      if (value !== undefined && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Neplatné interní skóre minihry.');
      scores.push({ playerId: id, place: offset + 1, points, total: (totals.get(id) ?? 0) + points, unfinished: !!group.unfinished, ...(value !== undefined ? { value } : {}) });
    }
    offset += group.players.length;
  }
  if (seen.size !== expected.size) throw new Error('Ve výsledcích chybí účastník.');
  return scores;
}

export function rankTotals(totals: ReadonlyMap<string, number>): TotalScore[] {
  const sorted = [...totals].sort((a, b) => b[1] - a[1]);
  let place = 1;
  return sorted.map(([playerId, total], index) => {
    if (index && total !== sorted[index - 1][1]) place = index + 1;
    return { playerId, total, place };
  });
}
