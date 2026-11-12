import { test } from "node:test";
import assert from "node:assert/strict";
import { strokeToNotes, songToNotes, notesByStep } from "../../src/core/notes.ts";
import { degreeToMidi, gridYToDegree, sizeToGain } from "../../src/core/pitch.ts";
import { COLS, GRID, type Song, type Stroke } from "../../src/core/model.ts";

const line = (x0: number, x1: number, y: number, color = 0, size = 4): Stroke => ({ color, size, pts: [x0, y, x1, y] });

test("a flat line sounds the same pitch in every column it crosses", () => {
  // x 256..511 is columns 8..15
  const notes = strokeToNotes(line(256, 511, 512));
  assert.deepEqual(notes.map((n) => n.step), [8, 9, 10, 11, 12, 13, 14, 15]);
  const degree = gridYToDegree(512);
  for (const n of notes) {
    assert.equal(n.degree, degree);
    assert.equal(n.midi, degreeToMidi(degree));
  }
});

test("pitch comes from height: higher on the canvas is higher in pitch", () => {
  const high = strokeToNotes(line(0, 100, 50))[0];
  const low = strokeToNotes(line(0, 100, 950))[0];
  assert.ok(high.midi > low.midi);
});

test("gain comes from thickness, voice from colour", () => {
  const thin = strokeToNotes(line(0, 100, 500, 1, 1))[0];
  const thick = strokeToNotes(line(0, 100, 500, 3, 8))[0];
  assert.equal(thin.gain, sizeToGain(1));
  assert.equal(thick.gain, sizeToGain(8));
  assert.equal(thin.voice, 1);
  assert.equal(thick.voice, 3);
  assert.ok(thick.gain > thin.gain);
});

test("a rising line climbs through the scale as the playhead moves right", () => {
  const stroke: Stroke = { color: 0, size: 4, pts: [0, GRID - 1, GRID - 1, 0] };
  const notes = strokeToNotes(stroke);
  const lowestPerStep = new Map<number, number>();
  for (const n of notes) lowestPerStep.set(n.step, Math.min(lowestPerStep.get(n.step) ?? 99, n.degree));
  const steps = [...lowestPerStep.keys()].sort((a, b) => a - b);
  assert.equal(steps.length, COLS);
  for (let i = 1; i < steps.length; i++) assert.ok(lowestPerStep.get(steps[i])! >= lowestPerStep.get(steps[i - 1])!);
});

test("a vertical stroke is one column and plays at most three notes: low, middle, high", () => {
  const stroke: Stroke = { color: 0, size: 4, pts: [300, 0, 300, GRID - 1] };
  const notes = strokeToNotes(stroke);
  assert.equal(notes.length, 3);
  assert.ok(notes.every((n) => n.step === notes[0].step));
  const degrees = notes.map((n) => n.degree);
  assert.equal(Math.min(...degrees), 0);
  assert.equal(Math.max(...degrees), 14);
});

test("a tap is one note", () => {
  const notes = strokeToNotes({ color: 2, size: 4, pts: [700, 300] });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].step, 21);
});

test("a stroke that doubles back does not repeat a note", () => {
  const notes = strokeToNotes({ color: 0, size: 4, pts: [0, 500, 200, 500, 0, 500] });
  const keys = notes.map((n) => `${n.step}:${n.midi}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("songToNotes merges strokes, keeps colours apart and the loudest of duplicates", () => {
  const song: Song = {
    bpm: 90,
    strokes: [line(0, 31, 500, 0, 2), line(0, 31, 500, 0, 7), line(0, 31, 500, 1, 4)],
  };
  const notes = songToNotes(song);
  const bell = notes.filter((n) => n.voice === 0);
  const pluck = notes.filter((n) => n.voice === 1);
  assert.equal(bell.length, 1);
  assert.equal(bell[0].gain, sizeToGain(7));
  assert.equal(pluck.length, 1);
});

test("the schedule is sorted and repeatable", () => {
  const song: Song = { bpm: 100, strokes: [line(600, 900, 100, 2), line(0, 300, 800, 1), { color: 0, size: 3, pts: [400, 100, 400, 900] }] };
  const a = songToNotes(song);
  const b = songToNotes({ ...song, strokes: [...song.strokes] });
  assert.deepEqual(a, b);
  for (let i = 1; i < a.length; i++) assert.ok(a[i - 1].step <= a[i].step);
});

test("notesByStep buckets every note into its column", () => {
  const notes = songToNotes({ bpm: 90, strokes: [line(0, 1023, 500)] });
  const buckets = notesByStep(notes);
  assert.equal(buckets.length, COLS);
  assert.ok(buckets.every((b, i) => b.every((n) => n.step === i) && b.length === 1));
});

test("an empty song has an empty schedule", () => {
  assert.deepEqual(songToNotes({ bpm: 90, strokes: [] }), []);
  assert.equal(notesByStep([]).length, COLS);
});
