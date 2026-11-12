// Play/pause and the lookahead loop: a 25 ms timer asks the scheduler which
// columns start in the next 120 ms and hands their notes to Web Audio with exact
// start times. Timer jitter never reaches the sound.
import { COLS, type Note } from "../core/model.ts";
import { LookaheadScheduler } from "../core/scheduler.ts";
import { loopSeconds, stepSeconds } from "../core/pitch.ts";
import type { AudioEngine } from "./engine.ts";

const TICK_MS = 25;
const LOOKAHEAD = 0.12;
/** Delay before the first step after pressing play, so the graph is ready. */
const START_DELAY = 0.04;

/** What was handed to Web Audio. The test hook records these. */
export interface NoteEvent {
  /** Audio-clock start time. */
  readonly when: number;
  /** Seconds into the loop the note belongs at (step * step length). */
  readonly loopTime: number;
  readonly step: number;
  readonly degree: number;
  readonly midi: number;
  readonly gain: number;
  readonly voice: number;
}

export interface PlayerHooks {
  buckets(): readonly (readonly Note[])[];
  bpm(): number;
  onNote(e: NoteEvent): void;
}

export class Player {
  playing = false;
  private readonly engine: AudioEngine;
  private readonly hooks: PlayerHooks;
  private readonly sched = new LookaheadScheduler(COLS);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Where the playhead rests while paused, 0..1. */
  private resting = 0;

  constructor(engine: AudioEngine, hooks: PlayerHooks) {
    this.engine = engine;
    this.hooks = hooks;
  }

  play(): void {
    if (this.playing) return;
    const ctx = this.engine.unlock();
    this.sched.start(ctx.currentTime + START_DELAY, this.resting, stepSeconds(this.hooks.bpm()));
    this.playing = true;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  pause(): void {
    if (!this.playing) return;
    const ctx = this.engine.ctx!;
    this.resting = this.sched.position(ctx.currentTime);
    this.playing = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.engine.cut();
  }

  /** Follow a tempo change without moving the playhead. */
  setBpm(bpm: number): void {
    if (this.playing) this.sched.setStepSeconds(this.engine.ctx!.currentTime, stepSeconds(bpm));
  }

  /** Playhead position 0..1. `latency` shifts it to match what is being heard, not what is queued. */
  position(latency = 0): number {
    const ctx = this.engine.ctx;
    return this.playing && ctx ? this.sched.position(ctx.currentTime - latency) : this.resting;
  }

  /** Audio time of loop position 0 in the current cycle (for the test hook). */
  get origin(): number {
    return this.sched.origin;
  }

  private tick(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    if (ctx.state !== "running") void ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const step = stepSeconds(this.hooks.bpm());
    const buckets = this.hooks.buckets();
    for (const due of this.sched.tick(now, LOOKAHEAD)) {
      // A step that is already well in the past (the tab stalled) is skipped, not played in a burst.
      if (due.when < now - 0.05) continue;
      for (const n of buckets[due.step]) {
        this.engine.note(n.voice, n.midi, n.gain, due.when, step);
        this.hooks.onNote({ when: due.when, loopTime: due.step * step, step: due.step, degree: n.degree, midi: n.midi, gain: n.gain, voice: n.voice });
      }
    }
  }

  /** Loop length in seconds at the current tempo. */
  get loopSeconds(): number {
    return loopSeconds(this.hooks.bpm());
  }
}
