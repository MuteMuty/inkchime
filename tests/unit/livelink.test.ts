import { test } from "node:test";
import assert from "node:assert/strict";
import { BURST, LiveLink, REFILL_MS, linkFor, writesAtOnce, type Edit } from "../../src/core/livelink.ts";
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

/**
 * A LiveLink wired to a fake scheduler and clock, so the test decides when "idle" comes.
 * Each idle moment moves the clock on a second; `refuse` makes the writer throw like a
 * browser past its address-bar budget.
 */
function rig(start: Song) {
  let current = start;
  let clock = 0;
  let refuse = false;
  let refused = 0;
  const writes: string[] = [];
  const times: number[] = [];
  const queue: (() => void)[] = [];
  const delays: number[] = [];
  const dues: number[] = [];
  let behind = 0;
  const live = new LiveLink({
    song: () => current,
    write: (h) => {
      if (refuse) {
        refused++;
        throw new DOMException("Attempt to use history.replaceState() more than 100 times per 30 seconds", "SecurityError");
      }
      writes.push(h);
      times.push(clock);
    },
    schedule: (run, delay = 0) => {
      queue.push(run);
      delays.push(delay);
      dues.push(clock + delay);
      return () => {
        const i = queue.indexOf(run);
        if (i >= 0) queue.splice(i, 1), delays.splice(i, 1), dues.splice(i, 1);
      };
    },
    now: () => clock,
    onBehind: () => behind++,
  });
  return {
    live,
    writes,
    /** The clock at each write. */
    times,
    queue,
    delays,
    behind: () => behind,
    refused: () => refused,
    refuse: (on: boolean) => (refuse = on),
    tick: (ms: number) => (clock += ms),
    set: (s: Song) => (current = s),
    idle: () => {
      clock += 1000;
      delays.length = dues.length = 0;
      queue.splice(0).forEach((run) => run());
    },
    /** Run the scheduled writes whose time has come, without moving the clock. */
    runDue: () => {
      const ready = queue.filter((_, i) => dues[i] <= clock);
      for (const run of ready) {
        const i = queue.indexOf(run);
        queue.splice(i, 1), delays.splice(i, 1), dues.splice(i, 1);
        run();
      }
    },
  };
}

test("before Share, edits never touch the link", () => {
  const t = rig(song(line(100)));
  t.set(song(line(100), line(200)));
  t.live.changed("tempo-drag");
  t.idle();
  assert.equal(t.live.active, false);
  assert.equal(t.queue.length, 0);
  assert.deepEqual(t.writes, []);
});

test("after Share, each edit rewrites the link with the current song", () => {
  const t = rig(song(line(100)));
  t.live.start();
  assert.equal(t.live.active, true);
  const steps: [Edit, Song][] = [
    ["stroke", song(line(100), line(200))],
    ["undo", song(line(100))],
    ["clear", song()],
    ["stroke", song(line(300, 2, 8))],
    ["tempo-drag", { bpm: 120, strokes: [line(300, 2, 8)] }],
  ];
  for (const [edit, s] of steps) {
    t.set(s);
    t.live.changed(edit);
    t.idle();
    assert.deepEqual(songFromHash(t.writes.at(-1)!), s);
  }
  assert.equal(t.writes.length, steps.length);
});

test("dragging the tempo slider is written once per idle moment, with the latest tempo", () => {
  const t = rig(song(line(100)));
  t.live.start();
  for (let bpm = 80; bpm <= 100; bpm++) {
    t.set({ bpm, strokes: [line(100)] });
    t.live.changed("tempo-drag");
  }
  assert.equal(t.queue.length, 1, "one pending write, not one per input event");
  assert.deepEqual(t.writes, [], "nothing is encoded until idle");
  t.idle();
  assert.equal(t.writes.length, 1);
  assert.deepEqual(songFromHash(t.writes[0]), { bpm: 100, strokes: [line(100)] });
  t.set({ bpm: 101, strokes: [line(100)] });
  t.live.changed("tempo-drag");
  assert.equal(t.queue.length, 1, "the next idle moment gets the next write");
  t.idle();
  assert.equal(t.writes.length, 2);
});

// --- which edits are written at once ----------------------------------------------
// A reload starts from the address it was given (in Chromium, before pagehide runs),
// so any edit that is not part of a drag must be in the address bar the moment it lands.

test("writesAtOnce: every discrete edit writes at once; only a tempo drag waits for idle", () => {
  const atOnce: Edit[] = ["stroke", "undo", "clear", "tempo", "open"];
  for (const edit of atOnce) assert.equal(writesAtOnce(edit), true, edit);
  assert.equal(writesAtOnce("tempo-drag"), false);
});

for (const [edit, after] of [
  ["stroke", song(line(100), line(200), line(300))], // pen-up, or a note placed with the keys
  ["undo", song(line(100))],
  ["clear", song()],
  ["tempo", { bpm: 112, strokes: [line(100), line(200)] }], // the slider let go (change)
  ["open", song(line(700, 3, 2))],
] as [Edit, Song][]) {
  test(`after Share, ${edit} is in the address bar before anything else runs, with no idle wait`, () => {
    const t = rig(song(line(100), line(200)));
    t.live.start();
    t.set(after);
    t.live.changed(edit);
    assert.equal(t.writes.length, 1, "written synchronously");
    assert.deepEqual(songFromHash(t.writes[0]), after);
    assert.equal(t.queue.length, 0, "nothing left waiting for idle");
  });

  test(`before Share, ${edit} touches nothing`, () => {
    const t = rig(song(line(100), line(200)));
    t.set(after);
    t.live.changed(edit);
    t.live.flush();
    t.idle();
    assert.deepEqual(t.writes, []);
    assert.equal(t.queue.length, 0);
  });
}

test("letting go of the tempo slider writes the final tempo at once and cancels the idle write", () => {
  const t = rig(song(line(100)));
  t.live.start();
  for (const bpm of [90, 95, 99]) {
    t.set({ bpm, strokes: [line(100)] });
    t.live.changed("tempo-drag");
  }
  t.live.changed("tempo");
  assert.equal(t.writes.length, 1);
  assert.equal(songFromHash(t.writes[0])?.bpm, 99);
  assert.equal(t.queue.length, 0, "the drag's pending write is cancelled");
  t.idle();
  assert.equal(t.writes.length, 1, "and not written twice");
});

test("an undo during a tempo drag writes both at once and leaves nothing queued", () => {
  const t = rig(song(line(100), line(200)));
  t.live.start();
  t.set({ bpm: 110, strokes: [line(100), line(200)] });
  t.live.changed("tempo-drag");
  t.set({ bpm: 110, strokes: [line(100)] });
  t.live.changed("undo");
  assert.equal(t.writes.length, 1);
  assert.deepEqual(songFromHash(t.writes[0]), { bpm: 110, strokes: [line(100)] });
  assert.equal(t.queue.length, 0);
});

test("a discrete edit that makes the song too big keeps the last good link and says so", () => {
  const t = rig(song(line(100)));
  t.live.start();
  t.live.changed("stroke");
  t.set(tooBig());
  t.live.changed("stroke");
  assert.equal(t.writes.length, 1);
  assert.equal(t.behind(), 1);
});

test("a song too big to link keeps the last good link and says so once", () => {
  const good = song(line(100));
  const t = rig(good);
  t.live.start();
  t.live.changed("tempo-drag");
  t.idle();
  assert.equal(t.writes.length, 1);

  t.set(tooBig());
  t.live.changed("tempo-drag");
  t.idle();
  t.live.changed("tempo-drag");
  t.idle();
  assert.equal(t.writes.length, 1, "no wrong link is written");
  assert.equal(t.behind(), 1, "told once, not on every edit");

  t.set(song(line(100), line(500)));
  t.live.changed("tempo-drag");
  t.idle();
  assert.equal(t.writes.length, 2, "follows the song again once it fits");
  assert.deepEqual(songFromHash(t.writes[1]), song(line(100), line(500)));

  t.set(tooBig());
  t.live.changed("tempo-drag");
  t.idle();
  assert.equal(t.behind(), 2, "and says so again the next time it falls behind");
});

// --- flush (pagehide) ------------------------------------------------------------

test("flush writes a pending link at once, so a reload right after pen-up keeps that stroke", () => {
  const t = rig(song(line(100)));
  t.live.start();
  t.set(song(line(100), line(200)));
  t.live.changed("tempo-drag");
  assert.deepEqual(t.writes, [], "still waiting for idle");
  t.live.flush();
  assert.equal(t.writes.length, 1, "written synchronously");
  assert.deepEqual(songFromHash(t.writes[0]), song(line(100), line(200)));
  assert.equal(t.queue.length, 0, "the idle write is cancelled");
  t.idle();
  assert.equal(t.writes.length, 1, "and not written twice");
});

test("flush with nothing pending writes nothing", () => {
  const t = rig(song(line(100)));
  t.live.start();
  t.live.changed("tempo-drag");
  t.idle();
  assert.equal(t.writes.length, 1);
  t.live.flush();
  t.live.flush();
  assert.equal(t.writes.length, 1);
});

test("before Share, flush writes nothing", () => {
  const t = rig(song(line(100)));
  t.set(song(line(100), line(200)));
  t.live.changed("tempo-drag");
  t.live.flush();
  assert.deepEqual(t.writes, []);
  assert.equal(t.queue.length, 0);
});

test("after a flush, the next edit queues a write again", () => {
  const t = rig(song(line(100)));
  t.live.start();
  t.set(song(line(100), line(200)));
  t.live.changed("tempo-drag");
  t.live.flush();
  t.set(song(line(100), line(200), line(300)));
  t.live.changed("tempo-drag");
  assert.equal(t.queue.length, 1);
  t.idle();
  assert.deepEqual(songFromHash(t.writes.at(-1)!), song(line(100), line(200), line(300)));
});

// --- a browser refusing the write (Safari: 100 per 30 s) -----------------------------
// A refused write must never stop the edit: the page keeps going, and one write waits
// for later so the address bar catches up once the browser allows it again.

test("a writer that throws does not throw out of changed(), and a later flush writes the current song", () => {
  const t = rig(song(line(100), line(200), line(300)));
  t.live.start();
  t.refuse(true);
  t.set(song(line(100), line(200)));
  assert.doesNotThrow(() => t.live.changed("undo"));
  assert.equal(t.refused(), 1, "the undo tried to write at once");
  assert.equal(t.queue.length, 1, "one write is kept for later");
  t.set(song(line(100)));
  assert.doesNotThrow(() => t.live.changed("undo"));
  assert.equal(t.refused(), 1, "while refused, later edits wait instead of hammering the browser");
  assert.equal(t.queue.length, 1, "still one pending write, not one per edit");

  t.refuse(false);
  t.live.flush();
  assert.equal(t.writes.length, 1);
  assert.deepEqual(songFromHash(t.writes[0]), song(line(100)), "the flush writes the song on screen now");
  assert.equal(t.queue.length, 0);
  t.set(song());
  t.live.changed("clear");
  assert.equal(t.writes.length, 2, "once the browser takes writes again, edits write at once again");
});

test("a refused write retries a while later, and keeps retrying until the browser takes it", () => {
  const t = rig(song(line(100), line(200)));
  t.live.start();
  t.refuse(true);
  t.set(song(line(100)));
  t.live.changed("undo");
  assert.ok(t.delays[0] >= 500, `the retry waits a while (${t.delays[0]} ms), not the next frame`);
  t.idle();
  assert.equal(t.refused(), 2, "the retry tried again");
  assert.equal(t.queue.length, 1, "and, refused again, waits once more");
  t.refuse(false);
  t.idle();
  assert.equal(t.writes.length, 1);
  assert.deepEqual(songFromHash(t.writes[0]), song(line(100)));
  assert.equal(t.queue.length, 0);
});

test("a flush that is refused keeps the write pending", () => {
  const t = rig(song(line(100)));
  t.live.start();
  t.set({ bpm: 120, strokes: [line(100)] });
  t.live.changed("tempo-drag");
  t.refuse(true);
  assert.doesNotThrow(() => t.live.flush());
  assert.equal(t.queue.length, 1);
  t.refuse(false);
  t.live.flush();
  assert.deepEqual(songFromHash(t.writes.at(-1)!), { bpm: 120, strokes: [line(100)] });
});

// --- holding a key (auto-repeat) ---------------------------------------------------

test("holding Ctrl+Z writes the first few undos at once, then falls back to a paced write", () => {
  const strokes = Array.from({ length: 150 }, (_, i) => line(10 + i));
  const t = rig(song(...strokes));
  t.live.start();
  for (let n = 149; n >= 0; n--) {
    t.set(song(...strokes.slice(0, n)));
    t.live.changed("undo");
    t.tick(33); // key auto-repeat, ~30 per second
    t.runDue(); // a paced write that comes due between repeats
  }
  const seconds = (150 * 33) / 1000;
  assert.ok(t.writes.length >= 5, "the first undos still write at once");
  assert.ok(t.writes.length <= 5 + seconds * 3 + 1, `${t.writes.length} writes in ${seconds} s: under Safari's 100 per 30 s pace`);
  t.idle();
  assert.deepEqual(songFromHash(t.writes.at(-1)!), song(), "the address bar ends on the song on screen");
  assert.equal(t.queue.length, 0);
});

test("a single undo after a burst has calmed down writes at once again", () => {
  const t = rig(song(line(100), line(200), line(300)));
  t.live.start();
  for (let i = 0; i < 20; i++) t.live.changed("stroke");
  t.idle();
  t.tick(5000);
  const before = t.writes.length;
  t.set(song(line(100), line(200)));
  t.live.changed("undo");
  assert.equal(t.writes.length, before + 1, "written synchronously");
  assert.equal(t.queue.length, 0);
});

// --- letting go after a long drag (lab#45) ---------------------------------------------
// A drag writes at idle moments, and those writes come from the same budget as every
// other edit. Letting go is one discrete edit at the end of a gesture: it must land in the
// address bar at once even when the drag has spent the budget, so a reload right after
// it opens the released tempo, not one from the middle of the drag.

/** Drag the tempo for `ms`, an input event per frame, running each idle write as it comes due. */
function drag(t: ReturnType<typeof rig>, from: number, to: number, ms: number, frame = 16): void {
  const steps = Math.max(1, Math.round(ms / frame));
  for (let i = 0; i <= steps; i++) {
    t.set({ bpm: Math.round(from + ((to - from) * i) / steps), strokes: [line(100)] });
    t.live.changed("tempo-drag");
    t.tick(frame);
    t.runDue();
  }
}

test("letting go after a drag that drained the budget writes the released tempo at once", () => {
  const t = rig(song(line(100)));
  t.live.start();
  drag(t, 90, 120, 600); // a long drag: an idle write most frames until the budget is spent
  drag(t, 120, 64, 900);
  assert.ok(t.writes.length >= BURST, `the drag spent the burst (${t.writes.length} writes)`);
  assert.notEqual(songFromHash(t.writes.at(-1)!)?.bpm, 64, "the last drag write is an in-between tempo");
  const before = t.writes.length;
  t.live.changed("tempo");
  assert.equal(t.writes.length, before + 1, "written synchronously, with no wait for the budget");
  assert.equal(songFromHash(t.writes.at(-1)!)?.bpm, 64);
  assert.equal(t.queue.length, 0, "the drag's waiting write is cancelled");
  t.idle();
  assert.equal(t.writes.length, before + 1, "and not written twice");
});

test("a tempo drag of any length stays throttled to the write budget", () => {
  for (const ms of [100, 500, 2000, 8000]) {
    const t = rig(song(line(100)));
    t.live.start();
    drag(t, 60, 120, ms);
    const most = BURST + Math.ceil(ms / REFILL_MS) + 1;
    assert.ok(t.writes.length <= most, `${t.writes.length} writes in a ${ms} ms drag (at most ${most})`);
    t.live.changed("tempo");
    assert.equal(songFromHash(t.writes.at(-1)!)?.bpm, 120, `released at 120 after a ${ms} ms drag`);
    assert.equal(t.queue.length, 0);
  }
});

test("holding an arrow key on the slider, then letting go, writes the final tempo at once", () => {
  const t = rig(song(line(100)));
  t.live.start();
  drag(t, 90, 60, 1500, 33); // key auto-repeat: a step every ~33 ms, each a drag step
  t.live.changed("tempo"); // keyup
  assert.equal(songFromHash(t.writes.at(-1)!)?.bpm, 60);
  assert.equal(t.queue.length, 0);
});

test("letting go after an undo burst still writes at once", () => {
  const t = rig(song(line(100), line(200), line(300)));
  t.live.start();
  for (let i = 0; i < BURST; i++) t.live.changed("undo"); // the burst is spent
  drag(t, 90, 100, 100);
  t.set({ bpm: 101, strokes: [line(100)] });
  t.live.changed("tempo");
  assert.equal(songFromHash(t.writes.at(-1)!)?.bpm, 101);
  assert.equal(t.queue.length, 0);
});

test("letting go borrows from the budget: the edits after it wait their turn", () => {
  const t = rig(song(line(100), line(200)));
  t.live.start();
  drag(t, 90, 110, 1000);
  t.live.changed("tempo");
  const before = t.writes.length;
  t.set(song(line(100)));
  t.live.changed("undo");
  assert.equal(t.writes.length, before, "the undo right after waits for the budget");
  assert.equal(t.queue.length, 1);
  t.idle();
  assert.deepEqual(songFromHash(t.writes.at(-1)!), song(line(100)), "and is written once it allows");
});

test("many short drags let go in a row stay under Safari's 100 writes per 30 s", () => {
  const t = rig(song(line(100)));
  t.live.start();
  const gestures = 400; // about ten a second for 45 seconds, far quicker than anyone adjusts a tempo
  for (let i = 0; i < gestures; i++) {
    drag(t, 60 + (i % 60), 61 + (i % 60), 50);
    t.live.changed("tempo");
    t.tick(50);
    t.runDue();
  }
  let most = 0;
  for (let i = 0; i < t.times.length; i++) {
    let n = 0;
    while (i + n < t.times.length && t.times[i + n] < t.times[i] + 30_000) n++;
    most = Math.max(most, n);
  }
  assert.ok(most < 100, `${most} writes in the busiest 30 s`);
  t.idle();
  assert.equal(songFromHash(t.writes.at(-1)!)?.bpm, 61 + ((gestures - 1) % 60), "the address bar ends on the tempo on screen");
});

test("letting go while the browser refuses writes waits for the retry instead of hammering it", () => {
  const t = rig(song(line(100)));
  t.live.start();
  t.refuse(true);
  drag(t, 90, 100, 200);
  const tries = t.refused();
  t.live.changed("tempo");
  assert.equal(t.refused(), tries, "no extra write while refused");
  assert.equal(t.queue.length, 1, "one write still waiting");
  t.refuse(false);
  t.live.flush();
  assert.equal(songFromHash(t.writes.at(-1)!)?.bpm, 100);
});
