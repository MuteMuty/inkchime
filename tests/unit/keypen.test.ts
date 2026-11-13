import { test } from "node:test";
import assert from "node:assert/strict";
import { CURSOR_START, cursorStroke, describeCursor, describeNote, moveCursor, noteName, type Cursor } from "../../src/core/keypen.ts";
import { songToNotes, strokeToNotes } from "../../src/core/notes.ts";
import { degreeToMidi, sizeToGain } from "../../src/core/pitch.ts";
import { songFromHash, songToHash } from "../../src/core/share.ts";
import { COLS, GRID, ROWS, VOICE_COUNT } from "../../src/core/model.ts";

const at = (col: number, row: number): Cursor => ({ col, row });

// --- the cursor ------------------------------------------------------------------

test("the cursor starts in the first column, on the middle row", () => {
  assert.deepEqual(CURSOR_START, at(0, 7));
});

test("arrow keys move the cursor one cell; up is higher on the canvas", () => {
  assert.deepEqual(moveCursor(at(5, 7), "ArrowRight"), at(6, 7));
  assert.deepEqual(moveCursor(at(5, 7), "ArrowLeft"), at(4, 7));
  assert.deepEqual(moveCursor(at(5, 7), "ArrowUp"), at(5, 6));
  assert.deepEqual(moveCursor(at(5, 7), "ArrowDown"), at(5, 8));
});

test("the cursor is clamped at every edge of the 32 by 15 grid", () => {
  assert.deepEqual(moveCursor(at(0, 7), "ArrowLeft"), at(0, 7));
  assert.deepEqual(moveCursor(at(COLS - 1, 7), "ArrowRight"), at(COLS - 1, 7));
  assert.deepEqual(moveCursor(at(3, 0), "ArrowUp"), at(3, 0));
  assert.deepEqual(moveCursor(at(3, ROWS - 1), "ArrowDown"), at(3, ROWS - 1));
});

test("other keys don't move the cursor", () => {
  for (const key of ["Enter", "n", " ", "Tab", "a", "Home"]) assert.equal(moveCursor(at(5, 7), key), null, key);
});

// --- cursor to note ----------------------------------------------------------------

test("a placed note is exactly one note, in the cursor's column and row, for every cell", () => {
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const notes = strokeToNotes(cursorStroke(at(col, row), 2, 5));
      assert.equal(notes.length, 1, `cell ${col},${row} gave ${notes.length} notes`);
      const degree = ROWS - 1 - row;
      assert.deepEqual(notes[0], { step: col, degree, midi: degreeToMidi(degree), gain: sizeToGain(5), voice: 2 });
    }
  }
});

test("a placed note uses the current colour and brush size, and stays on the grid", () => {
  for (let color = 0; color < VOICE_COUNT; color++) {
    for (const size of [1, 4, 8]) {
      const s = cursorStroke(at(31, 0), color, size);
      assert.equal(s.color, color);
      assert.equal(s.size, size);
      assert.ok(s.pts.every((v) => Number.isInteger(v) && v >= 0 && v < GRID), `points ${s.pts}`);
    }
  }
});

test("a placed note is a short dash, not a dot, so it can be seen", () => {
  const { pts } = cursorStroke(at(10, 4), 0, 4);
  assert.equal(pts.length, 4);
  assert.equal(pts[1], pts[3], "flat");
  assert.ok(pts[2] - pts[0] >= 12, "visible length");
});

test("a placed note survives a share link unchanged", () => {
  const song = { bpm: 100, strokes: [cursorStroke(at(4, 7), 0, 4), cursorStroke(at(31, 14), 3, 8), cursorStroke(at(0, 0), 1, 1)] };
  const back = songFromHash(songToHash(song));
  assert.deepEqual(back, song);
  assert.deepEqual(songToNotes(back!), songToNotes(song));
});

// --- what is announced ---------------------------------------------------------------

test("note names follow MIDI, with middle C as C4", () => {
  assert.equal(noteName(48), "C3");
  assert.equal(noteName(60), "C4");
  assert.equal(noteName(64), "E4");
  assert.equal(noteName(81), "A5");
});

test("placing announces voice, column (counted from 1) and pitch", () => {
  assert.equal(describeNote(at(4, 7), 0), "Bell, column 5, pitch E4");
  assert.equal(describeNote(at(0, 14), 3), "Tap, column 1, pitch C3");
  assert.equal(describeNote(at(31, 0), 2), "Pad, column 32, pitch A5");
});

test("moving announces where the cursor is", () => {
  assert.equal(describeCursor(at(4, 7)), "Column 5, pitch E4");
});
