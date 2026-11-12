// Owns the AudioContext. It is created on the first user gesture and resumed
// right then, so the first sound is not held up waiting for a second tap.
import { VOICES, makeNoise } from "./voices.ts";
import { midiToFreq } from "../core/pitch.ts";

export class AudioEngine {
  ctx: AudioContext | null = null;
  private comp!: DynamicsCompressorNode;
  private bus!: GainNode;
  private noise!: AudioBuffer;

  /** Create the context if needed and ask it to run. Safe to call from every gesture. */
  unlock(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      // A gentle limiter so a busy song never clips.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 12;
      comp.ratio.value = 6;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;
      const master = ctx.createGain();
      master.gain.value = 0.8;
      comp.connect(master).connect(ctx.destination);
      this.comp = comp;
      this.bus = ctx.createGain();
      this.bus.connect(comp);
      this.noise = makeNoise(ctx);
      this.ctx = ctx;
    }
    if (this.ctx.state !== "running") void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** Start one note at an exact audio-clock time. */
  note(voice: number, midi: number, gain: number, when: number, step: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    VOICES[voice](ctx, this.bus, this.noise, { freq: midiToFreq(midi), gain, when, step });
  }

  /** Fade out everything already scheduled (pause), then use a fresh bus for what comes next. */
  cut(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const old = this.bus;
    const now = ctx.currentTime;
    old.gain.cancelScheduledValues(now);
    old.gain.setValueAtTime(old.gain.value, now);
    old.gain.linearRampToValueAtTime(0, now + 0.04);
    setTimeout(() => old.disconnect(), 250);
    this.bus = ctx.createGain();
    this.bus.connect(this.comp);
  }
}
