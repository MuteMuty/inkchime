// Share links. The whole song lives in the URL hash: nothing is stored anywhere.
//
// Format, before base64url:
//   version(1) bpm(varint) strokeCount(varint)
//   per stroke: colour<<4 | size (1 byte), pointCount(varint), x0(varint), y0(varint),
//               then (dx, dy) zigzag varints for every further point
import { songToNotes } from "./notes.ts";
import { simplify } from "./stroke.ts";
import { BPM_MAX, BPM_MIN, GRID, MAX_PAYLOAD_CHARS, MAX_POINTS, MAX_STROKES, SIZE_MAX, SIZE_MIN, VOICE_COUNT, type Song, type Stroke } from "./model.ts";

const VERSION = 1;
const PREFIX = "v1.";

// --- bytes <-> base64url ---------------------------------------------------

function toBase64Url(bytes: readonly number[]): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): number[] | null {
  if (text.length > MAX_PAYLOAD_CHARS || text.length % 4 === 1 || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  let bin: string;
  try {
    bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  } catch {
    return null;
  }
  const out = new Array<number>(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- varints ---------------------------------------------------------------

function writeVarint(out: number[], value: number): void {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

const zigzag = (v: number) => (v >= 0 ? v * 2 : -v * 2 - 1);
const unzigzag = (v: number) => (v % 2 === 0 ? v / 2 : -(v + 1) / 2);

class Reader {
  private i = 0;
  private readonly bytes: readonly number[];
  constructor(bytes: readonly number[]) {
    this.bytes = bytes;
  }
  byte(): number {
    if (this.i >= this.bytes.length) throw new Error("end of data");
    return this.bytes[this.i++];
  }
  varint(): number {
    let result = 0;
    let scale = 1;
    for (let n = 0; n < 5; n++) {
      const b = this.byte();
      result += (b & 0x7f) * scale;
      if (b < 0x80) return result;
      scale *= 128;
    }
    throw new Error("varint too long");
  }
  get done(): boolean {
    return this.i === this.bytes.length;
  }
}

// --- song <-> text ---------------------------------------------------------

export function encodeSong(song: Song): string {
  const out: number[] = [VERSION];
  writeVarint(out, song.bpm);
  writeVarint(out, song.strokes.length);
  for (const s of song.strokes) {
    out.push(((s.color & 15) << 4) | (s.size & 15));
    const n = s.pts.length / 2;
    writeVarint(out, n);
    if (n === 0) continue;
    writeVarint(out, s.pts[0]);
    writeVarint(out, s.pts[1]);
    for (let i = 1; i < n; i++) {
      writeVarint(out, zigzag(s.pts[2 * i] - s.pts[2 * i - 2]));
      writeVarint(out, zigzag(s.pts[2 * i + 1] - s.pts[2 * i - 1]));
    }
  }
  return toBase64Url(out);
}

/** Returns the song, or null if the text is not a valid song. Never throws. */
export function decodeSong(text: string): Song | null {
  const bytes = fromBase64Url(text);
  if (!bytes) return null;
  try {
    const r = new Reader(bytes);
    if (r.byte() !== VERSION) return null;
    const bpm = r.varint();
    if (bpm < BPM_MIN || bpm > BPM_MAX) return null;
    const count = r.varint();
    if (count > MAX_STROKES) return null;
    const strokes: Stroke[] = [];
    for (let s = 0; s < count; s++) {
      const head = r.byte();
      const color = head >> 4;
      const size = head & 15;
      if (color >= VOICE_COUNT || size < SIZE_MIN || size > SIZE_MAX) return null;
      const n = r.varint();
      if (n < 1 || n > MAX_POINTS) return null;
      let x = r.varint();
      let y = r.varint();
      if (x >= GRID || y >= GRID) return null;
      const pts = [x, y];
      for (let i = 1; i < n; i++) {
        x += unzigzag(r.varint());
        y += unzigzag(r.varint());
        if (x < 0 || x >= GRID || y < 0 || y >= GRID) return null;
        pts.push(x, y);
      }
      strokes.push({ color, size, pts });
    }
    return r.done ? { bpm, strokes } : null;
  } catch {
    return null;
  }
}

/** `#v1.<payload>` */
export const songToHash = (song: Song): string => "#" + PREFIX + encodeSong(song);

/** Accepts the hash with or without the leading `#`. Null for anything that is not a song. */
export function songFromHash(hash: string): Song | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  return h.startsWith(PREFIX) ? decodeSong(h.slice(PREFIX.length)) : null;
}

// --- sharing safely --------------------------------------------------------

/** Tolerances (grid units) tried, in order, when a song is too big to share as it is. */
const SHARE_TOLERANCES = [3, 6, 12, 24];

export type ShareResult =
  | { readonly ok: true; readonly hash: string; /** true if points were dropped to fit; the notes are unchanged */ readonly simplified: boolean }
  | { readonly ok: false };

const sameSong = (a: Song, b: Song): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Builds the link to share, and only returns one that opens to this song.
 * The link is decoded again and compared. If it is too long or over a limit, the
 * points are simplified a little more, but only as far as the notes stay identical.
 * Otherwise there is no link (`ok: false`), so Share never hands out a dead one.
 */
export function prepareShare(song: Song): ShareResult {
  if (!song.strokes.length || song.strokes.length > MAX_STROKES) return { ok: false };
  const hash = songToHash(song);
  const back = songFromHash(hash);
  if (back && sameSong(back, song)) return { ok: true, hash, simplified: false };

  const notes = JSON.stringify(songToNotes(song));
  for (const eps of SHARE_TOLERANCES) {
    const smaller: Song = { bpm: song.bpm, strokes: song.strokes.map((s) => ({ ...s, pts: simplify(s.pts, eps) })) };
    const smallerHash = songToHash(smaller);
    const opened = songFromHash(smallerHash);
    if (opened && sameSong(opened, smaller) && JSON.stringify(songToNotes(opened)) === notes) {
      return { ok: true, hash: smallerHash, simplified: true };
    }
  }
  return { ok: false };
}
