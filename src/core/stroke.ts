// Turns the pointer's raw points into the compact stroke that is stored,
// shared and sounded. Doing this once, when the stroke ends, means the song in
// memory is exactly the song a share link will rebuild.
import { GRID, MAX_POINTS } from "./model.ts";

/** Points closer than this to a straight line (in grid units, about 1/700 of the canvas) are dropped. */
const TOLERANCE = 1.5;

const quantise = (v: number) => Math.min(GRID - 1, Math.max(0, Math.round(v * GRID)));

/**
 * @param raw  x0, y0, x1, y1, ... as fractions of the canvas (0..1)
 * @returns    flat integer grid coordinates, simplified
 */
export function normalizePoints(raw: readonly number[]): number[] {
  const q: number[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const x = quantise(raw[i]);
    const y = quantise(raw[i + 1]);
    const n = q.length;
    if (n >= 2 && q[n - 2] === x && q[n - 1] === y) continue;
    q.push(x, y);
  }
  let eps = TOLERANCE;
  let out = simplify(q, eps);
  while (out.length / 2 > MAX_POINTS) {
    eps *= 1.5;
    out = simplify(q, eps);
  }
  return out;
}

/** Ramer-Douglas-Peucker, iterative so a long scribble can't overflow the stack. */
export function simplify(pts: readonly number[], eps: number): number[] {
  const n = pts.length / 2;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let farDist = eps;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[2 * i], pts[2 * i + 1], pts[2 * a], pts[2 * a + 1], pts[2 * b], pts[2 * b + 1]);
      if (d > farDist) {
        farDist = d;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
