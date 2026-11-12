// The four instruments. Each one is built from oscillators, filters and noise
// at the moment a note starts: no samples, nothing downloaded.

export interface VoiceParams {
  /** Frequency in Hz. */
  readonly freq: number;
  /** 0..1, from brush thickness. */
  readonly gain: number;
  /** Audio-clock start time. */
  readonly when: number;
  /** Length of one loop column in seconds, so sustained voices can match the tempo. */
  readonly step: number;
}

export type VoiceFn = (ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, p: VoiceParams) => void;

const FLOOR = 0.0001;

function osc(ctx: BaseAudioContext, type: OscillatorType, freq: number, t0: number, t1: number, detune = 0): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  o.start(t0);
  o.stop(t1);
  return o;
}

/** A gain node with a fast attack and an exponential decay to silence. */
function pluckEnv(ctx: BaseAudioContext, out: AudioNode, t0: number, peak: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(FLOOR, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(FLOOR, t0 + attack + decay);
  g.connect(out);
  return g;
}

/** Bell: two-operator FM. The modulator's depth dies away, so the strike is bright and the tail is pure. */
const bell: VoiceFn = (ctx, out, _noise, { freq, gain, when }) => {
  const end = when + 2.2;
  const amp = pluckEnv(ctx, out, when, gain * 0.5, 0.004, 2.0);
  const carrier = osc(ctx, "sine", freq, when, end);
  const mod = osc(ctx, "sine", freq * 3.5, when, end);
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(freq * 2.4, when);
  depth.gain.exponentialRampToValueAtTime(freq * 0.04, when + 0.9);
  mod.connect(depth).connect(carrier.frequency);
  carrier.connect(amp);
  // A quiet inharmonic partial gives the glassy shimmer.
  const shimmer = pluckEnv(ctx, out, when, gain * 0.09, 0.003, 0.7);
  osc(ctx, "sine", freq * 2.76, when, when + 0.8).connect(shimmer);
};

/** Pluck: bright sawtooth through a filter that closes quickly, like a string that has been plucked. */
const pluck: VoiceFn = (ctx, out, _noise, { freq, gain, when }) => {
  const end = when + 1.1;
  const amp = pluckEnv(ctx, out, when, gain * 0.34, 0.003, 0.95);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 1.4;
  lp.frequency.setValueAtTime(Math.min(freq * 8, 9000), when);
  lp.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.3, 200), when + 0.35);
  lp.connect(amp);
  osc(ctx, "sawtooth", freq, when, end, -4).connect(lp);
  osc(ctx, "sawtooth", freq, when, end, 4).connect(lp);
};

/** Pad: slow-blooming detuned saws and a sine under a soft low-pass. It rings a little past its column. */
const pad: VoiceFn = (ctx, out, _noise, { freq, gain, when, step }) => {
  const hold = Math.max(step, 0.12);
  const end = when + hold + 0.9;
  const peak = gain * 0.26;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(FLOOR, when);
  amp.gain.linearRampToValueAtTime(peak, when + 0.14);
  amp.gain.setValueAtTime(peak, when + hold);
  amp.gain.exponentialRampToValueAtTime(FLOOR, end - 0.02);
  amp.connect(out);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 0.7;
  lp.frequency.setValueAtTime(Math.min(freq * 3, 1600), when);
  lp.frequency.linearRampToValueAtTime(Math.min(freq * 5, 2600), when + hold);
  lp.connect(amp);
  osc(ctx, "sawtooth", freq, when, end, -8).connect(lp);
  osc(ctx, "sawtooth", freq, when, end, 8).connect(lp);
  osc(ctx, "sine", freq, when, end).connect(lp);
};

/** Tap: a wooden mallet. A short sine body plus a click of band-passed noise tuned to the pitch. */
const tap: VoiceFn = (ctx, out, noise, { freq, gain, when }) => {
  const end = when + 0.6;
  const body = pluckEnv(ctx, out, when, gain * 0.62, 0.002, 0.34);
  const o = osc(ctx, "sine", freq, when, end);
  o.frequency.setValueAtTime(freq * 1.03, when);
  o.frequency.exponentialRampToValueAtTime(freq, when + 0.03);
  o.connect(body);
  const overtone = pluckEnv(ctx, out, when, gain * 0.12, 0.002, 0.1);
  osc(ctx, "sine", freq * 4, when, when + 0.2).connect(overtone);
  const click = ctx.createBufferSource();
  click.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = Math.min(freq * 2, 8000);
  bp.Q.value = 5;
  const clickEnv = pluckEnv(ctx, out, when, gain * 0.5, 0.001, 0.035);
  click.connect(bp).connect(clickEnv);
  click.start(when);
  click.stop(when + 0.06);
};

/** Index = colour index. */
export const VOICES: readonly VoiceFn[] = [bell, pluck, pad, tap];

/** One second of white noise from a fixed seed, shared by every noisy voice. */
export function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
  const data = buf.getChannelData(0);
  let s = 22222;
  for (let i = 0; i < data.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    data[i] = s / 2 ** 31 - 1;
  }
  return buf;
}
