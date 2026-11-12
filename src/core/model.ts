// Shared constants and types. Everything here is plain data, no browser APIs,
// so the mapping and share modules can be unit-tested with `node --test`.

/** Strokes live on an integer grid; x and y each run 0..GRID-1. */
export const GRID = 1024;
/** The loop is cut into this many columns; every note starts on one. */
export const COLS = 32;
/** Rows of pitch from bottom to top. */
export const ROWS = 15;
/** One loop is this many beats long, so the tempo sets the loop length. */
export const LOOP_BEATS = 8;

export const BPM_MIN = 60; // 8 second loop
export const BPM_MAX = 120; // 4 second loop
export const BPM_DEFAULT = 90;

export const SIZE_MIN = 1;
export const SIZE_MAX = 8;
export const SIZE_DEFAULT = 4;

/** Colour index = voice index. */
export const VOICE_NAMES = ["Bell", "Pluck", "Pad", "Tap"] as const;
export const VOICE_COUNT = VOICE_NAMES.length;

/** Limits that keep a shared link small and a malicious one harmless. */
export const MAX_STROKES = 400;
export const MAX_POINTS = 1500;

export interface Stroke {
  readonly color: number;
  readonly size: number;
  /** Flat grid coordinates: x0, y0, x1, y1, ... */
  readonly pts: readonly number[];
}

export interface Song {
  readonly bpm: number;
  readonly strokes: readonly Stroke[];
}

/** One note of the loop. `step` is the column (0..COLS-1) it starts on. */
export interface Note {
  readonly step: number;
  readonly degree: number;
  readonly midi: number;
  readonly gain: number;
  readonly voice: number;
}

export const emptySong = (bpm: number = BPM_DEFAULT): Song => ({ bpm, strokes: [] });
