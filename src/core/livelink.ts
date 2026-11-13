// Once Share has been pressed, the link in the address bar follows the song, so
// reloading (or copying the address bar) always gives the song on screen.
// Plain logic: the page hands in how to read the song, write the hash and wait
// for an idle moment, so this can be unit-tested with `node --test`.
import { prepareShare, songFromHash, songToHash } from "./share.ts";
import type { Song } from "./model.ts";

/**
 * The link for this song, or null if it can't be written faithfully. A song with
 * strokes goes through the same checks as Share. An empty song (after Clear) is a
 * link to an empty canvas that keeps the tempo.
 */
export function linkFor(song: Song): string | null {
  if (song.strokes.length) {
    const shared = prepareShare(song);
    return shared.ok ? shared.hash : null;
  }
  const hash = songToHash(song);
  const back = songFromHash(hash);
  return back && back.bpm === song.bpm && !back.strokes.length ? hash : null;
}

/**
 * What changed the song. Dragging the tempo slider is the only edit that comes as a
 * stream of events; the rest are discrete: a stroke (pen-up or a note placed with the
 * keys), undo, clear, the tempo slider let go, or another song opened in this tab.
 */
export type Edit = "stroke" | "undo" | "clear" | "tempo" | "open" | "tempo-drag";

/**
 * A reload starts from the address it was given, and in Chromium that address is fixed
 * before `pagehide` runs, so a discrete edit is written at once. A drag waits for idle,
 * so the link is encoded at most once per quiet moment rather than once per input event.
 */
export const writesAtOnce = (edit: Edit): boolean => edit !== "tempo-drag";

/** Run `run` at some quiet moment, no sooner than `delayMs` from now; returns a function that cancels it. */
export type Schedule = (run: () => void, delayMs?: number) => () => void;

/**
 * Browsers cap address-bar writes: Safari throws past 100 `replaceState` calls in 30 s,
 * Chromium skips writes and warns. So writes come from a small budget: a burst of
 * `BURST` at once (a single undo, clear or note is never held back), refilled one per
 * `REFILL_MS`, which keeps a held key (auto-repeat) under Safari's pace. An edit that
 * finds the budget empty waits for the next write the budget allows.
 */
export const BURST = 5;
export const REFILL_MS = 350;
/** After the browser refuses a write, try again this much later (or at flush). */
export const RETRY_MS = 1000;

export interface LiveLinkDeps {
  song(): Song;
  /** Write the hash to the address bar. May throw if the browser refuses (rate limit). */
  write(hash: string): void;
  schedule: Schedule;
  /** A clock in ms; defaults to `performance.now()`. */
  now?(): number;
  /** The song has just stopped fitting in a link; the address bar keeps the last one that did. */
  onBehind?(): void;
}

export class LiveLink {
  private readonly deps: LiveLinkDeps;
  private readonly now: () => number;
  private on = false;
  private behind = false;
  /** The browser refused the last write; the next one waits for a retry or flush. */
  private refused = false;
  private cancel: (() => void) | null = null;
  private tokens = BURST;
  private filled: number;

  constructor(deps: LiveLinkDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
    this.filled = this.now();
  }

  /** True once Share has been pressed. */
  get active(): boolean {
    return this.on;
  }

  /** Share has written a link: from now on, keep it in step with the song. */
  start(): void {
    this.on = true;
    this.behind = false;
  }

  /**
   * The song changed. Before Share this does nothing. After it, a discrete edit is
   * written now (see `writesAtOnce`) if the write budget allows; a drag, or an edit
   * in a burst past the budget, leaves one write waiting for later.
   */
  changed(edit: Edit): void {
    if (!this.on) return;
    if (writesAtOnce(edit) && !this.refused && this.take()) return this.sync();
    this.later(writesAtOnce(edit) && !this.refused ? this.untilToken() : 0);
  }

  /**
   * If a write is waiting (a tempo drag, a burst, or one the browser refused), do it
   * now. The page calls this when it is being hidden, so a phone that drops a
   * background tab reopens the latest song.
   */
  flush(): void {
    if (this.cancel) this.sync();
  }

  /**
   * Write the link for the song as it is now, or keep the last good one if it doesn't
   * fit. Never throws: if the browser refuses the write, one write is kept for later.
   */
  sync(): void {
    if (!this.on) return;
    this.cancel?.();
    this.cancel = null;
    const hash = linkFor(this.deps.song());
    if (hash === null) {
      if (!this.behind) this.deps.onBehind?.();
      this.behind = true;
      return;
    }
    try {
      this.deps.write(hash);
    } catch {
      this.refused = true;
      this.later(RETRY_MS);
      return;
    }
    this.refused = false;
    this.behind = false;
  }

  /** Keep one write for later (joining one already waiting). */
  private later(delayMs: number): void {
    if (this.cancel) return;
    this.cancel = this.deps.schedule(() => {
      this.cancel = null;
      // A retry after a refusal goes straight to the browser; anything else waits its turn.
      if (this.refused || this.take()) this.sync();
      else this.later(this.untilToken());
    }, delayMs);
  }

  private refill(): void {
    const t = this.now();
    const gained = (t - this.filled) / REFILL_MS;
    this.tokens = Math.min(BURST, this.tokens + gained);
    this.filled = t;
  }

  private take(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private untilToken(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * REFILL_MS);
  }
}
