import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveLink, linkFor } from "../../src/core/livelink.ts";
import { prepareShare, songFromHash } from "../../src/core/share.ts";
import { GRID, MAX_STROKES, type Song, type Stroke } from "../../src/core/model.ts";

const line = (y: number, color = 0, size = 4): Stroke => ({ color, size, pts: [10, y, 600, y] });
const song = (...strokes: Stroke[]): Song => ({ bpm: 96, strokes });

/** 60 strokes of 1500 random points: past the payload cap, and no simplification keeps its notes. */
function tooBig(): Song {
  let s = 7;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const strokes: Stroke[] = [];
  for (let i = 0; i < 60; i++) {
    const pts: number[] = [];
    for (let j = 0; j < 1500; j++) pts.push(Math.floor(r() * GRID), Math.floor(r() * GRID));
    strokes.push({ color: i % 4, size: 4, pts });
  }
  return { bpm: 90, strokes };
}

// --- linkFor -------------------------------------------------------------------

test("linkFor: the same link Share would copy, and it opens to this song", () => {
  const s = song(line(100, 1, 6), line(700, 3, 2));
  const hash = linkFor(s);
  const shared = prepareShare(s);
  assert.ok(shared.ok);
  assert.equal(hash, shared.ok ? shared.hash : "");
  assert.deepEqual(songFromHash(hash!), s);
});

test("linkFor: an empty song (after Clear) is a link to an empty canvas that keeps the tempo", () => {
  const hash = linkFor({ bpm: 72, strokes: [] });
  assert.ok(hash);
  assert.deepEqual(songFromHash(hash), { bpm: 72, strokes: [] });
});

test("linkFor: a song that can't be linked faithfully gives no link", () => {
  assert.equal(linkFor(tooBig()), null);
  const over: Stroke[] = [];
  for (let i = 0; i <= MAX_STROKES; i++) over.push(line(10 + (i % 900)));
  assert.equal(linkFor(song(...over)), null);
});

// --- LiveLink --------------------------------------------------------------------

/** A LiveLink wired to a fake scheduler, so the test decides when "idle" comes. */
function rig(start: Song) {
  let current = start;
  const writes: string[] = [];
  const queue: (() => void)[] = [];
  let behind = 0;
  const live = new LiveLink({
    song: () => current,
    write: (h) => writes.push(h),
    schedule: (run) => {
      queue.push(run);
      return () => queue.splice(queue.indexOf(run), 1);
    },
    onBehind: () => behind++,
  });
  return {
    live,
    writes,
    queue,
    behind: () => behind,
    set: (s: Song) => (current = s),
    idle: () => queue.splice(0).forEach((run) => run()),
  };
}

test("before Share, edits never touch the link", () => {
  const t = rig(song(line(100)));
  t.set(song(line(100), line(200)));
  t.live.changed();
  t.idle();
  assert.equal(t.live.active, false);
  assert.equal(t.queue.length, 0);
  assert.deepEqual(t.writes, []);
});

test("after Share, each edit rewrites the link with the current song", () => {
  const t = rig(song(line(100)));
  t.live.start();
  assert.equal(t.live.active, true);
  const steps = [song(line(100), line(200)), song(line(100)), song(), song(line(300, 2, 8))]; // add, undo, clear, draw again
  for (const s of steps) {
    t.set(s);
    t.live.changed();
    t.idle();
    assert.deepEqual(songFromHash(t.writes.at(-1)!), s);
  }
  assert.equal(t.writes.length, steps.length);
});

test("a burst of edits is written once, when idle, with the latest song", () => {
  const t = rig(song(line(100)));
  t.live.start();
  for (let i = 0; i < 5; i++) {
    t.set(song(line(100), line(200 + i)));
    t.live.changed();
  }
  assert.equal(t.queue.length, 1, "one pending write, not one per edit");
  assert.deepEqual(t.writes, [], "nothing is encoded until idle");
  t.idle();
  assert.equal(t.writes.length, 1);
  assert.deepEqual(songFromHash(t.writes[0]), song(line(100), line(204)));
});

test("a song too big to link keeps the last good link and says so once", () => {
  const good = song(line(100));
  const t = rig(good);
  t.live.start();
  t.live.changed();
  t.idle();
  assert.equal(t.writes.length, 1);

  t.set(tooBig());
  t.live.changed();
  t.idle();
  t.live.changed();
  t.idle();
  assert.equal(t.writes.length, 1, "no wrong link is written");
  assert.equal(t.behind(), 1, "told once, not on every edit");

  t.set(song(line(100), line(500)));
  t.live.changed();
  t.idle();
  assert.equal(t.writes.length, 2, "follows the song again once it fits");
  assert.deepEqual(songFromHash(t.writes[1]), song(line(100), line(500)));

  t.set(tooBig());
  t.live.changed();
  t.idle();
  assert.equal(t.behind(), 2, "and says so again the next time it falls behind");
});
