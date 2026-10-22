import { RACE, pointAt, angleDifference, type Point, type RaceTrack } from '../../../shared/race.js';

function assemble(center: Point[], width: number, length: number, fallback: boolean): RaceTrack {
  const distances = [0];
  for (let i = 1; i < center.length; i++) distances.push(distances[i - 1] + Math.hypot(center[i].x - center[i - 1].x, center[i].y - center[i - 1].y));
  const left: Point[] = [], right: Point[] = [];
  for (let i = 0; i < center.length; i++) {
    const p = center[i], prev = center[Math.max(0, i - 1)], next = center[Math.min(center.length - 1, i + 1)];
    const before = i ? Math.atan2(p.y - prev.y, p.x - prev.x) : Math.atan2(next.y - p.y, next.x - p.x);
    const after = i + 1 < center.length ? Math.atan2(next.y - p.y, next.x - p.x) : before;
    const angle = before + angleDifference(after, before) / 2, nx = -Math.sin(angle), ny = Math.cos(angle);
    // The angle bisector must use unit tangents even when neighbouring samples differ in length.
    const segmentAngle = before;
    const half = width / 2 / Math.cos(angleDifference(angle, segmentAngle));
    left.push({ x: center[i].x + nx * half, y: center[i].y + ny * half });
    right.push({ x: center[i].x - nx * half, y: center[i].y - ny * half });
  }
  const track: RaceTrack = { center, left, right, distances, width, length, fallback, checkpoints: [], start: { x: 0, y: 0, angle: 0, distance: 40 }, finish: { x: 0, y: 0, angle: 0, distance: length + 40 } };
  track.start = pointAt(track, 40);
  track.finish = pointAt(track, length + 40);
  for (let s = 40; s < track.finish.distance - 10; s += RACE.checkpointSpacing) track.checkpoints.push(pointAt(track, s));
  return track;
}

function candidate(length: number, width: number, random: () => number, straight = false): RaceTrack {
  const center: Point[] = [{ x: -40, y: 0 }];
  let distance = 0, heading = 0, remaining = 0, curvature = 0;
  const total = length + 60;
  while (distance < total - .001) {
    if (remaining <= .001) {
      if (distance < 100 || total - distance < 150 || straight) { remaining = distance < 100 ? 100 - distance : total - distance; curvature = 0; }
      else if (random() < .45) { remaining = 65 + random() * 95; curvature = 0; }
      else {
        const target = (random() * 2 - 1) * .7;
        const turn = target - heading, radius = 70 + random() * 55;
        remaining = Math.max(18, Math.abs(turn) * radius);
        curvature = turn / remaining;
      }
    }
    const step = Math.min(RACE.sampleLength, remaining, total - distance);
    const mid = heading + curvature * step / 2;
    const previous = center.at(-1)!;
    center.push({ x: previous.x + Math.cos(mid) * step, y: previous.y + Math.sin(mid) * step });
    heading += curvature * step;
    distance += step; remaining -= step;
  }
  return assemble(center, width, length, straight);
}

function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) return false;
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
}

export function validTrack(track: RaceTrack): boolean {
  if (!Number.isFinite(track.width) || track.width < 16 || track.center.length < 3) return false;
  let lastAngle = 0;
  for (let i = 1; i < track.center.length; i++) {
    const a = track.center[i - 1], b = track.center[i];
    const distance = Math.hypot(b.x - a.x, b.y - a.y), angle = Math.atan2(b.y - a.y, b.x - a.x);
    // A monotonic, gently curving corridor cannot double back or cross itself.
    if (!Number.isFinite(distance) || distance < .0001 || b.x <= a.x || Math.abs(angle) > .72 || Math.abs(angleDifference(angle, lastAngle)) > .1) return false;
    lastAngle = angle;
    if (Math.hypot(track.left[i].x - track.right[i].x, track.left[i].y - track.right[i].y) < track.width - .01) return false;
  }
  const polygon = [...track.left, ...[...track.right].reverse()];
  for (let i = 0; i < polygon.length; i++) for (let j = i + 2; j < polygon.length; j++) {
    if (i === 0 && j === polygon.length - 1) continue;
    if (intersects(polygon[i], polygon[(i + 1) % polygon.length], polygon[j], polygon[(j + 1) % polygon.length])) return false;
  }
  return track.distances.at(-1)! >= track.finish.distance + 15 && track.checkpoints.every((gate, i, gates) => !i || gate.distance > gates[i - 1].distance);
}

export function generateTrack(random: () => number = Math.random, attempts: number = RACE.generationAttempts, length: number = RACE.targetSeconds * RACE.cruiseSpeed): RaceTrack {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const track = candidate(length, RACE.roadWidth, random);
    if (validTrack(track)) return track;
  }
  return candidate(length, RACE.roadWidth, () => .5, true);
}
