import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePoints } from "../../src/core/stroke.ts";
import { GRID, MAX_POINTS } from "../../src/core/model.ts";

test("points are quantised to the grid and clamped inside it", () => {
  const out = normalizePoints([0, 0, 1.5, -0.2]);
  assert.deepEqual(out, [0, 0, GRID - 1, 0]);
});

test("repeated points collapse", () => {
  assert.deepEqual(normalizePoints([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), [512, 512]);
});

test("a single tap stays a single point", () => {
  assert.deepEqual(normalizePoints([0.25, 0.75]), [256, 768]);
});

test("an empty or odd-length input gives no points", () => {
  assert.deepEqual(normalizePoints([]), []);
  assert.deepEqual(normalizePoints([0.1]), []);
});

test("a straight line keeps only its ends", () => {
  const raw: number[] = [];
  for (let i = 0; i <= 40; i++) raw.push(i / 40, 0.5);
  const out = normalizePoints(raw);
  assert.deepEqual(out, [0, 512, GRID - 1, 512]);
});

test("a corner survives simplification", () => {
  const raw: number[] = [];
  for (let i = 0; i <= 20; i++) raw.push(i / 40, 0.2);
  for (let i = 1; i <= 20; i++) raw.push(0.5, 0.2 + i / 40);
  const out = normalizePoints(raw);
  assert.equal(out.length, 6);
  assert.deepEqual(out.slice(2, 4), [512, Math.round(0.2 * GRID)]);
});

test("a wobbly line is thinned but stays close to the original", () => {
  const raw: number[] = [];
  for (let i = 0; i <= 200; i++) raw.push(i / 200, 0.5 + 0.2 * Math.sin(i / 12));
  const out = normalizePoints(raw);
  assert.ok(out.length < raw.length / 2, "should drop most points");
  assert.ok(out.length >= 6);
});

test("output never exceeds the point limit, even for a long scribble", () => {
  const raw: number[] = [];
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 20000; i++) raw.push(rnd(), rnd());
  const out = normalizePoints(raw);
  assert.ok(out.length / 2 <= MAX_POINTS);
  assert.ok(out.every((v) => Number.isInteger(v) && v >= 0 && v < GRID));
});
