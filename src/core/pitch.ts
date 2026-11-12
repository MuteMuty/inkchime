// Stroke position -> musical meaning. Pure functions only.
import { COLS, GRID, LOOP_BEATS, ROWS, SIZE_MAX, SIZE_MIN } from "./model.ts";

/** Major pentatonic: any mix of these notes sounds fine together. */
const PENTATONIC = [0, 2, 4, 7, 9];
/** Degree 0 is C3. Three octaves up is A5. */
export const BASE_MIDI = 48;

export function degreeToMidi(degree: number): number {
  return BASE_MIDI + 12 * Math.floor(degree / PENTATONIC.length) + PENTATONIC[degree % PENTATONIC.length];
}

export const midiToFreq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Row 0 is the top of the canvas, which is the highest degree. */
export function gridYToDegree(gy: number): number {
  const row = clamp(Math.floor((gy * ROWS) / GRID), 0, ROWS - 1);
  return ROWS - 1 - row;
}

export function gridXToStep(gx: number): number {
  return clamp(Math.floor((gx * COLS) / GRID), 0, COLS - 1);
}

/** Thickness is volume. A gentle curve so thin lines stay audible and thick ones don't jump. */
export function sizeToGain(size: number): number {
  const t = (clamp(size, SIZE_MIN, SIZE_MAX) - SIZE_MIN) / (SIZE_MAX - SIZE_MIN);
  return Math.min(1, 0.12 + 0.88 * t ** 1.3);
}

export const loopSeconds = (bpm: number): number => (LOOP_BEATS * 60) / bpm;
export const stepSeconds = (bpm: number): number => loopSeconds(bpm) / COLS;
