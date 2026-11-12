import { test } from "node:test";
import assert from "node:assert/strict";
import { LookaheadScheduler, type Due } from "../../src/core/scheduler.ts";

const COLS = 32;
const STEP = 0.125; // 4 second loop

test("steps come out in order, on the grid, exactly once", () => {
  const s = new LookaheadScheduler(COLS);
  s.start(10, 0, STEP);
  const all: Due[] = [];
  // Tick every 25 ms with a 120 ms lookahead for two and a half loops.
  for (let now = 9.9; now < 20; now += 0.025) all.push(...s.tick(now, 0.12));
  assert.ok(all.length >= 80);
  for (let i = 0; i < all.length; i++) {
    assert.equal(all[i].step, i % COLS, `step ${i}`);
    assert.ok(Math.abs(all[i].when - (10 + i * STEP)) < 1e-9, `time of ${i}`);
  }
});

test("nothing is scheduled further ahead than the lookahead", () => {
  const s = new LookaheadScheduler(COLS);
  s.start(0, 0, STEP);
  for (let now = 0; now < 6; now += 0.025) {
    for (const d of s.tick(now, 0.12)) assert.ok(d.when < now + 0.12 + 1e-9);
  }
});

test("a late tick catches up without dropping or doubling steps", () => {
  const s = new LookaheadScheduler(COLS);
  s.start(0, 0, STEP);
  const got = [...s.tick(0, 0.12), ...s.tick(1.0, 0.12)]; // main thread stalled for a second
  assert.deepEqual(got.map((d) => d.step), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test("starting mid-loop resumes at the next step and keeps the position", () => {
  const s = new LookaheadScheduler(COLS);
  s.start(5, 0.5, STEP); // half way round, 16 steps in
  const first = s.tick(5, 0.12);
  assert.equal(first[0].step, 16);
  assert.ok(Math.abs(first[0].when - 5) < 1e-9);
  assert.ok(Math.abs(s.position(5) - 0.5) < 1e-9);
  assert.ok(Math.abs(s.position(5 + 1) - (0.5 + 1 / 4)) < 1e-9);
});

test("resuming between steps waits for the next step instead of replaying one", () => {
  const s = new LookaheadScheduler(COLS);
  s.start(5, 0.5 + 0.4 / COLS, STEP); // 0.4 of the way into step 16
  const first = s.tick(5, 0.5);
  assert.equal(first[0].step, 17);
  assert.ok(first[0].when > 5);
});

test("position wraps around the loop and is held before the start time", () => {
  const s = new LookaheadScheduler(COLS);
  s.start(2, 0, STEP);
  assert.equal(s.position(1.9), 0);
  assert.ok(Math.abs(s.position(2 + 4) - 0) < 1e-9 || Math.abs(s.position(2 + 4) - 1) < 1e-9);
  assert.ok(Math.abs(s.position(2 + 5) - 0.25) < 1e-9);
});

test("changing tempo keeps the playhead where it is", () => {
  const s = new LookaheadScheduler(COLS);
  s.start(0, 0, STEP);
  const emitted: Due[] = [];
  let now = 0;
  for (; now < 1.0; now += 0.025) emitted.push(...s.tick(now, 0.12));
  const before = s.position(now); // about a quarter of the way round
  s.setStepSeconds(now, 0.25); // now an 8 second loop
  assert.ok(Math.abs(s.position(now) - before) < 1e-9);
  assert.ok(Math.abs(s.position(now + 2) - (before + 0.25)) < 1e-9);
  // The step already scheduled before the change is not scheduled again.
  const next = s.tick(now, 0.5);
  assert.ok(next.length > 0);
  assert.equal(next[0].step, emitted[emitted.length - 1].step + 1);
  for (const d of next) assert.ok(d.when >= now - 1e-9);
});

test("the playhead fraction after a pause is what start() gets back", () => {
  const s = new LookaheadScheduler(COLS);
  s.start(0, 0, STEP);
  const p = s.position(1.7);
  const t = new LookaheadScheduler(COLS);
  t.start(50, p, STEP);
  assert.ok(Math.abs(t.position(50) - p) < 1e-9);
});
