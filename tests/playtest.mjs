// Inkchime playtest: draws, plays, shares and reopens songs in a real browser, at
// desktop-dark (1280x900) and phone-light (390x844) sizes, and a phone held sideways (844x390, 667x375, 568x320).
//
// Headless browsers can't be heard, so sound is checked through the read-only
// hook the page exposes, `window.__inkchime`: it lists every note handed to
// Web Audio (with its exact audio-clock start time), plus the schedule the
// strokes should produce.
//
// Usage: node tests/playtest.mjs <baseUrl>
// Env:   PLAYTEST_BROWSER  Chromium-based browser executable (default: Brave)
//        PLAYTEST_OUT      screenshot folder (default: ./playtest-out)
// Exit:  0 = pass, 1 = fail (reasons printed)
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import assert from "node:assert/strict";

const base = process.argv[2];
if (!base) {
  console.error("usage: node tests/playtest.mjs <baseUrl>");
  process.exit(2);
}
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.PLAYTEST_OUT || join(repo, "playtest-out");
const browserPath = process.env.PLAYTEST_BROWSER || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
mkdirSync(out, { recursive: true });

const failures = [];
const fail = (msg) => failures.push(msg);
/** Run one named check; a thrown assertion becomes a failure line instead of ending the run. */
async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    fail(`${name}: ${String(e.message).split("\n")[0]}`);
  }
}

// The spec, written out again here so the page can't mark its own homework.
const PENTATONIC = [0, 2, 4, 7, 9];
const rowCentre = (row) => (row + 0.5) / 15; // fraction of canvas height
const expectedMidi = (row) => {
  const degree = 14 - row;
  return 48 + 12 * Math.floor(degree / 5) + PENTATONIC[degree % 5];
};
const expectedGain = (size) => Math.min(1, 0.12 + 0.88 * ((size - 1) / 7) ** 1.3);
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// --- helpers -----------------------------------------------------------------

const hook = {
  song: (page) => page.evaluate(() => window.__inkchime.song()),
  schedule: (page) => page.evaluate(() => window.__inkchime.schedule()),
  events: (page) => page.evaluate(() => window.__inkchime.events()),
  state: (page) => page.evaluate(() => window.__inkchime.state()),
};

// Every page talks to a mocked lab like API, never the live one, and may only ask
// Inkchime's own origin and lab.brightloopapps.com/api/likes.
const LAB = "https://lab.brightloopapps.com";
const LIKE_KEY = "inkchime:like";

/**
 * A stateful stand-in for the hub's /api/likes. `mode`: "ok"; "resting" (what the live
 * hub answers until its migration: 204 to a quiet GET, 503 otherwise); "down"
 * (unreachable); "slow" (answers after 8 s, past the page's 6 s timeout). `next`
 * forces the status of the next POST or DELETE (409, 429); `delay` holds each one.
 */
async function mockLikes(context, opts = {}) {
  const api = { mode: "ok", total: 12, delay: 0, next: null, receipts: [], calls: [], ...opts };
  const origin = new URL(base).origin;
  await context.route(`${LAB}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const cors = { "access-control-allow-origin": origin, vary: "Origin", "cache-control": "no-store" };
    const send = (status, body) =>
      route.fulfill({ status, headers: cors, contentType: "application/json", body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => {});
    api.calls.push({ method, path: url.pathname + url.search, body: req.postData(), cookie: req.headers().cookie });
    if (method === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-methods": "POST, DELETE", "access-control-allow-headers": "content-type" } }).catch(() => {});
    }
    if (api.mode === "down") return route.abort("failed").catch(() => {});
    if (api.mode === "slow") return void setTimeout(() => send(200, { inkchime: { total: api.total, week: 1 } }), 8000);
    if (api.mode === "resting") {
      if (method === "GET" && url.searchParams.has("quiet")) return route.fulfill({ status: 204, headers: cors }).catch(() => {});
      return send(503, { error: "Likes are resting right now. Try again later." });
    }
    const counts = () => ({ total: api.total, week: 3 });
    if (method === "GET" && url.pathname === "/api/likes") return send(200, { inkchime: counts(), afterstep: { total: 40, week: 9 } });
    if (url.pathname !== "/api/likes/inkchime") return send(404, { error: "Unknown project." });
    if (api.delay) await new Promise((r) => setTimeout(r, api.delay));
    const forced = api.next;
    api.next = null;
    if (forced === 429) return send(429, { error: "That's a lot of likes. Try again in a minute." });
    if (method === "POST") {
      if (forced === 409) return send(409, { error: "This network already liked it today.", ...counts() });
      const receipt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      api.receipts.push(receipt);
      api.total++;
      return send(200, { receipt, ...counts() });
    }
    if (method === "DELETE") {
      const { receipt } = JSON.parse(req.postData() || "{}");
      if (!api.receipts.includes(receipt)) return send(404, { error: "That like wasn't found.", ...counts() });
      api.receipts = api.receipts.filter((r) => r !== receipt);
      api.total--;
      return send(200, { ok: true, ...counts() });
    }
    return send(405, { error: "Use POST or DELETE." });
  });
  return api;
}

/**
 * `likes` sets up the mocked like API (working, 12 likes, unless it says otherwise),
 * `init` runs in the page before its own scripts, and `waitUntil` is when loading counts as done.
 */
async function openPage(browser, name, ctxOptions, url = base, { likes = {}, init, waitUntil = "networkidle" } = {}) {
  const context = await browser.newContext({ ...ctxOptions, permissions: ["clipboard-read", "clipboard-write"] });
  const api = await mockLikes(context, likes);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.likes = api;
  const own = new URL(base).origin;
  // The only console errors allowed are the browser's own network lines: for the 409 and 429
  // answers a likes check asks for, and for an unreachable like API. Never one from page code.
  const browserLine = (text) =>
    (api.expectRefusals && /status of (409|429)/.test(text)) || (api.mode === "down" && /^Failed to load resource: net::ERR_FAILED$/.test(text));
  page.on("console", (m) => m.type() === "error" && !browserLine(m.text()) && fail(`${name}: console error: ${m.text()}`));
  page.on("pageerror", (e) => fail(`${name}: page error: ${e.message}`));
  page.on("request", (r) => {
    const u = r.url();
    if (u.startsWith("data:") || u.startsWith("blob:") || new URL(u).origin === own || u.startsWith(`${LAB}/api/likes`)) return;
    fail(`${name}: request to somewhere other than Inkchime and the like API: ${u}`);
  });
  page.on("requestfailed", (r) => {
    const why = r.failure()?.errorText ?? "";
    // The browser fetches the tab icon lazily; reloading the page (the live-link check does) cancels that fetch. Not a page error.
    if (why === "net::ERR_ABORTED" && new URL(r.url()).pathname === "/favicon.svg") return;
    // An unreachable or slow like API is what those checks ask for (the page gives up on a slow one).
    if (r.url().startsWith(`${LAB}/api/likes`) && (api.mode === "down" || api.mode === "slow")) return;
    fail(`${name}: request failed: ${r.url()} (${why})`);
  });
  const res = await page.goto(url, { waitUntil }).catch((e) => fail(`${name}: could not load ${url}: ${e.message}`));
  if (!res) return { page, context, ok: false };
  const ok = !!(await page.waitForSelector("#canvas-wrap canvas", { state: "attached", timeout: 8000 }).catch(() => null));
  if (!ok) fail(`${name}: canvas never rendered`);
  return { page, context, ok };
}

/** Drag a horizontal line across the canvas, between two x fractions at height fraction y. */
async function drawLine(page, x0, x1, y) {
  const box = await page.locator("#canvas-wrap").boundingBox();
  const py = box.y + y * box.height;
  await page.mouse.move(box.x + x0 * box.width, py);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) await page.mouse.move(box.x + (x0 + ((x1 - x0) * i) / 14) * box.width, py);
  await page.mouse.up();
}

const pickColour = (page, name) => page.locator("label.voice", { hasText: name }).click();
const setSize = (page, v) => page.locator("#size").fill(String(v));
const setTempo = (page, v) => page.locator("#tempo").fill(String(v));
const toastShown = (page) => page.locator("#toast").evaluate((el) => el.classList.contains("show"));
const press = (page, how, sel) => (how === "tap" ? page.locator(sel).tap() : page.locator(sel).click());
/** The "press play" invite a song link opens with (filled a frame after load). */
const invitePill = (page) => page.locator("#invite .invite-pill");
const inviteShown = (page) => invitePill(page).waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false);
/** No invite now, and none still to come: it is filled a frame after load, so give it a moment first. */
async function noInvite(page, why) {
  await page.waitForTimeout(150);
  assert.equal(await invitePill(page).isVisible(), false, `the play invite shows ${why}`);
  assert.equal(await page.locator("#play").getAttribute("aria-describedby"), null, `Play is described by the invite ${why}`);
}
const inviteGone = (page, after) =>
  invitePill(page)
    .waitFor({ state: "hidden", timeout: 2000 })
    .catch(() => {
      throw new Error(`the play invite is still showing after ${after}`);
    });

async function noHorizontalOverflow(page, name, when) {
  const r = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
    offenders: [...document.querySelectorAll("body *")]
      .filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && (b.right > window.innerWidth + 0.5 || b.left < -0.5) && !el.closest(".toast") && !el.closest(".sr-only");
      })
      .map((el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "")),
  }));
  if (r.doc > r.view) fail(`${name}: page is ${r.doc}px wide in a ${r.view}px window (${when})`);
  if (r.offenders.length) fail(`${name}: elements outside the window (${when}): ${r.offenders.join(", ")}`);
}

/** Scribble a long wavy line and return the sorted frame times (ms) seen while drawing it. */
async function drawWave(page) {
  await page.evaluate(() => {
    window.__frames = [];
    window.__frameStop = false;
    let last = performance.now();
    const tick = (t) => {
      window.__frames.push(t - last);
      last = t;
      if (!window.__frameStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const box = await page.locator("#canvas-wrap").boundingBox();
  await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 240; i++) {
    await page.mouse.move(box.x + box.width * (0.05 + (0.9 * i) / 240), box.y + box.height * (0.5 + 0.35 * Math.sin(i / 9)));
  }
  await page.mouse.up();
  const frames = await page.evaluate(() => ((window.__frameStop = true), window.__frames.slice(2)));
  return frames.sort((a, b) => a - b);
}
const percentile = (sorted, p) => sorted[Math.floor(sorted.length * p)];

/** Wait until every note of the schedule has been handed to Web Audio at least once. */
function allNotesScheduled(page, timeout = 12000) {
  return page.waitForFunction(
    () => {
      const want = window.__inkchime.schedule();
      const got = window.__inkchime.events();
      return want.length > 0 && want.every((n) => got.some((e) => e.step === n.step && e.midi === n.midi && e.voice === n.voice));
    },
    null,
    { timeout, polling: 50 },
  );
}

/** What a page sounds like: every distinct note of the loop, as plain comparable text. */
async function noteSignature(page, from = 0) {
  const events = (await hook.events(page)).slice(from);
  return [...new Set(events.map((e) => `${e.loopTime.toFixed(6)}|${e.midi}|${e.gain.toFixed(6)}|${e.voice}`))].sort();
}

/** Check every scheduled note against the spec: column time, pitch from height, gain from thickness. */
function checkEvents(name, events, state, want) {
  assert.ok(events.length > 0, `${name}: no notes were scheduled`);
  const stepSec = state.loopSeconds / 32;
  for (const e of events) {
    assert.ok(near(e.loopTime, e.step * stepSec, 1e-6), `${name}: note in column ${e.step} has loopTime ${e.loopTime}`);
    // Position in the audio clock: (when - loop origin) is the loop time, modulo whole loops.
    const phase = (((e.when - state.origin) % state.loopSeconds) + state.loopSeconds) % state.loopSeconds;
    const off = Math.min(Math.abs(phase - e.loopTime), state.loopSeconds - Math.abs(phase - e.loopTime));
    assert.ok(off < 0.001, `${name}: note for column ${e.step} is scheduled ${(off * 1000).toFixed(2)} ms off its place in the loop`);
    assert.ok(PENTATONIC.includes(e.midi % 12), `${name}: midi ${e.midi} is not on the pentatonic scale`);
    if (want.midi !== undefined) assert.equal(e.midi, want.midi, `${name}: pitch from height`);
    if (want.gain !== undefined) assert.ok(near(e.gain, want.gain, 1e-9), `${name}: gain ${e.gain}, wanted ${want.gain}`);
    if (want.voice !== undefined) assert.equal(e.voice, want.voice, `${name}: voice from colour`);
    if (want.steps) assert.ok(e.step >= want.steps[0] && e.step <= want.steps[1], `${name}: column ${e.step} is outside the stroke`);
  }
}

// --- one full session at a given size ------------------------------------------

async function session(browser, name, viewport, colorScheme, phone) {
  const ctxOptions = phone
    ? { viewport, colorScheme, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
    : { viewport, colorScheme };
  const tapOrClick = phone ? "tap" : "click";
  const { page, context, ok } = await openPage(browser, name, ctxOptions);
  if (!ok) return context.close();

  // First look: an empty canvas that explains itself, nothing overflowing.
  await check(`${name} empty state`, async () => {
    assert.equal((await hook.song(page)).strokes.length, 0);
    assert.ok(await page.locator("#hint").isVisible(), "hint is hidden");
    assert.match(await page.locator("#hint").innerText(), /Height is pitch/);
    assert.equal(await page.locator("input[name=voice]").count() >= 3, true, "need at least 3 colours");
    const names = await page.locator(".voice .name").allInnerTexts();
    assert.ok(new Set(names).size === names.length && names.length >= 3, "each colour should name a different instrument");
    assert.match(await page.locator("footer").innerText(), /^Made by Erik Pahor at BrightLoop Lab$/);
    await noInvite(page, "on a normal visit");
  });
  await noHorizontalOverflow(page, name, "empty");
  await page.screenshot({ path: join(out, `${name}-empty.png`) });

  // Keyboard: Tab reaches the canvas and every control, in order, each with a visible focus ring.
  await check(`${name} tab order`, async () => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const seen = [];
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press("Tab");
      seen.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          const ringEl = el.matches('input[type="radio"]') ? el.nextElementSibling : el;
          const cs = getComputedStyle(ringEl);
          const visible = el.matches(":focus-visible") && cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
          return `${el.id || "voice"}${visible ? "" : " (no ring)"}`;
        }),
      );
    }
    assert.equal(seen.join(" > "), "canvas-wrap > voice > play > undo > clear > share > size > tempo > like", `tab order was ${seen.join(" > ")}`);
    assert.ok(!seen.some((s) => s.includes("no ring")), `a focused control has no visible ring: ${seen.join(", ")}`);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
  });

  // Drawing stays smooth: scribble a long wavy line and watch the frame times.
  await check(`${name} drawing frame rate`, async () => {
    const frames = await drawWave(page);
    const p50 = percentile(frames, 0.5);
    const p95 = percentile(frames, 0.95);
    console.log(`${name}: ${frames.length} frames while drawing, median ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
    assert.ok(p50 < 20, `median frame time was ${p50.toFixed(1)} ms while drawing`);
    assert.equal((await hook.song(page)).strokes.length, 1);
    await page.keyboard.press("Control+z");
    assert.equal((await hook.song(page)).strokes.length, 0);
  });

  // Stroke A: pluck, size 6, a flat line in row 6 across the first third of the loop.
  const rowA = 6;
  await pickColour(page, "Pluck");
  await setSize(page, 6);
  await drawLine(page, 0.01, 0.3, rowCentre(rowA));
  const songA = await hook.song(page);
  await check(`${name} drawing a stroke`, async () => {
    assert.equal(songA.strokes.length, 1, "stroke was not added");
    assert.equal(songA.strokes[0].color, 1);
    assert.equal(songA.strokes[0].size, 6);
    assert.ok(songA.strokes[0].pts.length >= 4);
    assert.equal(await page.locator("#hint").evaluate((el) => el.classList.contains("gone")), true, "hint should fade out");
    assert.equal(await page.locator("#undo").getAttribute("aria-disabled"), "false");
  });
  const xs = songA.strokes[0].pts.filter((_, i) => i % 2 === 0);
  const stepRange = [Math.floor((Math.min(...xs) * 32) / 1024), Math.floor((Math.max(...xs) * 32) / 1024)];
  await check(`${name} schedule matches the stroke`, async () => {
    const sched = await hook.schedule(page);
    assert.ok(sched.length >= 8, `expected a note per column, got ${sched.length}`);
    assert.equal(stepRange[0], 0);
    assert.deepEqual(new Set(sched.map((n) => n.step)).size, stepRange[1] - stepRange[0] + 1);
    for (const n of sched) {
      assert.equal(n.midi, expectedMidi(rowA), "pitch from height");
      assert.ok(near(n.gain, expectedGain(6), 1e-9), "gain from thickness");
      assert.equal(n.voice, 1, "voice from colour");
    }
  });
  await noHorizontalOverflow(page, name, "drawn");

  // Play: the first sound lands within ~100 ms, and every note is scheduled at its place in the loop.
  await page.evaluate(() => {
    document.addEventListener("click", () => (window.__t0 = window.__inkchime.state().time), { capture: true, once: true });
  });
  await press(page, tapOrClick, "#play");
  await check(`${name} audio starts`, async () => {
    await page.waitForFunction(() => window.__inkchime.state().audio === "running", null, { timeout: 5000 });
    assert.equal((await page.locator("#play-label").innerText()), "Pause");
    assert.equal(await toastShown(page), false, "no toast when there is something to play");
  });
  await check(`${name} playing schedules the stroke's notes`, async () => {
    await allNotesScheduled(page);
    const state = await hook.state(page);
    assert.equal(state.playing, true);
    checkEvents(name, await hook.events(page), state, { midi: expectedMidi(rowA), gain: expectedGain(6), voice: 1, steps: stepRange });
  });
  await check(`${name} first sound is quick`, async () => {
    const [events, t0] = await Promise.all([hook.events(page), page.evaluate(() => window.__t0)]);
    assert.ok(typeof t0 === "number", "no gesture time recorded");
    const delay = events[0].when - t0;
    assert.ok(delay < 0.12, `first note was ${(delay * 1000).toFixed(0)} ms after the press`);
  });
  await check(`${name} playhead moves`, async () => {
    const x1 = (await page.locator("#playhead").boundingBox()).x;
    await page.waitForTimeout(300);
    const x2 = (await page.locator("#playhead").boundingBox()).x;
    assert.ok(x2 > x1 || x2 < x1 - 100, `playhead stayed at ${x1}`); // or wrapped around
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out, `${name}-playing.png`) });
  await noHorizontalOverflow(page, name, "playing");

  // Keyboard: Space toggles play; Space on a focused button presses that button instead.
  await check(`${name} space toggles play`, async () => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press("Space");
    assert.equal((await hook.state(page)).playing, false, "Space should pause");
    assert.equal(await page.locator("#play-label").innerText(), "Play");
    await page.keyboard.press("Space");
    assert.equal((await hook.state(page)).playing, true, "Space should play again");
    await page.keyboard.press("Space");
    assert.equal((await hook.state(page)).playing, false);
  });

  // Stroke B: bell, size 2, row 3. Its sound must be quieter and a different voice.
  await pickColour(page, "Bell");
  await setSize(page, 2);
  await drawLine(page, 0.5, 0.8, rowCentre(3));
  await check(`${name} second stroke`, async () => {
    const sched = await hook.schedule(page);
    const bell = sched.filter((n) => n.voice === 0);
    const pluck = sched.filter((n) => n.voice === 1);
    assert.ok(bell.length && pluck.length);
    assert.ok(bell.every((n) => n.midi === expectedMidi(3) && near(n.gain, expectedGain(2), 1e-9)));
    assert.ok(bell[0].gain < pluck[0].gain, "thinner should be quieter");
    assert.ok(expectedMidi(3) > expectedMidi(rowA), "higher on the canvas should be higher in pitch");
  });

  await check(`${name} space on a focused button presses it, not play`, async () => {
    await page.locator("#undo").focus();
    await page.keyboard.press("Space");
    assert.equal((await hook.song(page)).strokes.length, 1, "Undo did not run");
    assert.equal((await hook.state(page)).playing, false, "Space on Undo started playback");
  });

  await check(`${name} undo shortcuts`, async () => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press("Control+z");
    assert.equal((await hook.song(page)).strokes.length, 0, "Ctrl+Z should undo");
    await drawLine(page, 0.4, 0.6, 0.5);
    assert.equal((await hook.song(page)).strokes.length, 1);
    await page.keyboard.press("Meta+z");
    assert.equal((await hook.song(page)).strokes.length, 0, "Cmd+Z should undo");
    assert.equal(await page.locator("#undo").getAttribute("aria-disabled"), "true");
  });

  await check(`${name} clear can be undone`, async () => {
    await drawLine(page, 0.2, 0.4, 0.3);
    await drawLine(page, 0.5, 0.7, 0.6);
    await page.locator("#clear").click();
    assert.equal((await hook.song(page)).strokes.length, 0);
    await page.keyboard.press("Control+z");
    assert.equal((await hook.song(page)).strokes.length, 2, "undo after clear should bring the strokes back");
    await page.locator("#clear").click();
    await page.locator("#hint").waitFor({ state: "visible" });
  });

  // The song to share: two strokes, two voices, two sizes, a faster tempo.
  await pickColour(page, "Pad");
  await setSize(page, 8);
  await drawLine(page, 0.05, 0.35, rowCentre(10));
  await pickColour(page, "Tap");
  await setSize(page, 3);
  await drawLine(page, 0.4, 0.95, rowCentre(2));
  await setTempo(page, 120);

  // Share: the link holds the whole song. A fresh page reproduces the same strokes and schedule.
  const original = { song: await hook.song(page), schedule: await hook.schedule(page) };
  let shareUrl = "";
  await check(`${name} share`, async () => {
    await press(page, tapOrClick, "#share");
    await page.waitForFunction(() => location.hash.startsWith("#v1."), null, { timeout: 3000 });
    shareUrl = page.url();
    assert.ok(shareUrl.includes("#v1."), `share url is ${shareUrl}`);
    assert.ok(shareUrl.length < 1500, `share url is ${shareUrl.length} characters`);
    await page.waitForFunction(() => document.querySelector("#toast").textContent.length > 0, null, { timeout: 3000 }).catch(() => {
      throw new Error("no confirmation toast after Share");
    });
  });
  await page.screenshot({ path: join(out, `${name}-shared.png`) });

  // Hear the original: play one loop and record what it sounds like.
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  const mark = (await hook.events(page)).length;
  await page.keyboard.press("Space");
  await check(`${name} original plays`, async () => {
    await allNotesScheduled(page);
    const state = await hook.state(page);
    assert.equal(state.bpm, 120);
    checkEvents(name, (await hook.events(page)).slice(mark), state, {});
  });
  const originalSound = await noteSignature(page, mark);
  await page.keyboard.press("Space");

  if (shareUrl) {
    const fresh = await openPage(browser, `${name} (opened link)`, ctxOptions, shareUrl);
    if (fresh.ok) {
      await check(`${name} link reproduces the song`, async () => {
        const song = await hook.song(fresh.page);
        assert.deepEqual(song, original.song, "strokes, colours, sizes or tempo differ");
        assert.deepEqual(await hook.schedule(fresh.page), original.schedule, "note schedule differs");
        assert.equal(await fresh.page.locator("#tempo").inputValue(), "120");
        assert.equal(await fresh.page.locator("#hint").evaluate((el) => el.classList.contains("gone")), true);
      });
      await fresh.page.screenshot({ path: join(out, `${name}-opened-link.png`) });
      await check(`${name} link plays the same notes`, async () => {
        await fresh.page.keyboard.press("Space");
        await inviteGone(fresh.page, "Space started the song");
        assert.equal(await toastShown(fresh.page), false, "no toast when a shared song plays");
        await allNotesScheduled(fresh.page);
        const state = await hook.state(fresh.page);
        checkEvents(`${name} (opened link)`, await hook.events(fresh.page), state, {});
        assert.deepEqual(await noteSignature(fresh.page), originalSound, "the opened link sounds different");
      });
      await noHorizontalOverflow(fresh.page, `${name} (opened link)`, "opened");
    }
    await fresh.context.close();
  }

  // The other colour scheme, for the screenshots.
  const other = colorScheme === "dark" ? "light" : "dark";
  await page.emulateMedia({ colorScheme: other });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(out, `${name.replace(colorScheme, other)}-drawn.png`) });

  // A second link: one more line, which the address bar follows now that Share was pressed.
  let otherUrl = "";
  if (shareUrl) {
    await drawLine(page, 0.5, 0.8, rowCentre(6));
    await page.waitForFunction((prev) => location.href !== prev && location.hash.startsWith("#v1."), shareUrl, { timeout: 3000 }).catch(() => {});
    otherUrl = page.url();
    await playInvite(browser, name, ctxOptions, colorScheme, tapOrClick, shareUrl, otherUrl);
  }

  await context.close();
}

// Someone opens a song link: browsers can't autoplay, so the page says it is a song and to press Play.
// The invite goes on the first Play, the first stroke, or another song opened in the tab, and stays gone.
async function playInvite(browser, name, ctxOptions, colorScheme, tapOrClick, shareUrl, otherUrl) {
  const open = async (what) => {
    const fresh = await openPage(browser, `${name} (${what})`, ctxOptions, shareUrl);
    if (!fresh.ok) await fresh.context.close();
    return fresh.ok ? fresh : null;
  };

  let fresh = await open("invite");
  if (fresh) {
    const { page } = fresh;
    await check(`${name} a shared link invites Play`, async () => {
      assert.ok(await inviteShown(page), "no play invite on a page opened from a song link");
      assert.equal(await invitePill(page).innerText(), "Someone sent you a song. Press play to hear it.");
      assert.equal(await page.locator("#invite").getAttribute("role"), "status", "the invite should be announced");
      assert.equal(await page.locator("#invite").evaluate((el) => !!el.closest("[role=img]")), false, "inside role=img, so screen readers skip it");
      assert.equal(await page.locator("#play").getAttribute("aria-describedby"), "invite");
      // Over the canvas, inside the screen, on one or two lines.
      const pill = await invitePill(page).boundingBox();
      const canvas = await page.locator("#canvas-wrap").boundingBox();
      const vw = page.viewportSize().width;
      assert.ok(pill.x >= canvas.x && pill.x + pill.width <= canvas.x + canvas.width + 0.5, "the invite sticks out of the canvas sideways");
      assert.ok(pill.y >= canvas.y && pill.y + pill.height <= canvas.y + canvas.height + 0.5, "the invite sticks out of the canvas");
      assert.ok(pill.x >= 16 && pill.x + pill.width <= vw - 16, "the invite is not inside the 16px gutters");
      assert.ok(pill.height < 80, `the invite is ${pill.height}px tall`);
      // The hint for an empty canvas stays out of the way.
      assert.equal(await page.locator("#hint").evaluate((el) => el.classList.contains("gone")), true);
      // Play pulses, unless motion is reduced.
      assert.equal(await page.locator("#play").evaluate((el) => getComputedStyle(el).animationName), "invite-ring");
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await page.locator("#play").evaluate((el) => getComputedStyle(el).animationName), "none", "the pulse ignores reduced motion");
      await page.emulateMedia({ reducedMotion: "no-preference" });
    });
    await noHorizontalOverflow(page, `${name} (invite)`, "invited");
    await page.screenshot({ path: join(out, `${name}-invite.png`) });
    const other = colorScheme === "dark" ? "light" : "dark";
    await page.emulateMedia({ colorScheme: other });
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(out, `${name.replace(colorScheme, other)}-invite.png`) });
    await page.emulateMedia({ colorScheme });

    await check(`${name} pressing Play ends the invite for good`, async () => {
      await press(page, tapOrClick, "#play");
      await inviteGone(page, "pressing Play");
      assert.equal((await hook.state(page)).playing, true);
      assert.equal(await page.locator("#play").getAttribute("aria-describedby"), null, "Play is still described by the invite");
      assert.equal(await page.locator("#play").evaluate((el) => getComputedStyle(el).animationName), "none", "Play still pulses");
      await press(page, tapOrClick, "#play"); // pause: it stays gone
      await page.waitForTimeout(350);
      assert.equal(await invitePill(page).isVisible(), false, "the invite came back after pausing");
    });
    await page.screenshot({ path: join(out, `${name}-invite-played.png`) });
    await fresh.context.close();
  }

  fresh = await open("invite, then draw");
  if (fresh) {
    const { page } = fresh;
    await check(`${name} drawing ends the invite for good`, async () => {
      assert.ok(await inviteShown(page), "no play invite on a page opened from a song link");
      await drawLine(page, 0.1, 0.3, rowCentre(12));
      await inviteGone(page, "drawing a line");
      await page.keyboard.press("Control+z"); // back to the song as it was sent: still gone
      await page.waitForTimeout(350);
      assert.equal(await invitePill(page).isVisible(), false, "the invite came back after undo");
    });
    await fresh.context.close();
  }

  fresh = otherUrl && otherUrl !== shareUrl ? await open("invite, then another song") : null;
  if (fresh) {
    const { page } = fresh;
    await check(`${name} opening another song in the tab ends the invite`, async () => {
      assert.ok(await inviteShown(page), "no play invite on a page opened from a song link");
      const before = (await hook.song(page)).strokes.length;
      await page.evaluate((h) => (location.hash = h), new URL(otherUrl).hash);
      await page.waitForFunction((n) => window.__inkchime.song().strokes.length === n + 1, before, { timeout: 3000 });
      await inviteGone(page, "a hashchange opened another song");
    });
    await fresh.context.close();
  }
}

// A full song: the 401st stroke is blocked with a toast, and Share on the 400 gives a link that opens identically.
async function fullSong(browser, name, viewport, phone) {
  const ctxOptions = phone ? { viewport, colorScheme: "light", hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport, colorScheme: "dark" };
  const { page, context, ok } = await openPage(browser, name, ctxOptions);
  if (!ok) return context.close();
  const box = await page.locator("#canvas-wrap").boundingBox();
  /** A short stroke, drawn with the real pointer: down, two moves, up. Each one lands in a different place. */
  const quick = async (i) => {
    const x = box.x + box.width * (0.04 + 0.08 * (i % 10));
    const y = box.y + box.height * ((1 + (i % 13)) / 15);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + box.width * 0.04, y + 6, { steps: 2 });
    await page.mouse.move(x + box.width * 0.07, y);
    await page.mouse.up();
  };
  const count = async () => (await hook.song(page)).strokes.length;
  const toastText = () => page.locator("#toast").innerText();

  await check(`${name} drawing up to the limit`, async () => {
    for (let i = 0; i < 400; i++) await quick(i);
    assert.equal(await count(), 400, "should hold 400 strokes");
    assert.ok(!(await page.locator("#toast").evaluate((el) => el.classList.contains("show"))), "no toast before the limit is hit");
  });
  await check(`${name} the 401st stroke is blocked`, async () => {
    await quick(401);
    assert.equal(await count(), 400, "stroke count must stay at 400");
    await page.waitForFunction(() => document.querySelector("#toast").classList.contains("show"), null, { timeout: 2000 });
    assert.match(await toastText(), /most this song can hold/);
    assert.equal(await page.evaluate(() => window.__inkchime.song().strokes.length), 400);
  });
  await page.screenshot({ path: join(out, `${name}-full.png`) });

  const original = { song: await hook.song(page), schedule: await hook.schedule(page) };
  let url = "";
  await check(`${name} sharing a full song`, async () => {
    await page.locator("#share").click();
    await page.waitForFunction(() => /^Link copied/.test(document.querySelector("#toast").textContent), null, { timeout: 3000 });
    url = page.url();
    assert.ok(url.includes("#v1."));
  });
  if (url) {
    const fresh = await openPage(browser, `${name} (opened link)`, ctxOptions, url);
    if (fresh.ok) {
      await check(`${name} full-song link opens identically`, async () => {
        assert.deepEqual(await hook.song(fresh.page), original.song, "the link opened a different song");
        assert.deepEqual(await hook.schedule(fresh.page), original.schedule, "note schedule differs");
        assert.equal((await hook.song(fresh.page)).strokes.length, 400);
      });
    }
    await fresh.context.close();
  }
  await check(`${name} undo makes room again`, async () => {
    await page.keyboard.press("Control+z");
    assert.equal(await count(), 399);
    await quick(7);
    assert.equal(await count(), 400);
  });
  await noHorizontalOverflow(page, name, "full song");
  await context.close();
}

// Play on an empty canvas says so, but the playhead still runs and picks up a line drawn meanwhile.
async function emptyPlay(browser, name, viewport, phone, key) {
  const ctxOptions = phone ? { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport };
  const { page, context, ok } = await openPage(browser, name, ctxOptions);
  if (!ok) return context.close();
  await check(`${name} play on an empty canvas`, async () => {
    assert.equal((await hook.song(page)).strokes.length, 0);
    if (key) await page.keyboard.press("Space");
    else await press(page, phone ? "tap" : "click", "#play");
    await page.waitForFunction(() => document.querySelector("#toast").classList.contains("show"), null, { timeout: 2000 }).catch(() => {
      throw new Error("no toast after Play on an empty canvas");
    });
    assert.match(await page.locator("#toast").innerText(), /^Nothing to play yet\./);
    assert.equal(await page.locator("#play-label").innerText(), "Pause");
    assert.equal((await hook.state(page)).playing, true, "the playhead should still run");
  });
  await check(`${name} a line drawn while playing is heard`, async () => {
    await drawLine(page, 0.05, 0.95, 0.5);
    await allNotesScheduled(page);
    assert.equal(await page.locator("#play-label").innerText(), "Pause");
  });
  await context.close();
}

// The longest toasts: Share on a song too big for a link, and the live link falling behind after Share.
const LONG_TOASTS = [
  "This song is too big to share as a link. Undo or clear a few lines and try again.",
  "This song is now too big for a link. The address bar keeps the last version that fit.",
  "Someone on this network already liked Inkchime today. Thank you!",
];
// The toast uses the width it has: centred, inside the window (and any safe-area inset), and short enough to read.
async function toastLayout(browser, name, viewport, colorScheme, phone, maxLines) {
  const ctxOptions = phone ? { viewport, colorScheme, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport, colorScheme };
  const { page, context, ok } = await openPage(browser, name, ctxOptions);
  if (!ok) return context.close();
  const measure = () =>
    page.evaluate(() => {
      const el = document.querySelector("#toast");
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      const b = el.getBoundingClientRect();
      return { lines, left: b.left, right: b.right, width: b.width, view: document.documentElement.clientWidth, text: el.textContent };
    });
  const assertLayout = (m, lines, inset = 0) => {
    const said = `"${m.text.slice(0, 24)}…"`;
    assert.ok(m.lines <= lines, `${said} wraps to ${m.lines} lines in a ${Math.round(m.width)}px pill (at most ${lines})`);
    assert.ok(m.left >= inset - 0.5 && m.right <= m.view - inset + 0.5, `${said} spans ${m.left.toFixed(1)} to ${m.right.toFixed(1)} in a ${m.view}px window with ${inset}px insets`);
    assert.ok(Math.abs(m.left - (m.view - m.right)) <= 1, `${said} is off centre (${m.left.toFixed(1)} left, ${(m.view - m.right).toFixed(1)} right)`);
  };
  const showToast = async (text) => {
    await page.evaluate((t) => {
      const el = document.querySelector("#toast");
      el.textContent = t;
      el.classList.add("show");
    }, text);
    await page.waitForTimeout(250);
  };

  await check(`${name} toast fits`, async () => {
    await drawLine(page, 0.1, 0.5, 0.5);
    await press(page, phone ? "tap" : "click", "#share");
    await page.waitForFunction(() => /^Link copied/.test(document.querySelector("#toast").textContent), null, { timeout: 3000 });
    await page.waitForTimeout(250);
    assertLayout(await measure(), maxLines.short);
    await page.screenshot({ path: join(out, `${name}-toast.png`) });
    for (const text of LONG_TOASTS) {
      await showToast(text);
      assertLayout(await measure(), maxLines.long);
    }
  });

  // A notched phone: with 44px safe-area insets either side, the pill still sits inside them, centred.
  if (phone) {
    const cdp = await context.newCDPSession(page);
    const inset = 44;
    const supported = await cdp
      .send("Emulation.setSafeAreaInsetsOverride", { insets: { left: inset, right: inset, top: 0, bottom: 0 } })
      .then(() => true)
      .catch(() => false);
    if (supported) {
      await check(`${name} toast inside safe-area insets`, async () => {
        for (const text of LONG_TOASTS) {
          await showToast(text);
          const m = await measure();
          assert.ok(m.left >= inset - 0.5 && m.right <= m.view - inset + 0.5, `"${text.slice(0, 24)}…" spans ${m.left.toFixed(1)} to ${m.right.toFixed(1)}, inside ${inset}px insets`);
          assert.ok(Math.abs(m.left - (m.view - m.right)) <= 1, `"${text.slice(0, 24)}…" is off centre with insets`);
        }
        await page.screenshot({ path: join(out, `${name}-toast-insets.png`) });
      });
    } else {
      console.log(`${name}: this browser can't emulate safe-area insets, skipped that toast check`);
    }
  }
  await context.close();
}

// After Share, the address bar follows the song: every edit, then a reload, gives the song on screen.
// Before Share, drawing leaves the address alone. No edit adds a Back step.
async function liveLink(browser, name, viewport, phone) {
  const ctxOptions = phone ? { viewport, colorScheme: "light", hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport, colorScheme: "dark" };
  const { page, context, ok } = await openPage(browser, name, ctxOptions);
  if (!ok) return context.close();
  const hash = () => page.evaluate(() => location.hash);
  const historyLength = await page.evaluate(() => history.length);
  /** Wait for the address bar to move on from `before` (it is written when the page is idle, just after the edit). */
  const followed = (before, what) =>
    page
      .waitForFunction((prev) => location.hash !== prev && location.hash.startsWith("#v1."), before, { timeout: 3000, polling: 20 })
      .catch(() => {
        throw new Error(`the link in the address bar did not follow the song after ${what}`);
      });
  /** Reload and check the page opens to exactly the song that was on screen. */
  const reloadsTo = async (what) => {
    const want = { song: await hook.song(page), schedule: await hook.schedule(page) };
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#canvas-wrap canvas", { state: "attached", timeout: 8000 });
    assert.deepEqual(await hook.song(page), want.song, `reload after ${what} opened a different song (strokes, colours, sizes or tempo)`);
    assert.deepEqual(await hook.schedule(page), want.schedule, `reload after ${what} gave a different note schedule`);
    assert.equal(await page.locator("#tempo").inputValue(), String(want.song.bpm), `tempo control after ${what}`);
    assert.equal(await page.evaluate(() => history.length), historyLength, `${what} added a browser-history entry`);
    await noInvite(page, `when the author reloads their own link (after ${what})`);
  };
  /** Make an edit after Share, wait for the link to follow, then reload (a reload forgets the undo history). */
  const step = async (what, edit, reload = true) => {
    const before = await hash();
    await edit();
    await followed(before, what);
    if (reload) await reloadsTo(what);
  };

  await check(`${name} before Share the address bar is left alone`, async () => {
    await page.evaluate(() => {
      window.__writes = 0;
      const replace = history.replaceState.bind(history);
      history.replaceState = (...args) => (window.__writes++, replace(...args));
    });
    await pickColour(page, "Pluck");
    await setSize(page, 6);
    await drawLine(page, 0.05, 0.3, rowCentre(5));
    await drawLine(page, 0.35, 0.6, rowCentre(9));
    await page.keyboard.press("Control+z");
    await setTempo(page, 100);
    // A note placed with the keys, then undone; a clear, then undone.
    await page.focus("#canvas-wrap");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+z");
    await page.locator("#clear").click();
    await page.keyboard.press("Control+z");
    await page.evaluate(() => {
      dispatchEvent(new Event("pagehide"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(600);
    assert.equal(await hook.song(page).then((s) => s.strokes.length), 1);
    assert.equal(await hash(), "", "the address changed before Share was pressed");
    assert.equal(await page.evaluate(() => window.__writes), 0, "the address bar was written before Share was pressed");
  });

  let shared = "";
  let emptyLink = "";
  await check(`${name} share, then the link follows every edit`, async () => {
    await press(page, phone ? "tap" : "click", "#share");
    await page.waitForFunction(() => location.hash.startsWith("#v1."), null, { timeout: 3000 });
    shared = await hash();
    await reloadsTo("Share");

    await step("drawing a stroke", async () => {
      await pickColour(page, "Pad");
      await setSize(page, 2);
      await drawLine(page, 0.5, 0.9, rowCentre(11));
    });
    await step("drawing another stroke", async () => {
      await pickColour(page, "Tap");
      await setSize(page, 8);
      await drawLine(page, 0.2, 0.45, rowCentre(1));
    }, false);
    assert.equal((await hook.song(page)).strokes.length, 3);
    await step("undo", () => page.keyboard.press("Control+z"));
    assert.equal((await hook.song(page)).strokes.length, 2);
    await step("changing the tempo", () => setTempo(page, 72));
    await step("clear", () => page.locator("#clear").click());
    assert.equal((await hook.song(page)).strokes.length, 0, "clear should reload to an empty canvas");
    assert.ok(await page.locator("#hint").isVisible(), "hint after reloading a cleared song");
    emptyLink = page.url();
    await step("drawing after clear", async () => {
      await pickColour(page, "Bell");
      await setSize(page, 5);
      await drawLine(page, 0.1, 0.7, rowCentre(7));
    });
    assert.notEqual(await hash(), shared);
  });

  await check(`${name} drawing stays smooth while the link follows`, async () => {
    const before = await hash();
    const frames = await drawWave(page);
    const p50 = percentile(frames, 0.5);
    console.log(`${name}: ${frames.length} frames while drawing after Share, median ${p50.toFixed(1)} ms, p95 ${percentile(frames, 0.95).toFixed(1)} ms`);
    assert.ok(p50 < 20, `median frame time was ${p50.toFixed(1)} ms while drawing after Share`);
    await followed(before, "drawing a long line");
    await reloadsTo("drawing a long line");
  });
  await page.screenshot({ path: join(out, `${name}-reloaded.png`) });

  await check(`${name} a reload right after pen-up keeps that stroke`, async () => {
    // Stall the idle write, so only the pen-up write can save the stroke, then reload within a few ms of pen-up.
    await page.evaluate(() => {
      window.requestIdleCallback = () => 0;
      window.setTimeout = () => 0;
    });
    const before = await hash();
    const want = (await hook.song(page)).strokes.length + 1;
    const box = await page.locator("#canvas-wrap").boundingBox();
    const py = box.y + rowCentre(3) * box.height;
    await page.mouse.move(box.x + 0.15 * box.width, py);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + (0.15 + 0.04 * i) * box.width, py);
    await page.mouse.up();
    const t0 = Date.now();
    const reloaded = page.reload({ waitUntil: "networkidle" });
    const gap = Date.now() - t0;
    await reloaded;
    await page.waitForSelector("#canvas-wrap canvas", { state: "attached", timeout: 8000 });
    assert.ok(gap < 5, `reload was sent ${gap} ms after pen-up`);
    assert.notEqual(await hash(), before, "the address bar did not take the last stroke before the reload");
    assert.equal((await hook.song(page)).strokes.length, want, "the stroke drawn just before the reload was dropped");
    assert.equal(await page.evaluate(() => history.length), historyLength, "the pen-up write added a browser-history entry");
  });

  /**
   * Hold every idle write in a queue only the test drains, and count address-bar writes,
   * so only a write made at the edit itself can reach the reload.
   */
  const stallIdle = () =>
    page.evaluate(() => {
      window.__idle = [];
      window.__writes = 0;
      window.requestIdleCallback = (run) => window.__idle.push(run);
      window.cancelIdleCallback = (id) => {
        if (id > 0) window.__idle[id - 1] = null;
      };
      window.setTimeout = () => 0;
      const replace = history.replaceState.bind(history);
      history.replaceState = (...args) => (window.__writes++, replace(...args));
    });
  const idleWaiting = () => page.evaluate(() => window.__idle.filter(Boolean).length);
  const writes = () => page.evaluate(() => window.__writes);
  /**
   * Make an edit with the idle write stalled, reload within a few ms of it, and check the
   * page opens to `want`: a song, or a function that checks the song it opened to.
   */
  const reloadRightAfter = async (what, edit, want) => {
    await stallIdle();
    const before = await hash();
    await edit();
    const t0 = Date.now();
    const reloaded = page.reload({ waitUntil: "networkidle" });
    const gap = Date.now() - t0;
    await reloaded;
    await page.waitForSelector("#canvas-wrap canvas", { state: "attached", timeout: 8000 });
    assert.ok(gap < 5, `reload was sent ${gap} ms after ${what}`);
    assert.notEqual(await hash(), before, `the address bar did not take ${what} before the reload`);
    const opened = await hook.song(page);
    if (typeof want === "function") want(opened);
    else assert.deepEqual(opened, want, `a reload right after ${what} opened a different song`);
    assert.equal(await page.locator("#tempo").inputValue(), String(opened.bpm), `tempo control after ${what}`);
    assert.equal(await page.evaluate(() => history.length), historyLength, `${what} added a browser-history entry`);
    await noInvite(page, `when the author reloads right after ${what}`);
  };

  await check(`${name} a reload right after undo, a placed note, the tempo or clear keeps it`, async () => {
    // A reload forgets the undo history, so draw the stroke to undo first.
    let now = await hook.song(page);
    await drawLine(page, 0.4, 0.75, rowCentre(12));
    assert.equal((await hook.song(page)).strokes.length, now.strokes.length + 1);
    await reloadRightAfter("undo", () => page.keyboard.press("Control+z"), now);

    // A note placed with the keys goes the same way as pen-up.
    now = await hook.song(page);
    await page.focus("#canvas-wrap");
    await reloadRightAfter("placing a note with Enter", () => page.keyboard.press("Enter"), (opened) => {
      assert.equal(opened.bpm, now.bpm);
      assert.deepEqual(opened.strokes.slice(0, -1), now.strokes, "a reload right after placing a note changed the strokes before it");
      assert.equal(opened.strokes.length, now.strokes.length + 1, "the note placed just before the reload was dropped");
      assert.equal(opened.strokes.at(-1).pts.length, 4, "the placed note should be a short dash");
    });

    // Dragging the tempo: no write per input event, one per idle moment; letting go writes at once.
    now = await hook.song(page);
    await stallIdle();
    const dragged = await hash();
    const drag = (from, to) =>
      page.evaluate(
        ([a, b]) => {
          const el = document.querySelector("#tempo");
          for (let v = a; v <= b; v++) {
            el.value = String(v);
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        },
        [from, to],
      );
    await drag(61, 90);
    assert.equal(await writes(), 0, "a tempo drag wrote the address bar on an input event");
    assert.equal(await idleWaiting(), 1, "a tempo drag should queue one write for idle");
    await page.evaluate(() => window.__idle.splice(0).forEach((run) => run && run()));
    assert.equal(await writes(), 1, "the idle moment during a drag should write once");
    assert.notEqual(await hash(), dragged, "the address bar did not follow the drag at idle");
    await drag(91, 104);
    assert.equal(await writes(), 1, "a tempo drag wrote the address bar on an input event");
    assert.equal(await idleWaiting(), 1, "a tempo drag should queue one write for idle");
    await reloadRightAfter(
      "letting go of the tempo slider",
      () => page.locator("#tempo").evaluate((el) => el.dispatchEvent(new Event("change", { bubbles: true }))),
      { ...now, bpm: 104 },
    );

    now = await hook.song(page);
    await reloadRightAfter("clear", () => page.locator("#clear").click(), { ...now, strokes: [] });
    assert.ok(await page.locator("#hint").isVisible(), "hint after reloading a cleared song");
  });

  // lab#45: a long drag with real idle moments spends the write budget on its idle writes.
  // Letting go must still be in the address bar at once, so a reload right after it opens
  // the tempo let go at, not one from the middle of the drag.
  /** Count address-bar writes (with idle moments left alone), and the time of each. */
  const countWrites = () =>
    page.evaluate(() => {
      window.__writeTimes = [];
      const replace = history.replaceState.bind(history);
      history.replaceState = (...args) => (window.__writeTimes.push(performance.now()), replace(...args));
    });
  const writeTimes = () => page.evaluate(() => window.__writeTimes);
  /** The most writes a stretch of `ms` may make: the burst, then one per 350 ms. */
  const budget = (ms) => 5 + Math.ceil(ms / 350) + 1;
  /** Let go, reload within a few ms, and check the page opens to the tempo on screen at that moment. */
  const reloadAtOnce = async (what, letGo) => {
    const want = await hook.song(page);
    await letGo();
    const t0 = Date.now();
    const reloaded = page.reload({ waitUntil: "networkidle" });
    const gap = Date.now() - t0;
    await reloaded;
    await page.waitForSelector("#canvas-wrap canvas", { state: "attached", timeout: 8000 });
    assert.ok(gap < 5, `reload was sent ${gap} ms after ${what}`);
    const opened = await hook.song(page);
    assert.equal(opened.bpm, want.bpm, `a reload right after ${what} opened ${opened.bpm} bpm, not the ${want.bpm} it was let go at`);
    assert.deepEqual(opened, want, `a reload right after ${what} opened a different song`);
    assert.equal(await page.locator("#tempo").inputValue(), String(want.bpm), `tempo control after ${what}`);
    assert.equal(await page.evaluate(() => history.length), historyLength, `${what} added a browser-history entry`);
  };

  await check(`${name} a reload right after letting go of a long tempo drag keeps the released tempo`, async () => {
    const slider = page.locator("#tempo");
    await slider.scrollIntoViewIfNeeded();
    const box = await slider.boundingBox();
    const y = box.y + box.height / 2;
    const at = (f) => box.x + f * box.width;
    for (const [from, to, frames] of [
      [0.9, 0.1, 30], // about half a second
      [0.1, 0.95, 90], // about a second and a half
    ]) {
      await countWrites();
      const t0 = Date.now();
      await page.mouse.move(at(from), y);
      await page.mouse.down();
      // A finger or mouse moving at a steady pace, a frame or so apart, with idle moments between.
      for (let i = 1; i <= frames; i++) {
        await page.mouse.move(at(from + ((to - from) * i) / frames), y);
        await page.waitForTimeout(16);
      }
      // Settle a few steps back from the far end, so the value let go at is not one the drag had idle time to write.
      await page.mouse.move(at(to + (from - to) * 0.08), y);
      const during = await writeTimes();
      const ms = Date.now() - t0;
      console.log(`${name}: ${during.length} address-bar writes during a ${ms} ms tempo drag`);
      assert.ok(during.length >= 5, `the drag should spend the write budget (${during.length} writes), or this check proves nothing`);
      assert.ok(during.length <= budget(ms), `${during.length} writes during a ${ms} ms drag: more than the budget allows`);
      await reloadAtOnce(`letting go of a ${ms} ms tempo drag`, () => page.mouse.up());
    }
  });

  await check(`${name} a reload right after letting go of a held arrow key keeps the released tempo`, async () => {
    for (const [key, start] of [
      ["ArrowLeft", 110],
      ["ArrowRight", 70],
    ]) {
      // Start far enough from the end the key moves towards that 45 steps never reach it.
      await setTempo(page, start);
      await page.locator("#tempo").focus();
      await countWrites();
      const t0 = Date.now();
      // Auto-repeat: a keydown about every 33 ms for a second and a half.
      for (let i = 0; i < 45; i++) {
        await page.keyboard.down(key);
        await page.waitForTimeout(33);
      }
      const during = await writeTimes();
      const ms = Date.now() - t0;
      console.log(`${name}: ${during.length} address-bar writes while holding ${key} for ${ms} ms`);
      assert.ok(during.length >= 5, `holding ${key} should spend the write budget (${during.length} writes), or this check proves nothing`);
      assert.ok(during.length <= budget(ms), `${during.length} writes while holding ${key} for ${ms} ms: more than the budget allows`);
      await reloadAtOnce(`letting go of ${key}`, () => page.keyboard.up(key));
    }
  });

  await check(`${name} a tempo drag still waiting for idle is written when the tab is hidden`, async () => {
    for (const [what, hide] of [
      ["pagehide", () => page.evaluate(() => dispatchEvent(new Event("pagehide")))],
      [
        "visibilitychange",
        () =>
          page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
            document.dispatchEvent(new Event("visibilitychange"));
            delete document.visibilityState;
          }),
      ],
    ]) {
      await stallIdle();
      const bpm = what === "pagehide" ? 77 : 113;
      await page.evaluate((v) => {
        const el = document.querySelector("#tempo");
        el.value = String(v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, bpm);
      assert.equal(await writes(), 0, "a tempo drag wrote the address bar on an input event");
      await hide();
      assert.equal(await writes(), 1, `${what} should write the drag still waiting for idle`);
      const want = await hook.song(page);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("#canvas-wrap canvas", { state: "attached", timeout: 8000 });
      assert.deepEqual(await hook.song(page), want, `a reload after ${what} opened a different song`);
      assert.equal(await page.locator("#tempo").inputValue(), String(bpm), `tempo control after ${what}`);
    }
  });

  // A link to an empty canvas (after Clear) has nothing to play: the usual hint, no invite.
  if (emptyLink) {
    const fresh = await openPage(browser, `${name} (empty link)`, ctxOptions, emptyLink);
    if (fresh.ok) {
      await check(`${name} an empty-canvas link has no invite`, async () => {
        assert.equal((await hook.song(fresh.page)).strokes.length, 0);
        assert.ok(await fresh.page.locator("#hint").isVisible(), "hint on an empty-canvas link");
        await noInvite(fresh.page, "for a link to an empty canvas");
      });
    }
    await fresh.context.close();
  }

  await check(`${name} Back leaves the page`, async () => {
    await page.goBack({ waitUntil: "commit" });
    assert.ok(!page.url().startsWith(base), `Back stayed on the page: ${page.url()}`);
  });
  await context.close();
}

// Browsers cap address-bar writes (Safari throws past 100 replaceState calls in 30 s). Holding
// Ctrl+Z after Share must still undo everything, and the address bar catches up once allowed.
async function heldUndo(browser, name, viewport) {
  const ctxOptions = { viewport, colorScheme: "dark" };
  const { page, context, ok } = await openPage(browser, name, ctxOptions);
  if (!ok) return context.close();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const paper = () => page.evaluate(() => document.querySelector("#paper").toDataURL());
  const empty = await paper();
  const box = await page.locator("#canvas-wrap").boundingBox();
  const strokes = 150;

  await check(`${name} 150 strokes, shared`, async () => {
    for (let i = 0; i < strokes; i++) {
      const x = box.x + box.width * (0.04 + 0.08 * (i % 10));
      const y = box.y + box.height * ((1 + (i % 13)) / 15);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + box.width * 0.05, y + 4, { steps: 2 });
      await page.mouse.up();
    }
    assert.equal((await hook.song(page)).strokes.length, strokes);
    await page.locator("#share").click();
    await page.waitForFunction(() => location.hash.startsWith("#v1."), null, { timeout: 3000 });
  });

  await check(`${name} holding Ctrl+Z past the browser's write limit`, async () => {
    // Safari's rule, with a 4 s window instead of 30 s: past 100 calls in the window, replaceState
    // throws. All 100 are spent already, as if by earlier edits, so every write in the burst is refused.
    await page.evaluate(() => {
      const replace = history.replaceState.bind(history);
      window.__refused = 0;
      window.__calls = 100;
      window.__windowStart = performance.now();
      history.replaceState = (...args) => {
        if (performance.now() - window.__windowStart > 4000) (window.__windowStart = performance.now()), (window.__calls = 0);
        if (++window.__calls > 100) {
          window.__refused++;
          throw new DOMException("Attempt to use history.replaceState() more than 100 times per 30 seconds", "SecurityError");
        }
        return replace(...args);
      };
    });
    const stale = await page.evaluate(() => location.hash);
    const t0 = Date.now();
    for (let i = 0; i < strokes; i++) await page.keyboard.press("Control+z");
    const burst = Date.now() - t0;
    assert.deepEqual(errors, [], "page errors during the burst");
    assert.ok(burst < 3500, `the burst took ${burst} ms, longer than the simulated limit window`);
    assert.equal(await page.evaluate(() => location.hash), stale, "a refused write should leave the address bar as it was");
    assert.ok((await page.evaluate(() => window.__refused)) > 0, "the burst should have reached the limit (the check would prove nothing)");
    assert.equal((await hook.song(page)).strokes.length, 0, "every undo should land");
    assert.equal(await paper(), empty, "the canvas should be empty after undoing every stroke");
    assert.equal(await page.locator("#undo").getAttribute("aria-disabled"), "true", "nothing left to undo");
    assert.ok(await page.locator("#hint").isVisible(), "hint on the emptied canvas");
    // Once the window passes, the address bar catches up to the empty song on screen.
    await page
      .waitForFunction((prev) => location.hash !== prev && location.hash.startsWith("#v1."), stale, { timeout: 8000, polling: 50 })
      .catch(() => {
        throw new Error("the address bar never caught up after the burst");
      });
    const want = await hook.song(page);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#canvas-wrap canvas", { state: "attached", timeout: 8000 });
    assert.deepEqual(await hook.song(page), want, "reload after the burst opened a different song");
    assert.equal(want.strokes.length, 0);
    assert.deepEqual(errors, [], "page errors after the burst");
  });
  await context.close();
}

// Broken links must open to an empty canvas, quietly.
async function malformedLinks(browser) {
  const name = "bad links";
  const good = await (async () => {
    const { page, context } = await openPage(browser, name, { viewport: { width: 1280, height: 900 } });
    await drawLine(page, 0.1, 0.5, 0.5);
    await page.locator("#share").click();
    const url = page.url();
    await context.close();
    return url;
  })();
  const payload = good.split("#v1.")[1] || "";
  const hashes = ["#v1.", "#v1.!!!!", "#v1.AAAA", "#garbage", "#v2.AAAA", "#" + "v1." + payload.slice(0, Math.floor(payload.length / 2)), "#v1." + payload + "AAAA", "#v1.%E0%A4%A"];
  for (const hash of hashes) {
    const { page, context, ok } = await openPage(browser, `${name} ${hash.slice(0, 18)}`, { viewport: { width: 1280, height: 900 } }, base + hash);
    if (ok) {
      await check(`${name} ${hash.slice(0, 24)}`, async () => {
        assert.equal((await hook.song(page)).strokes.length, 0, "should be an empty canvas");
        assert.ok(await page.locator("#hint").isVisible());
        await noInvite(page, "for a broken link");
        await drawLine(page, 0.2, 0.4, 0.5); // and it still works
        assert.equal((await hook.song(page)).strokes.length, 1);
      });
    }
    await context.close();
  }
}

// Keyboard only: Tab to the canvas, move the cursor with the arrows, place notes with Enter or N,
// hear them on Play, undo one, share, and see the live link and the invite treat them like strokes.
async function keyboardDraw(browser, name, viewport, colorScheme) {
  const ctxOptions = { viewport, colorScheme };
  const { page, context, ok } = await openPage(browser, name, ctxOptions);
  if (!ok) return context.close();
  const wrap = page.locator("#canvas-wrap");
  const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("name") || document.activeElement?.tagName);
  const cursorAt = async () => (await hook.state(page)).cursor;
  const say = () => page.locator("#say").textContent().then((t) => t.replace(/ /g, "").trim());
  const tabs = async (n, shift = false) => {
    for (let i = 0; i < n; i++) await page.keyboard.press(shift ? "Shift+Tab" : "Tab");
  };

  await check(`${name} canvas is a keyboard target`, async () => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await tabs(1);
    assert.equal(await focused(), "canvas-wrap", "the first Tab should reach the canvas");
    const ring = await wrap.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { visible: el.matches(":focus-visible"), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), color: cs.outlineColor };
    });
    assert.ok(ring.visible && ring.style !== "none" && ring.width >= 2, `no visible focus ring on the canvas: ${JSON.stringify(ring)}`);
    assert.ok(await page.locator("#cursor").isVisible(), "the keyboard cursor is not shown");
    // Screen readers: a name, a description with the keys, and the visible hint not read a second time.
    assert.equal(await wrap.getAttribute("aria-label"), "Drawing canvas");
    const help = await page.locator(`#${await wrap.getAttribute("aria-describedby")}`).textContent();
    assert.match(help, /arrow keys/i);
    assert.match(help, /Enter or N/);
    assert.equal(await page.locator("#hint").getAttribute("aria-hidden"), "true", "the hint would be read twice");
    assert.equal(await page.locator("#say").getAttribute("aria-live"), "polite");
  });
  await page.screenshot({ path: join(out, `${name}-canvas-focus.png`) });

  await check(`${name} arrows move the cursor, clamped at the edges`, async () => {
    const scrollY = await page.evaluate(() => window.scrollY);
    assert.deepEqual(await cursorAt(), { col: 0, row: 7 });
    await page.keyboard.press("ArrowLeft");
    assert.deepEqual(await cursorAt(), { col: 0, row: 7 }, "left edge");
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowUp");
    assert.deepEqual(await cursorAt(), { col: 0, row: 0 }, "top edge");
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowDown");
    assert.deepEqual(await cursorAt(), { col: 0, row: 14 }, "bottom edge");
    for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
    assert.deepEqual(await cursorAt(), { col: 31, row: 14 }, "right edge");
    for (let i = 0; i < 27; i++) await page.keyboard.press("ArrowLeft");
    for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowUp");
    assert.deepEqual(await cursorAt(), { col: 4, row: 7 });
    assert.equal(await say(), "Column 5, pitch E4");
    assert.equal(await page.evaluate(() => window.scrollY), scrollY, "arrow keys scrolled the page");
    // The cursor is drawn over that cell of the grid.
    const box = await wrap.boundingBox();
    const c = await page.locator("#cursor").boundingBox();
    assert.ok(near(c.x, box.x + (4 * box.width) / 32, 2) && near(c.y, box.y + (7 * box.height) / 15, 2), `cursor drawn at ${c.x},${c.y}`);
    assert.ok(near(c.width, box.width / 32, 2) && near(c.height, box.height / 15, 2), `cursor is ${c.width}x${c.height}`);
  });

  await check(`${name} Enter places a note`, async () => {
    await page.keyboard.press("Enter");
    const song = await hook.song(page);
    assert.equal(song.strokes.length, 1, "Enter did not place a note");
    assert.equal(song.strokes[0].color, 0);
    assert.equal(song.strokes[0].size, 4);
    assert.deepEqual(
      (await hook.schedule(page)).map((n) => [n.step, n.midi, n.voice]),
      [[4, expectedMidi(7), 0]],
      "the note should be in column 5 at the cursor's pitch",
    );
    assert.equal(await say(), "Bell, column 5, pitch E4");
    assert.equal(await page.locator("#hint").evaluate((el) => el.classList.contains("gone")), true, "hint should fade out");
    assert.equal(await page.locator("#undo").getAttribute("aria-disabled"), "false");
  });

  // Colour and size, by keyboard too: Tab to the colours, pick Pluck, then come back and press N.
  await check(`${name} N places a note in the current colour and size`, async () => {
    await tabs(1);
    await page.keyboard.press("ArrowRight"); // Bell -> Pluck
    await tabs(5); // play, undo, clear, share, size
    assert.equal(await focused(), "size");
    await page.keyboard.press("End"); // brush 8
    await tabs(6, true);
    assert.equal(await focused(), "canvas-wrap");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("n");
    const song = await hook.song(page);
    assert.equal(song.strokes.length, 2, "N did not place a note");
    assert.deepEqual([song.strokes[1].color, song.strokes[1].size], [1, 8]);
    const n = (await hook.schedule(page)).find((x) => x.voice === 1);
    assert.deepEqual([n.step, n.midi], [5, expectedMidi(6)]);
    assert.ok(near(n.gain, expectedGain(8), 1e-9), "gain from the brush size");
    assert.equal(await say(), "Pluck, column 6, pitch G4");
    // The same note again is a new edit, and is read out again.
    await page.keyboard.press("N");
    assert.equal((await hook.song(page)).strokes.length, 3);
    assert.equal(await say(), "Pluck, column 6, pitch G4");
  });

  await check(`${name} Ctrl or ⌘ Z undoes a placed note`, async () => {
    await page.keyboard.press("Control+z");
    assert.equal((await hook.song(page)).strokes.length, 2);
    await page.keyboard.press("Meta+z");
    assert.equal((await hook.song(page)).strokes.length, 1);
    assert.equal(await focused(), "canvas-wrap", "undo moved the focus");
  });

  await check(`${name} Space on the canvas plays the placed note`, async () => {
    await page.keyboard.press("Space");
    assert.equal((await hook.state(page)).playing, true, "Space should play");
    await allNotesScheduled(page);
    const state = await hook.state(page);
    const events = await hook.events(page);
    assert.ok(events.some((e) => e.step === 4 && e.midi === expectedMidi(7) && e.voice === 0), "the placed note was not heard");
    checkEvents(name, events, state, { midi: expectedMidi(7), gain: expectedGain(4), voice: 0, steps: [4, 4] });
    await page.keyboard.press("Space");
    assert.equal((await hook.state(page)).playing, false, "Space should pause");
    assert.equal(await focused(), "canvas-wrap");
  });
  await page.screenshot({ path: join(out, `${name}-placed.png`) });

  await check(`${name} Tab moves on from the canvas`, async () => {
    await tabs(1);
    assert.equal(await focused(), "voice");
    await tabs(1, true);
    assert.equal(await focused(), "canvas-wrap");
  });

  // Share by keyboard, then a placed note is followed by the live link like any stroke.
  let shareUrl = "";
  await check(`${name} Share and the live link include placed notes`, async () => {
    await page.locator("#share").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.hash.startsWith("#v1."), null, { timeout: 3000 });
    shareUrl = page.url();
    await tabs(5, true); // clear, undo, play, voice, canvas
    assert.equal(await focused(), "canvas-wrap");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await page.waitForFunction((prev) => location.href !== prev, shareUrl, { timeout: 3000 }).catch(() => {
      throw new Error("the address bar did not follow a placed note");
    });
    const followed = page.url();
    const fresh = await openPage(browser, `${name} (followed link)`, ctxOptions, followed);
    try {
      assert.ok(fresh.ok);
      assert.deepEqual(await hook.song(fresh.page), await hook.song(page), "the live link lost a placed note");
    } finally {
      await fresh.context.close();
    }
  });

  // Someone who opens the shared link and places a note with the keys has acted: the invite goes.
  if (shareUrl) {
    const opened = await openPage(browser, `${name} (opened link)`, ctxOptions, shareUrl);
    if (opened.ok) {
      await check(`${name} a placed note ends the invite`, async () => {
        assert.ok(await inviteShown(opened.page), "no invite on a shared link");
        await opened.page.evaluate(() => document.activeElement && document.activeElement.blur());
        await opened.page.keyboard.press("Tab");
        await opened.page.keyboard.press("Enter");
        await inviteGone(opened.page, "placing a note with Enter");
        assert.equal((await hook.song(opened.page)).strokes.length, 2);
      });
    }
    await opened.context.close();
  }

  // A click hides the keyboard cursor again; drawing with the mouse works as before.
  await check(`${name} the mouse still draws`, async () => {
    const before = (await hook.song(page)).strokes.length;
    await drawLine(page, 0.6, 0.8, rowCentre(3));
    assert.equal((await hook.song(page)).strokes.length, before + 1);
    assert.equal(await page.locator("#cursor").isVisible(), false, "the keyboard cursor stays after a click");
  });
  await noHorizontalOverflow(page, name, "keyboard");
  await context.close();
}

// --- likes ---------------------------------------------------------------------------

/** What the heart shows. */
const heart = (page) =>
  page.evaluate(() => {
    const b = document.querySelector("#like");
    return { shown: !b.hidden && !!b.offsetParent, pressed: b.getAttribute("aria-pressed"), label: b.getAttribute("aria-label"), n: b.querySelector(".like-n").textContent };
  });
const heartReads = (n, pressed) => ({ shown: true, pressed: String(pressed), label: `Like Inkchime, ${n} ${n === 1 ? "like" : "likes"}`, n: String(n) });
const likeSettled = (page) => page.waitForFunction(() => !document.querySelector("#like").hasAttribute("aria-busy"), null, { timeout: 8000 });
const storedLike = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), LIKE_KEY);
/** The address bar and this tab's history, which liking must never touch. */
const addressBar = (page) => page.evaluate(() => ({ href: location.href, length: history.length, state: JSON.stringify(history.state) }));
const toastSays = (page, re) =>
  page.waitForFunction((src) => {
    const t = document.querySelector("#toast");
    return t.classList.contains("show") && new RegExp(src).test(t.textContent);
  }, re.source, { timeout: 3000 });

// Liking (at once, before the API answers), reloading and unliking with the stored receipt,
// also on a later day; the keyboard, label and aria-pressed; 409 and 429 roll back with a
// polite toast; no cookies; and the address bar, history, live link and the invite to play
// are left alone.
async function likesFlow(browser, name, viewport, colorScheme, phone) {
  const ctxOptions = phone ? { viewport, colorScheme, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport, colorScheme };
  const how = phone ? "tap" : "click";
  const { page, context, ok } = await openPage(browser, name, ctxOptions, base, { likes: { expectRefusals: true } });
  if (!ok) return context.close();
  const api = page.likes;
  const tapLike = async () => {
    await press(page, how, "#like");
    await likeSettled(page);
  };

  await check(`${name} heart shows the count`, async () => {
    await page.locator("#like").waitFor({ state: "visible", timeout: 3000 });
    assert.deepEqual(await heart(page), heartReads(12, false));
    assert.equal(api.calls[0]?.path, "/api/likes?quiet=1", "the counts should be asked for quietly");
  });

  let receipt = "";
  await check(`${name} like, reload, unlike`, async () => {
    await drawLine(page, 0.1, 0.4, rowCentre(5));
    const before = await addressBar(page);
    api.delay = 400;
    await press(page, how, "#like");
    assert.deepEqual(await heart(page), heartReads(13, true), "liking should show at once, before the API answers");
    await likeSettled(page);
    api.delay = 0;
    const s = await storedLike(page);
    assert.ok(s?.liked === true && s.receipt === api.receipts[0], `the receipt should be stored with the liked state, stored ${JSON.stringify(s)}`);
    receipt = s.receipt;
    assert.deepEqual(await addressBar(page), before, "liking should leave the address bar and history alone");
    assert.equal((await hook.song(page)).strokes.length, 1, "liking should leave the song alone");
    await page.locator(".dock").screenshot({ path: join(out, `${name}-dock-liked.png`) });

    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#like").waitFor({ state: "visible", timeout: 3000 });
    assert.deepEqual(await heart(page), heartReads(13, true), "the like should survive a reload");

    await tapLike();
    const del = api.calls.findLast((c) => c.method === "DELETE");
    assert.equal(JSON.parse(del?.body ?? "{}").receipt, receipt, "unliking should send the stored receipt");
    assert.deepEqual(await heart(page), heartReads(12, false));
    assert.equal(await storedLike(page), null, "unliking should forget the receipt");
    assert.equal(api.receipts.length, 0, "the mocked hub should no longer have the like");
  });

  if (!phone) {
    await check(`${name} heart by keyboard`, async () => {
      // From the canvas (the first stop), past the colours, transport and sliders.
      await page.locator("#canvas-wrap").focus();
      for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.id), "like", "the heart should be the last Tab stop in the dock");
      assert.ok(await page.locator("#like").evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none"), "the heart should show a focus ring");
      await page.keyboard.press("Enter");
      await likeSettled(page);
      assert.deepEqual(await heart(page), heartReads(13, true), "Enter should like");
      await page.keyboard.press("Space");
      await likeSettled(page);
      assert.deepEqual(await heart(page), heartReads(12, false), "Space on the heart should unlike");
      assert.equal((await hook.state(page)).playing, false, "Space on the heart should not start playback");
      assert.equal(await page.evaluate(() => document.activeElement.id), "like", "focus should stay on the heart");
    });
  }

  await check(`${name} 409 and 429 roll back politely`, async () => {
    api.next = 409;
    await tapLike();
    assert.deepEqual(await heart(page), heartReads(12, false), "a 409 should roll the like back");
    await toastSays(page, /^Someone on this network already liked Inkchime today\. Thank you!$/);
    await page.waitForTimeout(250); // the toast's fade-in
    await page.screenshot({ path: join(out, `${name}-like-409.png`) });
    await noHorizontalOverflow(page, name, "409 note");
    await tapLike();
    assert.deepEqual(await heart(page), heartReads(13, true), "a like after a 409 should go through");
    api.next = 429;
    await tapLike();
    assert.deepEqual(await heart(page), heartReads(13, true), "a 429 on unlike should keep the like");
    await toastSays(page, /Try again in a minute\.$/);
    assert.ok((await storedLike(page))?.receipt, "a 429 on unlike should keep the receipt");
  });

  let shareUrl = "";
  await check(`${name} the live link follows the song, not the heart`, async () => {
    await drawLine(page, 0.1, 0.4, rowCentre(4));
    await press(page, how, "#share");
    await page.waitForFunction(() => location.hash.startsWith("#v1."), null, { timeout: 3000 });
    shareUrl = page.url();
    const shared = await addressBar(page);
    await tapLike();
    await tapLike();
    assert.deepEqual(await addressBar(page), shared, "liking should not write the live link or history");
    await drawLine(page, 0.5, 0.8, rowCentre(9));
    await page.waitForFunction((h) => location.href !== h, shared.href, { timeout: 3000 });
    assert.equal(await page.evaluate(() => history.length), shared.length, "the live link still replaces, never pushes");
  });

  await check(`${name} liking leaves the invite to play alone`, async () => {
    const opened = await openPage(browser, `${name} (opened link)`, ctxOptions, shareUrl);
    try {
      assert.ok(await inviteShown(opened.page), "the opened link should invite Play");
      await opened.page.locator("#like").waitFor({ state: "visible", timeout: 3000 });
      await press(opened.page, how, "#like");
      await likeSettled(opened.page);
      assert.equal((await heart(opened.page)).pressed, "true");
      assert.equal(await invitePill(opened.page).isVisible(), true, "liking should not end the invite");
      assert.equal(opened.page.url(), shareUrl, "liking should not change the opened link");
      await press(opened.page, how, "#play");
      await inviteGone(opened.page, "Play");
    } finally {
      await opened.context.close();
    }
  });

  await check(`${name} no cookies`, async () => {
    assert.deepEqual(await context.cookies(), []);
    assert.equal(await page.evaluate(() => document.cookie), "");
    assert.ok(!api.calls.some((c) => c.cookie), "a cookie was sent to the like API");
  });

  if (!phone) {
    // The receipt carries no date: a like from days ago is still taken back by it.
    await check(`${name} unlike on a later day`, async () => {
      if ((await heart(page)).pressed !== "true") await tapLike();
      const left = api.receipts.length;
      await page.clock.install({ time: new Date(Date.now() + 3 * 24 * 3600 * 1000) });
      await page.reload({ waitUntil: "load" });
      await page.locator("#like").waitFor({ state: "visible", timeout: 3000 });
      assert.equal((await heart(page)).pressed, "true");
      await tapLike();
      assert.equal((await heart(page)).pressed, "false");
      assert.equal(api.receipts.length, left - 1, "the like should be gone from the mocked hub");
    });
  }
  await context.close();
}

/** Where the dock, canvas and footer sit, and whether the page scrolls. */
const layout = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return { top: Math.round(b.top * 2) / 2, height: Math.round(b.height * 2) / 2, left: Math.round(b.left * 2) / 2, width: Math.round(b.width * 2) / 2 };
    };
    return { dock: box(".dock"), canvas: box("#canvas-wrap"), foot: box(".foot"), scroll: document.documentElement.scrollHeight, wide: document.documentElement.scrollWidth > window.innerWidth };
  });

// The heart fits the dock: on a phone it shares the sliders' row and the dock is no
// taller (a big count is shortened, 1.9k); on the desktop the dock keeps its one row.
async function likesLayout(browser, name, viewport, phone, total = 12) {
  const ctxOptions = phone ? { viewport, colorScheme: "light", hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport, colorScheme: "dark" };
  const seen = {};
  for (const mode of ["resting", "ok"]) {
    const { page, context, ok } = await openPage(browser, `${name} (${mode})`, ctxOptions, base, { likes: { mode, total } });
    if (!ok) return context.close();
    if (mode === "ok") await page.locator("#like").waitFor({ state: "visible", timeout: 3000 }).catch(() => fail(`${name}: no heart`));
    seen[mode] = await layout(page);
    if (mode === "ok") {
      seen.rows = await page.evaluate(() => {
        const b = (sel) => document.querySelector(sel).getBoundingClientRect();
        return { like: b("#like"), sliders: b(".sliders"), play: b("#play"), tempo: b("#tempo") };
      });
      seen.heart = await heart(page);
      await noHorizontalOverflow(page, name, "with the heart");
    }
    await page.locator(".dock").screenshot({ path: join(out, `${name}-dock-${mode === "ok" ? "heart" : "no-heart"}.png`) });
    await page.screenshot({ path: join(out, `${name}-${mode === "ok" ? "heart" : "no-heart"}.png`) });
    await context.close();
  }
  await check(`${name} the heart fits the dock`, async () => {
    const [a, b] = [seen.resting, seen.ok];
    assert.equal(b.wide, false, "the heart makes the page scroll sideways");
    assert.deepEqual({ dock: b.dock.height, canvas: b.canvas, foot: b.foot.top, scroll: b.scroll }, { dock: a.dock.height, canvas: a.canvas, foot: a.foot.top, scroll: a.scroll }, "the heart moved or resized the dock, canvas or footer");
    const { like, sliders, play } = seen.rows;
    if (total === 1999) assert.deepEqual(seen.heart, { shown: true, pressed: "false", label: "Like Inkchime, 1999 likes", n: "1.9k" }, "a big count shows short, the label exact");
    if (phone) {
      assert.ok(like.top >= sliders.top - 1 && like.bottom <= sliders.bottom + 1, "on a phone the heart should share the sliders' row");
      assert.ok(like.height >= 40 && like.width >= 44, `the heart is too small to tap (${like.width}x${like.height})`);
    } else {
      assert.ok(Math.abs(like.top - play.top) <= 1 && Math.abs(like.height - play.height) <= 1, "on the desktop the heart should sit in the dock's one row, as tall as Play");
    }
  });
  console.log(`${name}: dock ${seen.ok.dock.height}px tall with or without the heart, canvas ${seen.ok.canvas.width}x${seen.ok.canvas.height}`);
}

// Held sideways, the toast sits over the canvas column, centred on it, and never on the dock (lab#43).
async function landscapeToast(browser, name, viewport) {
  const ctxOptions = { viewport, colorScheme: "light", hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
  const { page, context, ok } = await openPage(browser, name, ctxOptions);
  if (!ok) return context.close();
  const assertOverCanvas = async () => {
    const m = await page.evaluate(() => {
      const box = (sel) => document.querySelector(sel).getBoundingClientRect().toJSON();
      return { toast: box("#toast"), dock: box(".dock"), canvas: box("#canvas-wrap"), text: document.querySelector("#toast").textContent };
    });
    const { toast: t, dock: d, canvas: c } = m;
    const said = `"${m.text.slice(0, 24)}…"`;
    const overlaps = t.left < d.right && t.right > d.left && t.top < d.bottom && t.bottom > d.top;
    assert.ok(!overlaps, `${said} (${t.left.toFixed(1)} to ${t.right.toFixed(1)}) overlaps the dock (${d.left.toFixed(1)} to ${d.right.toFixed(1)})`);
    assert.ok(t.left >= c.left - 0.5 && t.right <= c.right + 0.5, `${said} spans ${t.left.toFixed(1)} to ${t.right.toFixed(1)}, outside the canvas (${c.left.toFixed(1)} to ${c.right.toFixed(1)})`);
    assert.ok(Math.abs(t.left + t.right - (c.left + c.right)) <= 2, `${said} is off centre over the canvas`);
    assert.ok(t.top >= c.top - 0.5 && t.bottom <= c.bottom + 0.5, `${said} runs off the canvas vertically`);
  };
  await check(`${name} toast over the canvas, not the dock`, async () => {
    await drawLine(page, 0.1, 0.5, 0.5);
    await press(page, "tap", "#share");
    await page.waitForFunction(() => /^Link copied/.test(document.querySelector("#toast").textContent), null, { timeout: 3000 });
    await page.waitForTimeout(250);
    await assertOverCanvas();
    await page.screenshot({ path: join(out, `${name}-toast.png`) });
    for (const text of LONG_TOASTS) {
      await page.evaluate((t) => {
        const el = document.querySelector("#toast");
        el.textContent = t;
        el.classList.add("show");
      }, text);
      await page.waitForTimeout(250);
      await assertOverCanvas();
    }
  });
  await context.close();
}

// The side dock is for windows under 500px tall (and wider than tall): a 1024x499 window gets it,
// a 1024x500 desktop window keeps the dock below the canvas. Neither scrolls.
async function dockPlacement(browser) {
  for (const [height, beside] of [[499, true], [500, false]]) {
    const name = `dock-1024x${height}`;
    const { page, context, ok } = await openPage(browser, name, { viewport: { width: 1024, height }, colorScheme: "dark" });
    if (!ok) {
      await context.close();
      continue;
    }
    await page.screenshot({ path: join(out, `${name}.png`) });
    await check(`${name} dock ${beside ? "beside" : "below"} the canvas`, async () => {
      const m = await layout(page);
      if (beside) assert.ok(m.dock.left >= m.canvas.left + m.canvas.width, `the dock (left ${m.dock.left}) should sit beside the canvas (right ${m.canvas.left + m.canvas.width})`);
      else assert.ok(m.dock.top >= m.canvas.top + m.canvas.height, `the dock (top ${m.dock.top}) should sit below the canvas (bottom ${m.canvas.top + m.canvas.height})`);
      assert.ok(m.scroll <= height, `the page is ${m.scroll}px tall in a ${height}px window`);
      assert.equal(m.wide, false, "the page scrolls sideways");
    });
    await context.close();
  }
}

// Both sliders have a name in the accessibility tree at every size (lab#21): the Tempo
// label holds an <output>, so it is tied to the slider with for="tempo". Each is read once (lab#46):
// Brush is named by its visible label alone ("Brush", plus "sets volume" where the slider is wide
// enough to show those words) and described by its hint, and the bpm readout is not a live region,
// so only aria-valuetext says a new tempo.
// Names and descriptions come from the browser's own accessibility tree.
async function sliderNames(browser, name, viewport, phone) {
  const ctxOptions = phone ? { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport };
  const { page, context, ok } = await openPage(browser, name, ctxOptions);
  if (!ok) return context.close();
  const cdp = await context.newCDPSession(page);
  const ax = async (selector) => {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const [node] = (await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false })).nodes;
    const live = node.properties?.find((p) => p.name === "live")?.value?.value;
    return { role: node.role?.value, name: node.name?.value ?? "", description: node.description?.value ?? "", live };
  };
  await check(`${name} both sliders are named`, async () => {
    const tempo = page.getByRole("slider", { name: /tempo/i });
    assert.equal(await tempo.count(), 1, "no slider named Tempo");
    assert.equal(await tempo.getAttribute("id"), "tempo");
    assert.equal(await page.getByRole("slider", { name: /brush/i }).getAttribute("id"), "size", "no slider named Brush");
    assert.equal(await tempo.getAttribute("aria-valuetext"), "90 bpm");
    await tempo.fill("110");
    assert.equal(await tempo.getAttribute("aria-valuetext"), "110 bpm", "aria-valuetext should follow the tempo");
    console.log(`${name}: slider names ${JSON.stringify(await page.locator(".sliders").ariaSnapshot())}`);
  });
  await check(`${name} each slider is read once`, async () => {
    const brush = await ax("#size");
    const brushName = (await page.locator(".slider-note-words").isVisible()) ? "Brush sets volume" : "Brush";
    assert.deepEqual({ role: brush.role, name: brush.name, description: brush.description }, { role: "slider", name: brushName, description: "Thicker lines are louder." }, "the Brush slider's name and description");
    const tempo = await ax("#tempo");
    assert.deepEqual({ role: tempo.role, name: tempo.name }, { role: "slider", name: "Tempo" }, "the Tempo slider's name");
    const readout = await ax("#bpm-out");
    assert.ok(readout.live === undefined || readout.live === "off", `the bpm readout is a live region (live: ${readout.live}), so a tempo change is announced twice`);
    assert.equal(await page.locator("#bpm-out").innerText(), "110 bpm", "the visible readout should follow the tempo");
    console.log(`${name}: Brush "${brush.name}" (${brush.description}), Tempo "${tempo.name}", bpm readout live: ${readout.live ?? "none"}`);
  });
  await context.close();
}

// A phone held sideways: the dock moves beside the canvas, so with or without the heart the page
// doesn't scroll, every control is on screen and big enough to tap, and the canvas keeps its height.
async function landscape(browser, name, viewport) {
  const ctxOptions = { viewport, colorScheme: "light", hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
  const seen = {};
  for (const mode of ["resting", "ok"]) {
    const { page, context, ok } = await openPage(browser, `${name} (${mode})`, ctxOptions, base, { likes: { mode } });
    if (!ok) return context.close();
    if (mode === "ok") await page.locator("#like").waitFor({ state: "visible", timeout: 3000 }).catch(() => fail(`${name}: no heart`));
    else await page.waitForTimeout(200);
    await page.screenshot({ path: join(out, `${name}-${mode === "ok" ? "heart" : "no-heart"}.png`) });
    await check(`${name} (${mode}) fits without scrolling`, async () => {
      const m = await page.evaluate(() => {
        const box = (el) => {
          const b = el.getBoundingClientRect();
          return { what: el.id || el.className || el.tagName, top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height };
        };
        const controls = [...document.querySelectorAll("#canvas-wrap, .chip, .dock button, .dock input[type=range], .foot a")]
          .filter((el) => !el.closest("[hidden]"))
          .map(box);
        return { scroll: document.documentElement.scrollHeight, view: window.innerHeight, controls, canvas: box(document.querySelector("#canvas-wrap")) };
      });
      assert.ok(m.scroll <= m.view, `the page is ${m.scroll}px tall in a ${m.view}px window`);
      const off = m.controls.filter((c) => c.top < -0.5 || c.left < -0.5 || c.bottom > m.view + 0.5 || c.right > viewport.width + 0.5);
      assert.deepEqual(off.map((c) => c.what), [], "controls off the screen");
      const small = m.controls.filter((c) => /chip|^(play|undo|clear|share|like)$/.test(c.what) && (c.height < 44 || c.width < 44));
      assert.deepEqual(small.map((c) => `${c.what} ${c.width}x${c.height}`), [], "touch targets under 44px");
      assert.ok(m.canvas.height >= 200, `the canvas is only ${m.canvas.height}px tall`);
      seen[mode] = m.canvas;
    });
    await noHorizontalOverflow(page, name, mode === "ok" ? "with the heart" : "without the heart");
    if (mode === "ok") {
      await check(`${name} heart shows and draws`, async () => {
        assert.equal(await page.locator("#like").isVisible(), true, "the heart should show");
        await drawLine(page, 0.2, 0.6, rowCentre(5));
        assert.equal((await hook.song(page)).strokes.length, 1, "a line drawn sideways should be added");
      });
    }
    await context.close();
  }
  await check(`${name} the heart leaves the canvas alone`, async () => {
    assert.deepEqual(seen.ok, seen.resting, "the heart moved or resized the canvas");
  });
  console.log(`${name}: canvas ${Math.round(seen.ok?.width)}x${Math.round(seen.ok?.height)}, no scrolling with or without the heart`);
}

// The live hub until its migration (resting: 204 to a quiet GET), unreachable, and slow:
// the canvas draws and plays at once, the heart never shows, and nothing errors.
async function likesQuiet(browser, mode) {
  const name = `likes-${mode}`;
  const init = () => {
    window.__heartSeen = false;
    const look = () => {
      const b = document.querySelector("#like");
      if (b && !b.hidden && b.offsetParent) window.__heartSeen = true;
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  };
  const t0 = Date.now();
  const { page, context, ok } = await openPage(browser, name, { viewport: { width: 1280, height: 900 }, colorScheme: "dark" }, base, { likes: { mode }, init, waitUntil: "load" });
  if (!ok) return context.close();
  const painted = Date.now() - t0;
  await check(`${name} drawing and playback don't wait`, async () => {
    await drawLine(page, 0.1, 0.5, rowCentre(6));
    assert.equal((await hook.song(page)).strokes.length, 1);
    // The line starts a few columns in, so its first note is scheduled a moment after Play.
    const pressed = Date.now();
    await page.locator("#play").click();
    await page.waitForFunction(() => window.__inkchime.events().length > 0, null, { timeout: 4000 });
    const heard = Date.now() - pressed;
    assert.ok(heard < 2500, `the line's first note was scheduled ${heard} ms after Play`);
    await page.locator("#play").click();
    await page.waitForTimeout(mode === "slow" ? 6800 : 800); // the page gives up on a slow answer after 6 s
    assert.equal(await page.evaluate(() => window.__heartSeen), false, "the heart should never show");
    assert.ok(page.likes.calls.some((c) => c.path === "/api/likes?quiet=1"), "the counts should have been asked for");
    assert.ok(page.likes.calls.every((c) => c.method === "GET"), "nothing but the counts should be asked for");
    assert.equal(await page.evaluate(() => location.hash), "", "the address bar should be left alone");
    console.log(`${name}: canvas in ${painted} ms, the line's first note scheduled ${heard} ms after Play, no heart`);
  });
  await context.close();
}

// --- run ---------------------------------------------------------------------------

const launchOptions = existsSync(browserPath) ? { executablePath: browserPath } : {};
const browser = await chromium.launch(launchOptions);
try {
  await session(browser, "desktop-dark", { width: 1280, height: 900 }, "dark", false);
  await session(browser, "phone-light", { width: 390, height: 844 }, "light", true);
  await keyboardDraw(browser, "keys-desktop-dark", { width: 1280, height: 900 }, "dark");
  await keyboardDraw(browser, "keys-desktop-light", { width: 1280, height: 900 }, "light");
  await emptyPlay(browser, "empty-play-desktop", { width: 1280, height: 900 }, false, false);
  await emptyPlay(browser, "empty-play-space", { width: 1280, height: 900 }, false, true);
  await emptyPlay(browser, "empty-play-phone", { width: 390, height: 844 }, true, false);
  await liveLink(browser, "live-desktop", { width: 1280, height: 900 }, false);
  await liveLink(browser, "live-phone", { width: 390, height: 844 }, true);
  await heldUndo(browser, "held-undo-desktop", { width: 1280, height: 900 });
  await toastLayout(browser, "toast-phone-light", { width: 390, height: 844 }, "light", true, { short: 2, long: 3 });
  await toastLayout(browser, "toast-phone-dark", { width: 390, height: 844 }, "dark", true, { short: 2, long: 3 });
  await toastLayout(browser, "toast-desktop-dark", { width: 1280, height: 900 }, "dark", false, { short: 1, long: 1 });
  await malformedLinks(browser);
  await fullSong(browser, "full-desktop", { width: 1280, height: 900 }, false);
  await fullSong(browser, "full-phone", { width: 390, height: 844 }, true);
  await likesFlow(browser, "likes-desktop", { width: 1280, height: 900 }, "dark", false);
  await likesFlow(browser, "likes-phone", { width: 390, height: 844 }, "light", true);
  await likesLayout(browser, "likes-layout-phone", { width: 390, height: 844 }, true);
  await likesLayout(browser, "likes-layout-small-phone", { width: 320, height: 640 }, true, 1999);
  await likesLayout(browser, "likes-layout-desktop", { width: 1280, height: 900 }, false);
  await landscape(browser, "landscape-phone", { width: 844, height: 390 });
  await landscape(browser, "landscape-small-phone", { width: 667, height: 375 });
  await landscapeToast(browser, "landscape-toast-phone", { width: 844, height: 390 });
  await landscapeToast(browser, "landscape-toast-small-phone", { width: 667, height: 375 });
  await landscapeToast(browser, "landscape-toast-smallest-phone", { width: 568, height: 320 });
  await dockPlacement(browser);
  await sliderNames(browser, "slider-names-phone", { width: 390, height: 844 }, true);
  await sliderNames(browser, "slider-names-landscape", { width: 844, height: 390 }, true);
  await sliderNames(browser, "slider-names-desktop", { width: 1280, height: 900 }, false);
  for (const mode of ["resting", "down", "slow"]) await likesQuiet(browser, mode);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error("PLAYTEST FAIL\n- " + [...new Set(failures)].join("\n- "));
  process.exit(1);
}
console.log(`PLAYTEST PASS (screenshots in ${out})`);
