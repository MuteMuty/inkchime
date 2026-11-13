// Drawing with the keyboard: arrow keys move a cursor over the grid of columns
// (time) and rows (pitch), and Enter or N places a short note in that cell.
// The note is an ordinary stroke, so undo, Share and the live link treat it like
// any line drawn by hand. Pure functions only.
import { COLS, GRID, ROWS, VOICE_NAMES, type Stroke } from "./model.ts";
import { degreeToMidi } from "./pitch.ts";

/** A cell of the grid. `col` is 0..COLS-1 from the left, `row` is 0..ROWS-1 from the top (the highest pitch). */
export interface Cursor {
  readonly col: number;
  readonly row: number;
}

/** Where the playhead starts, on the middle row. */
export const CURSOR_START: Cursor = { col: 0, row: (ROWS - 1) >> 1 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const MOVES: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** The cursor after an arrow key, clamped to the grid. Null for any other key. */
export function moveCursor(c: Cursor, key: string): Cursor | null {
  const move = MOVES[key];
  if (!move) return null;
  return { col: clamp(c.col + move[0], 0, COLS - 1), row: clamp(c.row + move[1], 0, ROWS - 1) };
}

/** A short flat dash across the middle of the cell: exactly one note, in this column at this row's pitch. */
export function cursorStroke(c: Cursor, color: number, size: number): Stroke {
  const cellW = GRID / COLS;
  const y = Math.floor(((c.row + 0.5) * GRID) / ROWS);
  const x0 = Math.floor(c.col * cellW + cellW * 0.2);
  const x1 = Math.floor(c.col * cellW + cellW * 0.8);
  return { color, size, pts: [x0, y, x1, y] };
}

const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
/** Scientific pitch name: MIDI 60 is C4. */
export const noteName = (midi: number): string => `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

const pitchAt = (c: Cursor): string => noteName(degreeToMidi(ROWS - 1 - c.row));

/** "Column 5, pitch E4": read out as the cursor moves. Columns are counted from 1. */
export const describeCursor = (c: Cursor): string => `Column ${c.col + 1}, pitch ${pitchAt(c)}`;

/** "Bell, column 5, pitch E4": read out when a note is placed. */
export const describeNote = (c: Cursor, voice: number): string => `${VOICE_NAMES[voice]}, column ${c.col + 1}, pitch ${pitchAt(c)}`;
