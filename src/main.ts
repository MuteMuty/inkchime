import "./style.css";
import { BPM_DEFAULT, BPM_MAX, BPM_MIN, GRID, SIZE_DEFAULT, VOICE_COUNT, VOICE_NAMES, type Note, type Song, type Stroke } from "./core/model.ts";
import { History } from "./core/history.ts";
import { notesByStep, songToNotes } from "./core/notes.ts";
import { degreeToMidi, gridYToDegree, loopSeconds, sizeToGain, stepSeconds } from "./core/pitch.ts";
import { songFromHash, songToHash } from "./core/share.ts";
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
  const ctx = engine.unlock();
  engine.note(color, degreeToMidi(degree), sizeToGain(size) * 0.7, ctx.currentTime + 0.005, stepSeconds(bpm));
}

const stage = new Stage($("#canvas-wrap"), {
  onStart(_x, y) {
    previewDegree = -1;
    $("#hint").classList.add("gone");
    preview(y);
  },
  onMove: (_x, y) => preview(y),
  onEnd(raw) {
    const pts = normalizePoints(raw);
    if (!pts.length) return;
    const stroke: Stroke = { color, size, pts };
    edits.set([...edits.value, stroke]);
    songChanged();
    stage.addStroke(stroke);
  },
});

// --- keeping everything in step ---------------------------------------------------

const playBtn = $<HTMLButtonElement>("#play");
const undoBtn = $<HTMLButtonElement>("#undo");
const clearBtn = $<HTMLButtonElement>("#clear");
const hint = $("#hint");

function songChanged(): void {
  buckets = notesByStep(songToNotes(song()));
  undoBtn.setAttribute("aria-disabled", String(!edits.canUndo));
  clearBtn.setAttribute("aria-disabled", String(!edits.value.length));
  hint.classList.toggle("gone", edits.value.length > 0);
}

/** Redraw everything after undo, clear or opening a link. */
function songReplaced(): void {
  songChanged();
  stage.setStrokes(edits.value);
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
  else player.play();
  syncPlayUi();
  kick();
}

function undo(): void {
  if (edits.undo()) songReplaced();
}

function clearAll(): void {
  if (!edits.value.length) return;
  edits.set([]);
  songReplaced();
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
function setBpm(v: number): void {
  bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, v));
  player.setBpm(bpm);
  $("#bpm-out").textContent = `${bpm} bpm`;
}
tempoInput.addEventListener("input", () => setBpm(Number(tempoInput.value)));

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
  lastSharedHash = songToHash(song());
  setHash(lastSharedHash);
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Link copied. Anyone who opens it hears your song.");
  } catch {
    toast("The link is in the address bar. Copy it from there.");
  }
});
function setHash(hash: string): void {
  window.history.replaceState(null, "", location.pathname + location.search + hash);
}

// Pasting a different song link into this tab opens that song.
window.addEventListener("hashchange", () => {
  if (location.hash === lastSharedHash) return;
  const next = songFromHash(location.hash);
  if (next) loadSong(next);
});

function loadSong(next: Song): void {
  if (player.playing) toggle();
  setBpm(next.bpm);
  tempoInput.value = String(next.bpm);
  edits.reset(next.strokes);
  songReplaced();
}

// --- start up ------------------------------------------------------------------------

tempoInput.value = String(bpm);
setSize(size);
setColor(color);
setBpm(bpm);
songChanged();
stage.setStrokes(edits.value);
syncPlayUi();
stage.setPlayhead(0);

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
    }),
  }),
});
