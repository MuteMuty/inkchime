// Inkchime's usage events (lab#71): when the lab's shared script may load (src/analytics.ts),
// and the allow-list and the once-per-page-load play events (src/analytics-events.ts).
// Nothing a visitor drew may ever be sent: no strokes, colours, pitches, tempo or song link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isProduction, optedOut, shouldLoad, SCRIPT } from "../../src/analytics.ts";
import { EVENTS, fromOf, playEvents, PROJECT } from "../../src/analytics-events.ts";
import { songFromHash, songToHash } from "../../src/core/share.ts";
import type { Song, Stroke } from "../../src/core/model.ts";

const line = (y: number): Stroke => ({ color: 2, size: 7, pts: [10, y, 600, y] });
const song = (...strokes: Stroke[]): Song => ({ bpm: 117, strokes });
const none = { nav: {}, win: {} };

test("the shared script comes from the hub, by its absolute address", () => {
  assert.equal(SCRIPT, "https://lab.brightloopapps.com/analytics/v1.js");
});

test("only *.brightloopapps.com counts as production", () => {
  assert.equal(isProduction("inkchime.brightloopapps.com"), true);
  assert.equal(isProduction("localhost"), false);
  assert.equal(isProduction("127.0.0.1"), false);
  assert.equal(isProduction("inkchime.erik.workers.dev"), false);
  assert.equal(isProduction("brightloopapps.com.example.org"), false);
  assert.equal(isProduction("evilbrightloopapps.com"), false);
});

test("Do Not Track (either spelling) and Global Privacy Control opt out", () => {
  assert.equal(optedOut({}, {}), false);
  assert.equal(optedOut({ doNotTrack: "1" }, {}), true);
  assert.equal(optedOut({ doNotTrack: "yes" }, {}), true);
  assert.equal(optedOut({}, { doNotTrack: "1" }), true);
  assert.equal(optedOut({ globalPrivacyControl: true }, {}), true);
  assert.equal(optedOut({ doNotTrack: "0", globalPrivacyControl: false }, { doNotTrack: null }), false);
});

test("the script loads only in production for a visitor who didn't opt out", () => {
  assert.equal(shouldLoad("inkchime.brightloopapps.com", none.nav, none.win), true);
  assert.equal(shouldLoad("localhost", none.nav, none.win), false);
  assert.equal(shouldLoad("inkchime.erik.workers.dev", none.nav, none.win), false);
  assert.equal(shouldLoad("inkchime.brightloopapps.com", { doNotTrack: "1" }, {}), false);
  assert.equal(shouldLoad("inkchime.brightloopapps.com", { globalPrivacyControl: true }, {}), false);
});

test("the allow-list: a pageview, and play started and finished with only where the page began", () => {
  assert.equal(PROJECT, "inkchime");
  assert.deepEqual(Object.keys(EVENTS).sort(), ["$pageview", "play_finished", "play_started"]);
  assert.deepEqual(EVENTS.$pageview, {});
  assert.deepEqual(EVENTS.play_started, { from: ["blank", "link"] });
  assert.deepEqual(EVENTS.play_finished, { from: ["blank", "link"] });
});

test("from: a song link with something on it is a link; no hash, a broken link or an empty canvas is blank", () => {
  assert.equal(fromOf(null), "blank");
  assert.equal(fromOf(songFromHash("#v1.AAAA")), "blank");
  assert.equal(fromOf(song()), "blank", "a link to an empty canvas (after Clear) opens an empty canvas");
  assert.equal(fromOf(song(line(100))), "link");
  assert.equal(fromOf(songFromHash(songToHash(song(line(100), line(700))))), "link");
});

test("play_started and play_finished go once each per page load, with only `from`", () => {
  for (const from of ["blank", "link"] as const) {
    const sent: [string, Record<string, unknown>][] = [];
    const plays = playEvents((name, props) => sent.push([name, props]), from);
    // Many strokes and notes, undo and clear, then Share, share again after more drawing.
    plays.started();
    plays.started();
    plays.finished();
    plays.started();
    plays.finished();
    assert.deepEqual(sent, [
      ["play_started", { from }],
      ["play_finished", { from }],
    ]);
    for (const [name, props] of sent) {
      const spec = EVENTS[name as keyof typeof EVENTS] as Record<string, readonly unknown[]>;
      for (const [k, v] of Object.entries(props)) assert.ok(spec[k]?.includes(v), `${name}.${k} = ${JSON.stringify(v)} isn't allow-listed`);
    }
  }
});

test("a sender that throws doesn't break drawing or Share, and the event still counts as sent", () => {
  let calls = 0;
  const plays = playEvents(() => {
    calls++;
    throw new Error("blocked");
  }, "blank");
  assert.doesNotThrow(() => plays.started());
  assert.doesNotThrow(() => plays.started());
  assert.doesNotThrow(() => plays.finished());
  assert.equal(calls, 2);
});
