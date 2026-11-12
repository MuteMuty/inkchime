// Strokes -> notes. This is the whole "drawing becomes music" rule:
//   x position  -> which column of the loop the note starts in
//   height      -> pitch, snapped to the pentatonic scale (pitch.ts)
//   thickness   -> gain
//   colour      -> voice
import { COLS, type Note, type Song, type Stroke } from "./model.ts";
import { degreeToMidi, gridXToStep, gridYToDegree, sizeToGain } from "./pitch.ts";

/** A column plays at most this many notes, so a vertical scribble is a chord, not noise. */
const MAX_NOTES_PER_COLUMN = 3;
/** Sampling interval along a segment, in grid units. Smaller than a column or a row, so none is skipped. */
const SAMPLE = 8;

export function strokeToNotes(stroke: Stroke): Note[] {
  const { pts } = stroke;
  const degreesByStep = new Map<number, Set<number>>();
  const visit = (x: number, y: number) => {
    const step = gridXToStep(x);
    let set = degreesByStep.get(step);
    if (!set) degreesByStep.set(step, (set = new Set()));
    set.add(gridYToDegree(y));
  };

  if (pts.length === 2) visit(pts[0], pts[1]);
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3];
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / SAMPLE));
    for (let k = 0; k <= n; k++) visit(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
  }

  const gain = sizeToGain(stroke.size);
  const notes: Note[] = [];
  for (const step of [...degreesByStep.keys()].sort((a, b) => a - b)) {
    let degrees = [...degreesByStep.get(step)!].sort((a, b) => a - b);
    if (degrees.length > MAX_NOTES_PER_COLUMN) {
      degrees = [degrees[0], degrees[degrees.length >> 1], degrees[degrees.length - 1]];
    }
    for (const degree of degrees) notes.push({ step, degree, midi: degreeToMidi(degree), gain, voice: stroke.color });
  }
  return notes;
}

/** Every note of the loop, sorted by column then pitch. Same pitch in the same voice keeps the loudest. */
export function songToNotes(song: Song): Note[] {
  const best = new Map<string, Note>();
  for (const stroke of song.strokes) {
    for (const note of strokeToNotes(stroke)) {
      const key = `${note.step}:${note.voice}:${note.midi}`;
      const old = best.get(key);
      if (!old || note.gain > old.gain) best.set(key, note);
    }
  }
  return [...best.values()].sort((a, b) => a.step - b.step || a.midi - b.midi || a.voice - b.voice);
}

export function notesByStep(notes: readonly Note[]): Note[][] {
  const buckets: Note[][] = Array.from({ length: COLS }, () => []);
  for (const n of notes) buckets[n.step].push(n);
  return buckets;
}
