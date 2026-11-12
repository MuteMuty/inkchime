// The drawing surface. Three stacked canvases keep drawing at 60 fps:
//   paper  committed strokes and the pitch grid, redrawn only when the song changes
//   live   the stroke being drawn, extended one small curve per pointer event
//   fx     the rings that bloom as notes sound, cleared and redrawn only while there are rings
// The playhead is a plain element moved with a transform, so it never touches a canvas.
import { COLS, GRID, ROWS, VOICE_COUNT, type Stroke } from "../core/model.ts";

/** Line width in CSS pixels for a brush size. Screen-only: the sound uses the size number. */
export const brushPx = (size: number): number => 4 + size * 3;

export interface StageHandlers {
  /** Asked before a stroke begins. Return false to ignore this press entirely. */
  canStart(): boolean;
  /** Pointer went down at (x, y), as fractions of the canvas. */
  onStart(x: number, y: number): void;
  onMove(x: number, y: number): void;
  /** Stroke finished. `raw` is x0, y0, x1, y1, ... as fractions of the canvas. */
  onEnd(raw: number[]): void;
}

interface Ping {
  readonly when: number;
  readonly x: number; // fractions of the canvas
  readonly y: number;
  readonly voice: number;
}

const PING_LIFE = 0.7;
const MAX_PINGS = 160;
/** Ignore pointer moves shorter than this many pixels. */
const MIN_MOVE = 1.2;

export class Stage {
  private readonly wrap: HTMLElement;
  private readonly playhead: HTMLElement;
  private readonly paper: CanvasRenderingContext2D;
  private readonly live: CanvasRenderingContext2D;
  private readonly fx: CanvasRenderingContext2D;
  private readonly handlers: StageHandlers;
  private readonly reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  private w = 0;
  private h = 0;
  private dpr = 1;
  private strokes: readonly Stroke[] = [];
  private colors: string[] = [];
  private grid = "";
  private band = "";
  private color = 0;
  private size = 4;
  private pings: Ping[] = [];
  private fxDirty = false;

  // pointer state
  private pointerId = -1;
  private rect: DOMRect | null = null;
  private pts: number[] = []; // CSS pixels

  constructor(wrap: HTMLElement, handlers: StageHandlers) {
    this.wrap = wrap;
    this.handlers = handlers;
    this.playhead = wrap.querySelector<HTMLElement>("#playhead")!;
    const ctx = (id: string) => wrap.querySelector<HTMLCanvasElement>(id)!.getContext("2d")!;
    this.paper = ctx("#paper");
    this.live = ctx("#live");
    this.fx = ctx("#fx");
    this.readPalette();

    new ResizeObserver(() => this.resize()).observe(wrap);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.readPalette();
      this.redraw();
    });
    wrap.addEventListener("pointerdown", (e) => this.down(e));
    wrap.addEventListener("pointermove", (e) => this.move(e));
    wrap.addEventListener("pointerup", (e) => this.up(e));
    wrap.addEventListener("pointercancel", (e) => this.cancel(e));
    this.resize();
  }

  get drawing(): boolean {
    return this.pointerId !== -1;
  }

  setBrush(color: number, size: number): void {
    this.color = color;
    this.size = size;
  }

  setStrokes(strokes: readonly Stroke[]): void {
    this.strokes = strokes;
    this.redraw();
  }

  /** Add one finished stroke without redrawing the rest. */
  addStroke(stroke: Stroke): void {
    this.strokes = [...this.strokes, stroke];
    this.drawStroke(this.paper, this.gridToPx(stroke.pts), stroke.color, stroke.size);
  }

  /** Move the playhead. `fraction` is 0..1 across the canvas. */
  setPlayhead(fraction: number): void {
    this.playhead.style.transform = `translate3d(${(fraction * this.w).toFixed(2)}px,0,0)`;
  }

  /** Queue a ring for the note at (step, degree) that sounds at audio time `when`. */
  ping(when: number, step: number, degree: number, voice: number): void {
    this.pings.push({ when, x: (step + 0.5) / COLS, y: (ROWS - 1 - degree + 0.5) / ROWS, voice });
    if (this.pings.length > MAX_PINGS) this.pings.shift();
  }

  /** Draw the rings for audio time `now`. Returns true while more frames are needed. */
  drawFx(now: number): boolean {
    if (!this.pings.length && !this.fxDirty) return false;
    const g = this.fx;
    g.clearRect(0, 0, this.w, this.h);
    const keep: Ping[] = [];
    for (const p of this.pings) {
      const age = now - p.when;
      if (age > PING_LIFE) continue;
      keep.push(p);
      if (age < 0) continue;
      const t = age / PING_LIFE;
      const r = this.reduceMotion ? 16 : 10 + t * 26;
      g.globalAlpha = (1 - t) * 0.9;
      g.strokeStyle = this.colors[p.voice % VOICE_COUNT];
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(p.x * this.w, p.y * this.h, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
    this.pings = keep;
    this.fxDirty = keep.length > 0;
    return this.fxDirty;
  }

  clearFx(): void {
    this.pings = [];
    this.fxDirty = false;
    this.fx.clearRect(0, 0, this.w, this.h);
  }

  // --- layout and palette -------------------------------------------------

  private readPalette(): void {
    const cs = getComputedStyle(document.documentElement);
    this.colors = Array.from({ length: VOICE_COUNT }, (_, i) => cs.getPropertyValue(`--c${i}`).trim());
    this.grid = cs.getPropertyValue("--grid").trim();
    this.band = cs.getPropertyValue("--band").trim();
  }

  private resize(): void {
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    if (!w || !h) return;
    this.w = w;
    this.h = h;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const g of [this.paper, this.live, this.fx]) {
      const c = g.canvas;
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.lineCap = "round";
      g.lineJoin = "round";
    }
    this.redraw();
    if (this.pts.length) this.redrawLive();
  }

  private gridToPx(pts: readonly number[]): number[] {
    const out = new Array<number>(pts.length);
    for (let i = 0; i < pts.length; i += 2) {
      out[i] = (pts[i] / GRID) * this.w;
      out[i + 1] = (pts[i + 1] / GRID) * this.h;
    }
    return out;
  }

  private redraw(): void {
    const g = this.paper;
    g.clearRect(0, 0, this.w, this.h);
    const rowH = this.h / ROWS;
    // Faint bands mark every C, so the scale's octaves can be seen.
    g.fillStyle = this.band;
    for (let degree = 0; degree < ROWS; degree += 5) g.fillRect(0, (ROWS - 1 - degree) * rowH, this.w, rowH);
    g.strokeStyle = this.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (let r = 1; r < ROWS; r++) {
      const y = Math.round(r * rowH) + 0.5;
      g.moveTo(0, y);
      g.lineTo(this.w, y);
    }
    for (let beat = 1; beat < 8; beat++) {
      const x = Math.round((beat * this.w) / 8) + 0.5;
      g.moveTo(x, 0);
      g.lineTo(x, this.h);
    }
    g.stroke();
    for (const s of this.strokes) this.drawStroke(g, this.gridToPx(s.pts), s.color, s.size);
  }

  /** A smooth path through the points: quadratic curves between midpoints. */
  private drawStroke(g: CanvasRenderingContext2D, p: number[], color: number, size: number): void {
    const n = p.length / 2;
    if (!n) return;
    const width = brushPx(size);
    g.strokeStyle = g.fillStyle = this.colors[color % VOICE_COUNT];
    g.lineWidth = width;
    if (n === 1) {
      g.beginPath();
      g.arc(p[0], p[1], width / 2, 0, Math.PI * 2);
      g.fill();
      return;
    }
    g.beginPath();
    g.moveTo(p[0], p[1]);
    for (let i = 1; i < n - 1; i++) g.quadraticCurveTo(p[2 * i], p[2 * i + 1], (p[2 * i] + p[2 * i + 2]) / 2, (p[2 * i + 1] + p[2 * i + 3]) / 2);
    g.lineTo(p[2 * n - 2], p[2 * n - 1]);
    g.stroke();
  }

  // --- pointer ------------------------------------------------------------

  private pos(e: PointerEvent): [number, number] {
    const r = this.rect!;
    return [Math.min(this.w, Math.max(0, e.clientX - r.left)), Math.min(this.h, Math.max(0, e.clientY - r.top))];
  }

  private down(e: PointerEvent): void {
    if (this.pointerId !== -1) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!this.handlers.canStart()) return;
    this.pointerId = e.pointerId;
    this.wrap.setPointerCapture(e.pointerId);
    this.rect = this.wrap.getBoundingClientRect();
    const [x, y] = this.pos(e);
    this.pts = [x, y];
    this.liveStyle();
    this.drawLiveTail();
    this.handlers.onStart(x / this.w, y / this.h);
  }

  private move(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e]) this.addPoint(...this.pos(ev));
  }

  private up(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    this.addPoint(...this.pos(e));
    const raw = this.pts.map((v, i) => (i % 2 ? v / this.h : v / this.w));
    this.finish(e);
    this.handlers.onEnd(raw);
  }

  private cancel(e: PointerEvent): void {
    if (e.pointerId === this.pointerId) this.finish(e);
  }

  private finish(e: PointerEvent): void {
    this.pointerId = -1;
    this.pts = [];
    if (this.wrap.hasPointerCapture(e.pointerId)) this.wrap.releasePointerCapture(e.pointerId);
    this.live.clearRect(0, 0, this.w, this.h);
  }

  private addPoint(x: number, y: number): void {
    const n = this.pts.length;
    if (Math.hypot(x - this.pts[n - 2], y - this.pts[n - 1]) < MIN_MOVE) return;
    this.pts.push(x, y);
    this.drawLiveTail();
    this.handlers.onMove(x / this.w, y / this.h);
  }

  private liveStyle(): void {
    const g = this.live;
    g.strokeStyle = g.fillStyle = this.colors[this.color % VOICE_COUNT];
    g.lineWidth = brushPx(this.size);
  }

  /** Draw only the newest piece of the stroke, so a long stroke costs no more per frame than a short one. */
  private drawLiveTail(): void {
    const g = this.live;
    const p = this.pts;
    const n = p.length / 2;
    if (n === 1) {
      g.beginPath();
      g.arc(p[0], p[1], brushPx(this.size) / 2, 0, Math.PI * 2);
      g.fill();
    } else if (n === 2) {
      g.beginPath();
      g.moveTo(p[0], p[1]);
      g.lineTo(p[2], p[3]);
      g.stroke();
    } else {
      const i = n - 2; // the control point; the curve runs from the previous midpoint to the next one
      const sx = i === 1 ? p[0] : (p[2 * i - 2] + p[2 * i]) / 2;
      const sy = i === 1 ? p[1] : (p[2 * i - 1] + p[2 * i + 1]) / 2;
      g.beginPath();
      g.moveTo(sx, sy);
      g.quadraticCurveTo(p[2 * i], p[2 * i + 1], (p[2 * i] + p[2 * i + 2]) / 2, (p[2 * i + 1] + p[2 * i + 3]) / 2);
      g.stroke();
    }
  }

  private redrawLive(): void {
    this.live.clearRect(0, 0, this.w, this.h);
    this.liveStyle();
    this.drawStroke(this.live, this.pts, this.color, this.size);
  }
}
