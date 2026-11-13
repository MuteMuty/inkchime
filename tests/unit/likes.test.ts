import { test } from "node:test";
import assert from "node:assert/strict";
import { LIKE_KEY, Likes, likeLabel, shortCount, type LikeState, type LikeStore } from "../../src/core/likes.ts";

const API = "https://lab.brightloopapps.com";
const RECEIPT = "0123456789abcdef0123456789abcdef";

function memoryStorage(init: Record<string, string> = {}): LikeStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}
const deniedStorage = (): LikeStore => ({
  getItem() { throw new Error("denied"); },
  setItem() { throw new Error("denied"); },
  removeItem() { throw new Error("denied"); },
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const counts = (total: number) => () => json(200, { inkchime: { total, week: 1 }, afterstep: { total: 40, week: 9 } });
/** Never answers on its own: only the timeout ends it. */
const slow = (_url: string, init: RequestInit) =>
  new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError"))));

type Answer = (url: string, init: RequestInit) => Response | Promise<Response>;
interface Call { url: string; method: string; init: RequestInit }

/** A fake fetch that answers from a queue and records every request. */
function fakeFetch(answers: Answer[]) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", init });
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected request ${init.method ?? "GET"} ${url}`);
    return answer(url, init);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

function setup({ storage = memoryStorage() as LikeStore | null, answers = [] as Answer[], timeoutMs = 6000 } = {}) {
  const { fetch, calls } = fakeFetch(answers);
  const seen: LikeState[] = [];
  const notes: string[] = [];
  const likes = new Likes({
    fetch,
    storage,
    api: API,
    timeoutMs,
    onChange: (s) => seen.push({ ...s }),
    onNote: (text) => notes.push(text),
  });
  return { likes, calls, seen, notes, storage };
}
const view = (s: LikeState) => ({ liked: s.liked, count: s.count });

// --- loading the count ---------------------------------------------------------

test("load: asks quietly for the counts, without cookies, and shows Inkchime's total", async () => {
  const { likes, calls, seen } = setup({ answers: [counts(12)] });
  assert.equal(likes.state.ready, false);
  await likes.load();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API}/api/likes?quiet=1`);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].init.credentials, "omit");
  assert.deepEqual(likes.state, { ready: true, liked: false, count: 12, busy: false });
  assert.equal(seen.length, 1);
});

test("load: stays hidden and silent on 204 (likes resting), 503, a network error, junk or a missing project", async () => {
  const answers: Answer[] = [
    () => new Response(null, { status: 204 }),
    () => json(503, { error: "Likes are resting right now." }),
    () => { throw new TypeError("Failed to fetch"); },
    () => new Response("not json", { status: 200 }),
    () => json(200, ["nope"]),
    () => json(200, null),
    () => json(200, { afterstep: { total: 40, week: 9 } }),
    () => json(200, { inkchime: { total: "12" } }),
    () => json(200, { inkchime: { total: -3 } }),
    () => json(200, { inkchime: { total: 1.5 } }),
  ];
  for (const answer of answers) {
    const { likes, seen, notes } = setup({ answers: [answer] });
    await likes.load();
    assert.equal(likes.state.ready, false, String(answer));
    assert.equal(seen.length, 0, "a hidden heart is never drawn");
    assert.equal(notes.length, 0, "nothing is said while the heart is hidden");
  }
});

test("load: gives up on a slow API and stays hidden", async () => {
  const { likes, seen } = setup({ answers: [slow], timeoutMs: 20 });
  await likes.load();
  assert.equal(likes.state.ready, false);
  assert.equal(seen.length, 0);
});

test("load: a stored like shows as pressed, and never below 1", async () => {
  const storage = memoryStorage({ [LIKE_KEY]: JSON.stringify({ liked: true, receipt: RECEIPT }) });
  const { likes } = setup({ storage, answers: [counts(0)] });
  await likes.load();
  assert.deepEqual(view(likes.state), { liked: true, count: 1 });
});

test("load: stored junk reads as not liked", async () => {
  for (const raw of ["not json", "null", "[]", "{}", JSON.stringify({ liked: true }), JSON.stringify({ liked: false, receipt: RECEIPT }), JSON.stringify({ liked: true, receipt: "short" }), JSON.stringify({ liked: true, receipt: RECEIPT.toUpperCase() })]) {
    const { likes } = setup({ storage: memoryStorage({ [LIKE_KEY]: raw }), answers: [counts(2)] });
    await likes.load();
    assert.equal(likes.state.liked, false, raw);
  }
});

// --- liking and unliking ----------------------------------------------------------

test("toggle: does nothing before the counts load", async () => {
  const { likes, calls, seen } = setup();
  await likes.toggle();
  assert.equal(calls.length, 0);
  assert.equal(seen.length, 0);
});

test("toggle: a like shows at once, stores the receipt and settles on the server's count", async () => {
  let answer!: (r: Response) => void;
  const { likes, calls, storage } = setup({ answers: [counts(12), () => new Promise((r) => (answer = r))] });
  await likes.load();
  const done = likes.toggle();
  assert.deepEqual(likes.state, { ready: true, liked: true, count: 13, busy: true });
  assert.equal(calls[1].url, `${API}/api/likes/inkchime`);
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].init.credentials, "omit");
  answer(json(200, { receipt: RECEIPT, total: 15, week: 4 }));
  await done;
  assert.deepEqual(likes.state, { ready: true, liked: true, count: 15, busy: false });
  assert.deepEqual(JSON.parse(storage!.getItem(LIKE_KEY)!), { liked: true, receipt: RECEIPT });
});

test("toggle: a like survives a reload, and unliking on a later day sends the stored receipt", async () => {
  const storage = memoryStorage();
  const first = setup({ storage, answers: [counts(12), () => json(200, { receipt: RECEIPT, total: 13, week: 13 })] });
  await first.likes.load();
  await first.likes.toggle();

  // A reload, any day later: the receipt carries no date.
  const again = setup({ storage, answers: [counts(13), () => json(200, { ok: true, total: 12, week: 0 })] });
  await again.likes.load();
  assert.deepEqual(view(again.likes.state), { liked: true, count: 13 });
  const done = again.likes.toggle();
  assert.deepEqual(view(again.likes.state), { liked: false, count: 12 }, "unliking shows at once too");
  await done;
  const del = again.calls[1];
  assert.equal(del.method, "DELETE");
  assert.equal(del.url, `${API}/api/likes/inkchime`);
  assert.equal(del.init.credentials, "omit");
  assert.equal((del.init.headers as Record<string, string>)["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(del.init.body)), { receipt: RECEIPT });
  assert.equal(storage.getItem(LIKE_KEY), null, "the receipt is forgotten");
  assert.deepEqual(again.likes.state, { ready: true, liked: false, count: 12, busy: false });
  assert.deepEqual(again.notes, []);
});

test("toggle: unliking a like the server no longer has (404) still unlikes here, quietly", async () => {
  const storage = memoryStorage({ [LIKE_KEY]: JSON.stringify({ liked: true, receipt: RECEIPT }) });
  const { likes, notes } = setup({ storage, answers: [counts(5), () => json(404, { error: "That like wasn't found.", total: 4, week: 0 })] });
  await likes.load();
  await likes.toggle();
  assert.deepEqual(view(likes.state), { liked: false, count: 4 });
  assert.equal(storage.getItem(LIKE_KEY), null);
  assert.deepEqual(notes, []);
});

test("toggle: 409 (this network liked it today) rolls back, takes the server's count and says so politely", async () => {
  const { likes, storage, notes } = setup({ answers: [counts(12), () => json(409, { error: "This network already liked it today.", total: 14, week: 2 })] });
  await likes.load();
  await likes.toggle();
  assert.deepEqual(likes.state, { ready: true, liked: false, count: 14, busy: false });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /already liked Inkchime today/);
  assert.match(notes[0], /Thank you/);
  assert.equal(storage!.getItem(LIKE_KEY), null);
});

test("toggle: 429 rolls back a like or an unlike, keeps the receipt and asks to try again in a minute", async () => {
  const like = setup({ answers: [counts(12), () => json(429, { error: "That's a lot of likes. Try again in a minute." })] });
  await like.likes.load();
  await like.likes.toggle();
  assert.deepEqual(view(like.likes.state), { liked: false, count: 12 });
  assert.match(like.notes[0], /Try again in a minute/);

  const storage = memoryStorage({ [LIKE_KEY]: JSON.stringify({ liked: true, receipt: RECEIPT }) });
  const unlike = setup({ storage, answers: [counts(12), () => json(429, {})] });
  await unlike.likes.load();
  await unlike.likes.toggle();
  assert.deepEqual(view(unlike.likes.state), { liked: true, count: 12 });
  assert.match(unlike.notes[0], /Try again in a minute/);
  assert.deepEqual(JSON.parse(storage.getItem(LIKE_KEY)!), { liked: true, receipt: RECEIPT });
});

test("toggle: a like that fails (503, offline, slow, no receipt) rolls back to the last count with a short note", async () => {
  const fails: Answer[] = [
    () => json(503, { error: "Likes are resting right now." }),
    () => { throw new TypeError("Failed to fetch"); },
    slow,
    () => json(200, { ok: true }),
    () => new Response("oops", { status: 500 }),
  ];
  for (const fail of fails) {
    const { likes, notes, storage } = setup({ answers: [counts(12), fail], timeoutMs: 20 });
    await likes.load();
    await likes.toggle();
    assert.deepEqual(likes.state, { ready: true, liked: false, count: 12, busy: false }, String(fail));
    assert.equal(notes.length, 1);
    assert.match(notes[0], /didn't go through/);
    assert.equal(storage!.getItem(LIKE_KEY), null);
  }
});

test("toggle: a press while one is on its way does nothing", async () => {
  let answer!: (r: Response) => void;
  const { likes, calls } = setup({ answers: [counts(1), () => new Promise((r) => (answer = r))] });
  await likes.load();
  const first = likes.toggle();
  await likes.toggle();
  await likes.toggle();
  assert.equal(calls.length, 2);
  answer(json(200, { receipt: RECEIPT, total: 2, week: 2 }));
  await first;
  assert.deepEqual(view(likes.state), { liked: true, count: 2 });
});

test("toggle: every change is drawn, busy while on its way", async () => {
  const { likes, seen } = setup({ answers: [counts(3), () => json(200, { receipt: RECEIPT, total: 4, week: 4 })] });
  await likes.load();
  await likes.toggle();
  assert.deepEqual(seen.map((s) => [s.liked, s.count, s.busy]), [[false, 3, false], [true, 4, true], [true, 4, false]]);
});

test("toggle: storage that can't be used still likes and unlikes within this page", async () => {
  const { likes, calls } = setup({
    storage: deniedStorage(),
    answers: [counts(3), () => json(200, { receipt: RECEIPT, total: 4, week: 4 }), () => json(200, { ok: true, total: 3, week: 3 })],
  });
  await likes.load();
  assert.equal(likes.state.liked, false);
  await likes.toggle();
  assert.equal(likes.state.liked, true);
  await likes.toggle();
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { receipt: RECEIPT });
  assert.equal(likes.state.liked, false);
});

test("toggle: no storage at all works the same", async () => {
  const { likes } = setup({ storage: null, answers: [counts(3), () => json(200, { receipt: RECEIPT, total: 4, week: 4 })] });
  await likes.load();
  await likes.toggle();
  assert.deepEqual(view(likes.state), { liked: true, count: 4 });
});

// --- the label ------------------------------------------------------------------------

test("likeLabel: names Inkchime and the count", () => {
  assert.equal(likeLabel(12), "Like Inkchime, 12 likes");
  assert.equal(likeLabel(1), "Like Inkchime, 1 like");
  assert.equal(likeLabel(0), "Like Inkchime, 0 likes");
});

test("shortCount: up to 999 as it is, then short, never rounding up past the real count", () => {
  assert.deepEqual([0, 1, 12, 999].map(shortCount), ["0", "1", "12", "999"]);
  assert.deepEqual([1000, 1049, 1250, 1999, 9999].map(shortCount), ["1k", "1k", "1.2k", "1.9k", "9.9k"]);
  assert.deepEqual([10000, 12345, 999999].map(shortCount), ["10k", "12k", "999k"]);
  assert.deepEqual([1000000, 2500000].map(shortCount), ["1M", "2.5M"]);
});
