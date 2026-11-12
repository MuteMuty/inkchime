// The lookahead scheduler's brain, with no audio in it. A timer calls tick()
// every ~25 ms; tick() returns every step whose start time falls inside the
// next `lookahead` seconds, and the caller hands those to Web Audio with exact
// start times. The timer can wobble; the audio clock does not.

export interface Due {
  /** Column of the loop, 0..cols-1. */
  readonly step: number;
  /** Audio-clock time at which the step starts. */
  readonly when: number;
}

export class LookaheadScheduler {
  private readonly cols: number;
  private stepSec = 0.125;
  /** Audio time at which fraction 0 of the loop (cycle 0) falls. */
  private loopStart = 0;
  /** The next step to hand out, counted without wrapping. */
  private nextIndex = 0;
  private anchor = 0;
  private anchorFraction = 0;

  constructor(cols: number) {
    this.cols = cols;
  }

  /** Audio time at which the loop's column 0 falls (in the current cycle's timeline). */
  get origin(): number {
    return this.loopStart;
  }

  private get loopSec(): number {
    return this.stepSec * this.cols;
  }

  /** Begin (or resume) so that `fraction` of the loop falls at audio time `now`. */
  start(now: number, fraction: number, stepSeconds: number): void {
    this.stepSec = stepSeconds;
    this.anchor = now;
    this.anchorFraction = fraction;
    this.loopStart = now - fraction * this.loopSec;
    this.nextIndex = Math.max(0, Math.ceil(fraction * this.cols - 1e-9));
  }

  /** Every step that starts before now + lookahead and has not been handed out yet. */
  tick(now: number, lookahead: number): Due[] {
    const due: Due[] = [];
    for (;;) {
      const when = this.loopStart + this.nextIndex * this.stepSec;
      if (when >= now + lookahead) break;
      due.push({ step: this.nextIndex % this.cols, when });
      this.nextIndex++;
    }
    return due;
  }

  /** Where the playhead is, 0..1. */
  position(now: number): number {
    if (now <= this.anchor) return this.anchorFraction;
    const cycles = (now - this.loopStart) / this.loopSec;
    return cycles - Math.floor(cycles);
  }

  /** Change tempo without moving the playhead or repeating a step. */
  setStepSeconds(now: number, stepSeconds: number): void {
    const cycles = (now - this.loopStart) / this.loopSec;
    const fraction = now <= this.anchor ? this.anchorFraction : cycles - Math.floor(cycles);
    const absolute = now <= this.anchor ? this.anchorFraction : cycles;
    this.stepSec = stepSeconds;
    this.loopStart = now - absolute * this.loopSec;
    this.anchor = now;
    this.anchorFraction = fraction;
  }
}
