import { test } from "node:test";
import assert from "node:assert/strict";
import { canAddStroke, MAX_STROKES, MAX_PAYLOAD_CHARS, type Stroke } from "../../src/core/model.ts";
import { History } from "../../src/core/history.ts";

const stroke: Stroke = { color: 0, size: 4, pts: [10, 10, 200, 10] };

test("a stroke can be added until the song holds MAX_STROKES, and not after", () => {
  assert.equal(canAddStroke(0), true);
  assert.equal(canAddStroke(MAX_STROKES - 1), true);
  assert.equal(canAddStroke(MAX_STROKES), false);
  assert.equal(canAddStroke(MAX_STROKES + 51), false);
});

test("drawing 401 strokes through the guard leaves exactly MAX_STROKES", () => {
  const edits = new History<readonly Stroke[]>([]);
  let blocked = 0;
  for (let i = 0; i < MAX_STROKES + 1; i++) {
    if (!canAddStroke(edits.value.length)) {
      blocked++;
      continue;
    }
    edits.set([...edits.value, stroke]);
  }
  assert.equal(edits.value.length, MAX_STROKES);
  assert.equal(blocked, 1);
  // Undoing frees a slot again.
  edits.undo();
  assert.equal(canAddStroke(edits.value.length), true);
});

test("the limits are sane", () => {
  assert.equal(MAX_STROKES, 400);
  assert.equal(MAX_PAYLOAD_CHARS, 120_000);
});
