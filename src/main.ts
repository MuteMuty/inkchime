import "./style.css";
import { BPM_DEFAULT, BPM_MAX, BPM_MIN, COLS, GRID, ROWS, canAddStroke, SIZE_DEFAULT, VOICE_COUNT, VOICE_NAMES, type Note, type Song, type Stroke } from "./core/model.ts";
import { History } from "./core/history.ts";
import { notesByStep, songToNotes } from "./core/notes.ts";
import { degreeToMidi, gridYToDegree, loopSeconds, sizeToGain, stepSeconds } from "./core/pitch.ts";
import { prepareShare, songFromHash } from "./core/share.ts";
import { LiveLink, type Edit, type Schedule } from "./core/livelink.ts";
import { PlayInvite } from "./core/invite.ts";
import { CURSOR_START, cursorStroke, describeCursor, describeNote, moveCursor } from "./core/keypen.ts";
import { normalizePoints } from "./core/stroke.ts";
import { AudioEngine } from "./audio/engine.ts";
import { Player, type NoteEvent } from "./audio/player.ts";
import { Stage, brushPx } from "./ui/stage.ts";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

// --- state -----------------------------------------------------------------

const fromLink = songFromHash(location.hash); // null for no hash or a broken one: start with an empty canvas
let bpm = fromLink?.bpm ?? BPM_DEFAULT;
const edits = new History<readonly Stroke[]>(fromLink?.strokes ?? []);
let color = 0;
let size = SIZE_DEFAULT;
let buckets: Note[][] = [];
let lastSharedHash = "";

const song = (): Song => ({ bpm, strokes: edits.value });

/** Waits for a quiet moment, so encoding the link never lands in the middle of drawing. */
const idle: Schedule = (run) => {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(run, { timeout: 300 });
    return () => cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, 100);
  return () => clearTimeout(id);
};
/** The first quiet moment at least `delayMs` from now. */
const whenIdle: Schedule = (run, delayMs = 0) => {
  if (!delayMs) return idle(run);
  let cancel = (): void => {};
  const id = window.setTimeout(() => (cancel = idle(run)), delayMs);
  return () => (clearTimeout(id), cancel());
};
// After Share, the address bar follows the song (see core/livelink.ts): a discrete edit is
// written at once, a tempo drag at the next idle moment, and a held key at the pace the
// browser allows. A write the browser refuses is tried again later. Before Share, nothing changes.
const live = new LiveLink({
  song,
  write: (hash) => setHash(hash),
  schedule: whenIdle,
  onBehind: () => toast("This song is now too big for a link. The address bar keeps the last version that fit."),
});
// When the tab is hidden or unloaded, write a tempo drag still waiting for idle.
window.addEventListener("pagehide", () => live.flush());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") live.flush();
});

// --- audio -----------------------------------------------------------------

const engine = new AudioEngine();
const events: NoteEvent[] = [];
const player = new Player(engine, {
  buckets: () => buckets,
  bpm: () => bpm,
  onNote(e) {
    events.push(e);
    if (events.length > 4000) events.splice(0, events.length - 4000);
    stage.ping(e.when, e.step, e.degree, e.voice);
    kick();
  },
});

// Wake the audio on the very first gesture, so the first note is not late.
for (const type of ["pointerdown", "keydown"] as const) document.addEventListener(type, () => engine.unlock(), { capture: true, passive: true });

// --- drawing surface -----------------------------------------------------------

let previewDegree = -1;
let previewAt = 0;
/** A short note under the pen, so you hear the pitch you are drawing at. */
function preview(yFraction: number): void {
  const degree = gridYToDegree(yFraction * GRID);
  const now = performance.now();
  if (degree === previewDegree || now - previewAt < 70) return;
  previewDegree = degree;
  previewAt = now;
  sound(degree);
}
/** One short note now, in the current colour and size. */
function sound(degree: number): void {
  const ctx = engine.unlock();
  engine.note(color, degreeToMidi(degree), sizeToGain(size) * 0.7, ctx.currentTime + 0.005, stepSeconds(bpm));
}

/** Is there room for one more stroke? If not, say so. */
function roomForStroke(): boolean {
  if (canAddStroke(edits.value.length)) return true;
  toast("That's the most this song can hold. Undo or clear to draw more.");
  return false;
}

/** Add a finished stroke as one edit that can be undone: at pen-up, or a note placed with the keys. */
function commitStroke(stroke: Stroke): void {
  edits.set([...edits.value, stroke]);
  songChanged("stroke");
  stage.addStroke(stroke);
}

const wrap = $("#canvas-wrap");
const stage = new Stage(wrap, {
  canStart: roomForStroke,
  onStart(_x, y) {
    previewDegree = -1;
    $("#hint").classList.add("gone");
    endInvite();
    preview(y);
  },
  onMove: (_x, y) => preview(y),
  onEnd(raw) {
    const pts = normalizePoints(raw);
    if (!pts.length || !canAddStroke(edits.value.length)) return;
    commitStroke({ color, size, pts });
  },
});

// --- drawing with keys -------------------------------------------------------------
// Tab reaches the canvas. Arrow keys move a cursor over the grid, Enter or N places a
// short note in that cell (see core/keypen.ts), and a polite live region reads it out.

const cursorEl = $("#cursor");
const say = $("#say");
let cursor = CURSOR_START;

function showCursor(): void {
  cursorEl.style.left = `${(cursor.col * 100) / COLS}%`;
  cursorEl.style.top = `${(cursor.row * 100) / ROWS}%`;
  cursorEl.style.width = `${100 / COLS}%`;
  cursorEl.style.height = `${100 / ROWS}%`;
}

/** Read out in the polite live region. The same words twice (the same note again) still change the text, so they are read again. */
function speak(text: string): void {
  say.textContent = say.textContent === text ? `${text}\u00a0` : text;
}

function placeNote(): void {
  if (!roomForStroke()) return;
  endInvite();
  commitStroke(cursorStroke(cursor, color, size));
  sound(ROWS - 1 - cursor.row);
  speak(describeNote(cursor, color));
}

wrap.addEventListener("keydown", (e) => {
  // Ctrl or ⌘ Z, Space and Tab are left to the page; nothing here while a pen is down.
  if (e.ctrlKey || e.metaKey || e.altKey || stage.drawing) return;
  const next = moveCursor(cursor, e.key);
  const place = e.key === "Enter" || e.key === "n" || e.key === "N";
  if (!next && !place) return;
  e.preventDefault();
  // Show the cursor, even if the canvas was focused or last used with a pointer.
  wrap.classList.add("keys");
  wrap.classList.remove("pointer");
  if (next) {
    cursor = next;
    showCursor();
    speak(describeCursor(cursor));
  } else if (!e.repeat) placeNote();
});
// Drawing with a pointer hides the cursor until the next key; leaving the canvas forgets both.
wrap.addEventListener("pointerdown", () => {
  wrap.classList.remove("keys");
  wrap.classList.add("pointer");
});
wrap.addEventListener("blur", () => wrap.classList.remove("keys", "pointer"));

// --- keeping everything in step ---------------------------------------------------

const playBtn = $<HTMLButtonElement>("#play");
const undoBtn = $<HTMLButtonElement>("#undo");
const clearBtn = $<HTMLButtonElement>("#clear");
const hint = $("#hint");

function songChanged(edit: Edit): void {
  buckets = notesByStep(songToNotes(song()));
  undoBtn.setAttribute("aria-disabled", String(!edits.canUndo));
  clearBtn.setAttribute("aria-disabled", String(!edits.value.length));
  hint.classList.toggle("gone", edits.value.length > 0);
  live.changed(edit);
}

/** Redraw everything after undo, clear or opening a link. The canvas first, then the link. */
function songReplaced(edit: Edit): void {
  stage.setStrokes(edits.value);
  songChanged(edit);
}

let raf = 0;
function kick(): void {
  if (!raf) raf = requestAnimationFrame(frame);
}
function frame(): void {
  raf = 0;
  const ctx = engine.ctx;
  // Show what is being heard, not what is queued: shift by the output latency.
  const latency = ctx ? ctx.outputLatency || ctx.baseLatency || 0 : 0;
  stage.setPlayhead(player.position(latency));
  const ringsLeft = stage.drawFx(ctx ? ctx.currentTime - latency : 0);
  if (player.playing || ringsLeft) kick();
}

function syncPlayUi(): void {
  const playing = player.playing;
  if (playing) $("#playhead").classList.add("on");
  $("#play-label").textContent = playing ? "Pause" : "Play";
  $("svg.icon-play").toggleAttribute("hidden", playing);
  $("svg.icon-pause").toggleAttribute("hidden", !playing);
}

function toggle(): void {
  if (player.playing) player.pause();
  else {
    player.play();
    endInvite();
    // The playhead still runs, so a line drawn now is heard; just say why it is quiet.
    if (!edits.value.length) toast("Nothing to play yet. Draw a line first.");
  }
  syncPlayUi();
  kick();
}

function undo(): void {
  if (edits.undo()) songReplaced("undo");
}

function clearAll(): void {
  if (!edits.value.length) return;
  edits.set([]);
  endInvite();
  songReplaced("clear");
}

// --- controls ------------------------------------------------------------------------

playBtn.addEventListener("click", toggle);
undoBtn.addEventListener("click", undo);
clearBtn.addEventListener("click", clearAll);

function setColor(c: number): void {
  color = c;
  stage.setBrush(color, size);
  document.documentElement.style.setProperty("--accent", `var(--c${c})`);
}
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="voice"]')) {
  input.addEventListener("change", () => input.checked && setColor(Number(input.value)));
}

const sizeInput = $<HTMLInputElement>("#size");
function setSize(s: number): void {
  size = s;
  stage.setBrush(color, size);
  const dot = $("#brush-dot");
  dot.style.width = dot.style.height = `${brushPx(size) * 0.6}px`;
}
sizeInput.addEventListener("input", () => setSize(Number(sizeInput.value)));

const tempoInput = $<HTMLInputElement>("#tempo");
/** Set the tempo; `edit` says how the live link should take it (none while a song is being loaded). */
function setBpm(v: number, edit?: Edit): void {
  bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, v));
  player.setBpm(bpm);
  $("#bpm-out").textContent = `${bpm} bpm`;
  if (edit) live.changed(edit);
}
// While the slider moves the link waits for idle; the value it is let go at is written at once.
tempoInput.addEventListener("input", () => setBpm(Number(tempoInput.value), "tempo-drag"));
tempoInput.addEventListener("change", () => setBpm(Number(tempoInput.value), "tempo"));

// Space plays or pauses, but never steals the key from a button or link that has focus.
function keepsSpace(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("button, a[href], select, textarea, summary")) return true;
  return target instanceof HTMLInputElement && target.type !== "range";
}
window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  } else if (e.code === "Space" && !mod && !e.altKey && !keepsSpace(e.target)) {
    e.preventDefault();
    if (!e.repeat) toggle();
  }
});

// --- share ---------------------------------------------------------------------------

const toastEl = $("#toast");
let toastTimer = 0;
function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 2600);
}

$("#share").addEventListener("click", async () => {
  if (!edits.value.length) return toast("Draw something first, then share it.");
  // Only hand out a link that has been opened again here and found to be this song.
  const shared = prepareShare(song());
  if (!shared.ok) return toast("This song is too big to share as a link. Undo or clear a few lines and try again.");
  live.start();
  // If the browser refuses the address-bar write just now, the link still follows a moment later.
  try {
    setHash(shared.hash);
  } catch {
    live.changed("open");
  }
  try {
    await navigator.clipboard.writeText(location.origin + location.pathname + location.search + shared.hash);
    toast("Link copied. Anyone who opens it hears your song.");
  } catch {
    toast("The link is in the address bar. Copy it from there.");
  }
});
/**
 * Replaces the address, so the link never adds a Back step. The entry is marked as
 * shared: the mark lives only in this tab's history, so a reload keeps following
 * the song, while the same link opened anywhere else starts as before.
 */
const SHARED = { inkchime: "shared" } as const;
const wasShared = (): boolean => (window.history.state as typeof SHARED | null)?.inkchime === SHARED.inkchime;
function setHash(hash: string): void {
  // Throws if the browser refuses (Safari: past 100 writes in 30 s); LiveLink catches it.
  if (location.hash !== hash || !wasShared()) window.history.replaceState(SHARED, "", location.pathname + location.search + hash);
  lastSharedHash = hash;
}

// Pasting a different song link into this tab opens that song.
window.addEventListener("hashchange", () => {
  if (location.hash === lastSharedHash) return;
  const next = songFromHash(location.hash);
  if (next) loadSong(next);
});

function loadSong(next: Song): void {
  if (player.playing) toggle();
  // Opening another song here is the visitor's own doing: they know it is a song.
  endInvite();
  setBpm(next.bpm);
  tempoInput.value = String(next.bpm);
  edits.reset(next.strokes);
  songReplaced("open");
}

// --- the invite to press play ------------------------------------------------------

// A song link opened in a tab that never shared it (the author reloading their own
// live link has the shared mark) gets a line saying it is a song: browsers can't autoplay.
const invite = new PlayInvite(fromLink, wasShared());
const inviteEl = $("#invite");

function showInvite(): void {
  const pill = document.createElement("p");
  pill.className = "invite-pill";
  pill.innerHTML = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor" /></svg>';
  pill.append("Someone sent you a song. Press play to hear it.");
  inviteEl.append(pill);
  playBtn.classList.add("invited");
  playBtn.setAttribute("aria-describedby", "invite");
}

/** The visitor played, drew, cleared or opened another song: hide the invite for good. */
function endInvite(): void {
  if (!invite.end()) return;
  inviteEl.classList.add("gone");
  playBtn.classList.remove("invited");
  playBtn.removeAttribute("aria-describedby");
}

// --- start up ------------------------------------------------------------------------

tempoInput.value = String(bpm);
setSize(size);
setColor(color);
setBpm(bpm);
songChanged("open");
stage.setStrokes(edits.value);
syncPlayUi();
// Reloading a tab where Share was pressed: keep following the song.
if (fromLink && wasShared()) {
  lastSharedHash = location.hash;
  live.start();
}
stage.setPlayhead(0);
showCursor();
// Filled a moment after load, so screen readers notice the status region change and read it.
if (invite.showing) requestAnimationFrame(() => invite.showing && showInvite());

// Read-only view for the playtest: headless browsers can't be heard, so it
// reports what was handed to Web Audio instead.
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
Object.defineProperty(window, "__inkchime", {
  value: Object.freeze({
    voices: VOICE_NAMES,
    voiceCount: VOICE_COUNT,
    song: (): Song => clone(song()),
    /** The schedule the song should produce, computed straight from the strokes. */
    schedule: (): Note[] => clone(songToNotes(song())),
    /** Every note handed to Web Audio so far. */
    events: (): NoteEvent[] => clone(events),
    state: () => ({
      playing: player.playing,
      bpm,
      loopSeconds: loopSeconds(bpm),
      origin: player.origin,
      audio: engine.ctx?.state ?? "none",
      time: engine.ctx?.currentTime ?? 0,
      position: player.position(),
      hash: location.hash,
      cursor: { ...cursor },
    }),
  }),
});
