import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeSong, decodeSong, songToHash, songFromHash, prepareShare } from "../../src/core/share.ts";
import { songToNotes } from "../../src/core/notes.ts";
import { normalizePoints } from "../../src/core/stroke.ts";
import { GRID, BPM_MIN, BPM_MAX, MAX_STROKES, MAX_POINTS, MAX_PAYLOAD_CHARS, VOICE_COUNT, SIZE_MIN, SIZE_MAX, type Song, type Stroke } from "../../src/core/model.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function randomSong(seed: number): Song {
  const r = rng(seed);
  const strokes: Stroke[] = [];
  const n = 1 + Math.floor(r() * 25);
  for (let i = 0; i < n; i++) {
    const raw: number[] = [];
    let x = r(), y = r();
    const len = 1 + Math.floor(r() * 90);
    for (let j = 0; j < len; j++) {
      raw.push(x, y);
      x = Math.min(1, Math.max(0, x + (r() - 0.5) * 0.08));
      y = Math.min(1, Math.max(0, y + (r() - 0.5) * 0.08));
    }
    strokes.push({
      color: Math.floor(r() * VOICE_COUNT),
      size: SIZE_MIN + Math.floor(r() * (SIZE_MAX - SIZE_MIN + 1)),
      pts: normalizePoints(raw),
    });
  }
  return { bpm: BPM_MIN + Math.floor(r() * (BPM_MAX - BPM_MIN + 1)), strokes };
}

test("round trip: 200 random songs come back identical, with the same note schedule", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const song = randomSong(seed);
    const back = decodeSong(encodeSong(song));
    assert.ok(back, `seed ${seed} failed to decode`);
    assert.deepEqual(back, song, `seed ${seed} changed`);
    assert.deepEqual(songToNotes(back), songToNotes(song));
  }
});

test("round trip: an empty song, and the extremes", () => {
  const empty: Song = { bpm: 90, strokes: [] };
  assert.deepEqual(decodeSong(encodeSong(empty)), empty);
  const extreme: Song = {
    bpm: BPM_MAX,
    strokes: [
      { color: VOICE_COUNT - 1, size: SIZE_MAX, pts: [0, 0, GRID - 1, GRID - 1, 0, GRID - 1] },
      { color: 0, size: SIZE_MIN, pts: [GRID - 1, 0] },
    ],
  };
  assert.deepEqual(decodeSong(encodeSong(extreme)), extreme);
});

test("the payload is URL-safe and compact", () => {
  const song = randomSong(7);
  const text = encodeSong(song);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  const hash = songToHash(song);
  assert.ok(hash.startsWith("#v1."));
  assert.ok(hash.length < 4000, `hash is ${hash.length} chars`);
  // One simple stroke is tiny.
  const tiny = songToHash({ bpm: 90, strokes: [{ color: 1, size: 4, pts: [100, 100, 400, 500] }] });
  assert.ok(tiny.length < 40, `tiny hash is ${tiny.length} chars`);
});

test("hash helpers round trip and accept a leading #", () => {
  const song = randomSong(3);
  assert.deepEqual(songFromHash(songToHash(song)), song);
  assert.deepEqual(songFromHash(songToHash(song).slice(1)), song);
});

test("no hash, or a hash that is not ours, is not a song", () => {
  for (const h of ["", "#", "#hello", "#v2.AAAA", "#v1", "#v1.", "#/some/path", "#v1.%%%%", "#v1.A B"]) {
    assert.equal(songFromHash(h), null, JSON.stringify(h));
  }
});

test("malformed payloads fail cleanly and never throw", () => {
  const good = encodeSong(randomSong(11));
  const bad: string[] = [
    "",
    "A",
    "AAAA",
    "////",
    "!!!!",
    good.slice(0, 5),
    good.slice(0, good.length >> 1),
    good + "AAAA", // trailing bytes
    "A".repeat(100000),
  ];
  for (const b of bad) assert.doesNotThrow(() => decodeSong(b));
  for (const b of bad.slice(0, 8)) assert.equal(decodeSong(b), null, b.slice(0, 20));
});

test("fuzz: random bytes and mangled links never throw and never decode to something invalid", () => {
  const r = rng(99);
  const good = encodeSong(randomSong(5));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let i = 0; i < 2000; i++) {
    let s: string;
    if (i % 2) {
      s = "";
      const len = Math.floor(r() * 60);
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(r() * 64)];
    } else {
      const k = Math.floor(r() * good.length);
      s = good.slice(0, k) + alphabet[Math.floor(r() * 64)] + good.slice(k + 1);
    }
    let song: Song | null = null;
    assert.doesNotThrow(() => (song = decodeSong(s)));
    if (song) {
      const sg: Song = song;
      assert.ok(sg.bpm >= BPM_MIN && sg.bpm <= BPM_MAX);
      assert.ok(sg.strokes.length <= MAX_STROKES);
      for (const st of sg.strokes) {
        assert.ok(st.color >= 0 && st.color < VOICE_COUNT);
        assert.ok(st.size >= SIZE_MIN && st.size <= SIZE_MAX);
        assert.ok(st.pts.length >= 2 && st.pts.length % 2 === 0 && st.pts.length / 2 <= MAX_POINTS);
        assert.ok(st.pts.every((v) => Number.isInteger(v) && v >= 0 && v < GRID));
      }
    }
  }
});

test("out-of-range fields are rejected", () => {
  const ok: Song = { bpm: 90, strokes: [{ color: 0, size: 4, pts: [1, 2] }] };
  assert.ok(decodeSong(encodeSong(ok)));
  assert.equal(decodeSong(encodeSong({ ...ok, bpm: BPM_MAX + 1 })), null);
  assert.equal(decodeSong(encodeSong({ ...ok, bpm: BPM_MIN - 1 })), null);
  assert.equal(decodeSong(encodeSong({ bpm: 90, strokes: [{ color: VOICE_COUNT, size: 4, pts: [1, 2] }] })), null);
  assert.equal(decodeSong(encodeSong({ bpm: 90, strokes: [{ color: 0, size: SIZE_MAX + 1, pts: [1, 2] }] })), null);
  assert.equal(decodeSong(encodeSong({ bpm: 90, strokes: [{ color: 0, size: 4, pts: [GRID, 2] }] })), null);
  assert.equal(decodeSong(encodeSong({ bpm: 90, strokes: [{ color: 0, size: 4, pts: [] }] })), null);
});

// --- verify before sharing ---------------------------------------------------

/** A full song of short lines: the largest song the drawing guard allows. */
function fullSong(count: number): Song {
  const strokes: Stroke[] = [];
  for (let i = 0; i < count; i++) strokes.push({ color: i % VOICE_COUNT, size: 1 + (i % 8), pts: [20 + (i % 900), 100 + (i % 800), 60 + (i % 900), 140 + (i % 800)] });
  return { bpm: 90, strokes };
}

/** `count` strokes of `n` points each. `wobble` is the vertical zigzag in grid units. */
function longStrokes(count: number, n: number, wobble: number, chaotic: boolean): Song {
  const r = rng(5);
  const strokes: Stroke[] = [];
  for (let s = 0; s < count; s++) {
    const pts: number[] = [];
    let x = 0, y = 500;
    for (let i = 0; i < n; i++) {
      if (chaotic) {
        x = Math.floor(r() * GRID);
        y = Math.floor(r() * GRID);
      } else {
        x = Math.floor((i * (GRID - 1)) / (n - 1));
        y = 500 + (i % 2 ? wobble : -wobble) + (s % 3);
      }
      pts.push(x, y);
    }
    strokes.push({ color: s % VOICE_COUNT, size: 4, pts });
  }
  return { bpm: 90, strokes };
}

test("prepareShare: a full song of MAX_STROKES strokes gives a link that reproduces it exactly", () => {
  const song = fullSong(MAX_STROKES);
  const res = prepareShare(song);
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.deepEqual(songFromHash(res.hash), song);
  assert.equal(res.simplified, false);
});

test("prepareShare: one stroke over the limit is refused, never shared", () => {
  const res = prepareShare(fullSong(MAX_STROKES + 1));
  assert.equal(res.ok, false);
});

test("prepareShare: an empty song is refused", () => {
  assert.equal(prepareShare({ bpm: 90, strokes: [] }).ok, false);
});

test("prepareShare: a song past the payload cap is simplified until it fits, and still sounds the same", () => {
  const song = longStrokes(60, 1500, 4, false);
  assert.ok(encodeSong(song).length > MAX_PAYLOAD_CHARS, "test song should be too big as it is");
  assert.equal(decodeSong(encodeSong(song)), null, "and an unverified link would open empty");
  const res = prepareShare(song);
  assert.ok(res.ok, "should have been made to fit");
  if (!res.ok) return;
  assert.equal(res.simplified, true);
  const back = songFromHash(res.hash);
  assert.ok(back, "the link must open");
  assert.deepEqual(songToNotes(back), songToNotes(song), "same notes");
  assert.deepEqual(back.strokes.map((s) => [s.color, s.size]), song.strokes.map((s) => [s.color, s.size]));
  assert.ok(res.hash.length <= MAX_PAYLOAD_CHARS + 4);
});

test("prepareShare: a song that cannot be made to fit without changing its sound is refused honestly", () => {
  const song = longStrokes(60, 1500, 0, true);
  assert.ok(encodeSong(song).length > MAX_PAYLOAD_CHARS);
  assert.equal(prepareShare(song).ok, false);
});
