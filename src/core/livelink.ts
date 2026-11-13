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

/** Run `run` at some quiet moment later; returns a function that cancels it. */
export type Schedule = (run: () => void) => () => void;

export interface LiveLinkDeps {
  song(): Song;
  write(hash: string): void;
  schedule: Schedule;
  /** The song has just stopped fitting in a link; the address bar keeps the last one that did. */
  onBehind?(): void;
}

export class LiveLink {
  private readonly deps: LiveLinkDeps;
  private on = false;
  private behind = false;
  private cancel: (() => void) | null = null;

  constructor(deps: LiveLinkDeps) {
    this.deps = deps;
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
   * written now (see `writesAtOnce`); a drag queues one write for the next idle moment.
   */
  changed(edit: Edit): void {
    if (!this.on) return;
    if (writesAtOnce(edit)) return this.sync();
    if (this.cancel) return;
    this.cancel = this.deps.schedule(() => {
      this.cancel = null;
      this.sync();
    });
  }

  /**
   * If a write is waiting for idle (a tempo drag), do it now. The page calls this when
   * it is being hidden, so a phone that drops a background tab reopens the latest song.
   */
  flush(): void {
    if (this.cancel) this.sync();
  }

  /** Write the link for the song as it is now, or keep the last good one if it doesn't fit. */
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
    this.behind = false;
    this.deps.write(hash);
  }
}
