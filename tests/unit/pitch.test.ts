import { test } from "node:test";
import assert from "node:assert/strict";
import { degreeToMidi, gridYToDegree, gridXToStep, midiToFreq, sizeToGain, loopSeconds, stepSeconds } from "../../src/core/pitch.ts";
import { GRID, ROWS, COLS, SIZE_MIN, SIZE_MAX, BPM_MIN, BPM_MAX } from "../../src/core/model.ts";

test("height maps to degree: top is highest, bottom is lowest", () => {
  assert.equal(gridYToDegree(0), ROWS - 1);
  assert.equal(gridYToDegree(GRID - 1), 0);
});

test("degree never decreases as you move up the canvas", () => {
  let last = -1;
  for (let y = GRID - 1; y >= 0; y--) {
    const d = gridYToDegree(y);
    assert.ok(d >= last, `degree dropped at y=${y}`);
    last = d;
  }
});

test("every row is reachable and equally tall (within one grid unit)", () => {
  const counts = new Array(ROWS).fill(0);
  for (let y = 0; y < GRID; y++) counts[gridYToDegree(y)]++;
  assert.ok(counts.every((c) => c > 0));
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
});

test("out-of-range y is clamped, not extrapolated", () => {
  assert.equal(gridYToDegree(-50), ROWS - 1);
  assert.equal(gridYToDegree(GRID + 50), 0);
});

test("every degree lands on the major pentatonic scale", () => {
  const penta = new Set([0, 2, 4, 7, 9]);
  for (let d = 0; d < ROWS; d++) assert.ok(penta.has(degreeToMidi(d) % 12), `degree ${d} -> midi ${degreeToMidi(d)}`);
});

test("degrees rise strictly in pitch and span three octaves", () => {
  for (let d = 1; d < ROWS; d++) assert.ok(degreeToMidi(d) > degreeToMidi(d - 1));
  assert.equal(degreeToMidi(0), 48); // C3
  assert.equal(degreeToMidi(5), 60); // C4
  assert.equal(degreeToMidi(ROWS - 1), 81); // A5
});

test("midiToFreq is concert pitch", () => {
  assert.equal(midiToFreq(69), 440);
  assert.ok(Math.abs(midiToFreq(60) - 261.6256) < 0.001);
});

test("x maps to a loop column and clamps at the edges", () => {
  assert.equal(gridXToStep(0), 0);
  assert.equal(gridXToStep(GRID - 1), COLS - 1);
  assert.equal(gridXToStep(GRID / 2), COLS / 2);
  assert.equal(gridXToStep(-4), 0);
  assert.equal(gridXToStep(GRID + 4), COLS - 1);
});

test("thicker is louder, always audible, never above 1", () => {
  let last = 0;
  for (let s = SIZE_MIN; s <= SIZE_MAX; s++) {
    const g = sizeToGain(s);
    assert.ok(g > last, `size ${s} should be louder than ${s - 1}`);
    assert.ok(g > 0.05 && g <= 1);
    last = g;
  }
  assert.equal(sizeToGain(SIZE_MAX), 1);
});

test("tempo sets the loop length between 4 and 8 seconds", () => {
  assert.equal(loopSeconds(BPM_MIN), 8);
  assert.equal(loopSeconds(BPM_MAX), 4);
  assert.equal(stepSeconds(BPM_MAX) * COLS, 4);
});
