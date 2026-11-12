import { test } from "node:test";
import assert from "node:assert/strict";
import { History } from "../../src/core/history.ts";

test("undo steps back through changes, one at a time", () => {
  const h = new History<string[]>([]);
  h.set(["a"]);
  h.set(["a", "b"]);
  assert.equal(h.canUndo, true);
  assert.equal(h.undo(), true);
  assert.deepEqual(h.value, ["a"]);
  assert.equal(h.undo(), true);
  assert.deepEqual(h.value, []);
  assert.equal(h.canUndo, false);
  assert.equal(h.undo(), false);
  assert.deepEqual(h.value, []);
});

test("clearing is undoable", () => {
  const h = new History<string[]>(["a", "b"]);
  h.set([]);
  h.undo();
  assert.deepEqual(h.value, ["a", "b"]);
});

test("loading a song resets the history", () => {
  const h = new History<string[]>([]);
  h.set(["a"]);
  h.reset(["x", "y"]);
  assert.deepEqual(h.value, ["x", "y"]);
  assert.equal(h.canUndo, false);
});

test("history is capped so it cannot grow without bound", () => {
  const h = new History<number>(0, 5);
  for (let i = 1; i <= 50; i++) h.set(i);
  let n = 0;
  while (h.undo()) n++;
  assert.equal(n, 5);
});
