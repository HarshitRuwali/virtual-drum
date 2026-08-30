/** Synthesized drum kit (PLAN 6.2) -- zero downloads, zero dependencies.
 *
 * Each piece is rendered ONCE into an AudioBuffer and then played back on a
 * hit, so a strike costs a buffer source and nothing else: no synthesis, no
 * network, no allocation storm on a fast roll. A deterministic PRNG (LCG)
 * makes the kit sound byte-identical on every machine, which is the same
 * property the parity gate relies on for the detector.
 *
 * Three things separate this from a row of beeps:
 *
 *  - VELOCITY. `Hit.velocity` is already normalized 0..1 (PLAN 5.2), mapped
 *    here to gain on a perceptual curve plus a small pitch shift, because a
 *    hard hit on a real drum is both louder AND slightly sharper.
 *  - PLACEMENT. Each piece is panned to match where it is DRAWN on the
 *    mirrored stage. A kit that sounds spread the way it looks is much easier
 *    to play blind than one collapsed to mono.
 *  - CHOKE. A hi-hat cuts the hi-hat before it (PLAN 6.2). Without this,
 *    overlapping decays turn eighth notes into a shaker, and it is the single
 *    most obvious "that is not a real hi-hat" tell.
 */

type SampleGen = (i: number, sr: number) => number;
type GenFactory = () => SampleGen;

class Lcg {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s * 1664525 + 1013904223) >>> 0;
    return this.s / 4294967296;
  }
}

function render(ctx: BaseAudioContext, seconds: number, gen: SampleGen): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.ceil(sr * seconds));
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = gen(i, sr);
    d[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  // Normalize so no piece clips and none is buried: the per-hit gain is then
  // purely a function of how hard it was struck, not of synthesis luck.
  if (peak > 0) {
    const k = 0.92 / peak;
    for (let i = 0; i < n; i++) d[i] *= k;
  }
  // 3 ms fade-out kills the click a truncated decay would otherwise leave.
  const fade = Math.min(n, Math.round(sr * 0.003));
  for (let i = 0; i < fade; i++) d[n - fade + i] *= 1 - i / fade;
  return buf;
}

function kick(): SampleGen {
  let phase = 0;
  const click = new Lcg(1);
  return (i, sr) => {
    const t = i / sr;
    const f = 45 + (165 - 45) * Math.exp(-t / 0.018);
    phase += (2 * Math.PI * f) / sr;
    const beater = i < 3 ? (click.next() * 2 - 1) * 0.25 : 0;
    return Math.sin(phase) * Math.exp(-t / 0.055) + beater;
  };
}

function snare(): SampleGen {
  const noise = new Lcg(2);
  let p1 = 0;
  let p2 = 0;
  let hp = 0;
  return (i, sr) => {
    const t = i / sr;
    p1 += (2 * Math.PI * 185) / sr;
    p2 += (2 * Math.PI * 331) / sr;
    // Two shell modes, not one: a single sine reads as a tom, the pair reads
    // as a snare drum.
    const body =
      (Math.sin(p1) * 0.6 + Math.sin(p2) * 0.4) * Math.exp(-t / 0.045) * 0.5;
    // Wires: bright noise, so it gets a one-pole high-pass.
    const n = noise.next() * 2 - 1;
    hp += (n - hp) * 0.55;
    return body + (n - hp) * Math.exp(-t / 0.085) * 0.7;
  };
}

/** Six inharmonic partials through a high-pass: the 808 recipe, and the
 * reason a hi-hat sounds metallic rather than like white noise. */
function hat(decay: number, seed: number): GenFactory {
  const ratios = [1.0, 1.342, 1.2312, 1.6532, 1.9523, 2.1523];
  return () => {
    const base = 320;
    const phases = new Float64Array(6);
    const noise = new Lcg(seed);
    let hp = 0;
    return (i, sr) => {
      const t = i / sr;
      let sq = 0;
      for (let k = 0; k < 6; k++) {
        phases[k] += (2 * Math.PI * base * ratios[k]) / sr;
        sq += Math.sign(Math.sin(phases[k]));
      }
      const s = sq / 6 + (noise.next() * 2 - 1) * 0.35;
      hp += (s - hp) * 0.12; // one-pole low-pass ...
      return (s - hp) * Math.exp(-t / decay); // ... subtracted = high-pass
    };
  };
}

function tom(): SampleGen {
  let phase = 0;
  const noise = new Lcg(4);
  return (i, sr) => {
    const t = i / sr;
    const f = 92 + (168 - 92) * Math.exp(-t / 0.035);
    phase += (2 * Math.PI * f) / sr;
    const stick = i < 4 ? (noise.next() * 2 - 1) * 0.3 : 0;
    return Math.sin(phase) * Math.exp(-t / 0.19) + stick;
  };
}

/** A struck bronze disc: a wash of noise plus a few inharmonic partials that
 * outlive it. `ping` weights the stick attack (ride) against the wash (crash). */
function cymbal(decay: number, ping: number, seed: number, bright: number): GenFactory {
  const ratios = [1.0, 1.47, 1.83, 2.41, 3.17, 4.09, 5.63];
  return () => {
    const phases = new Float64Array(ratios.length);
    const noise = new Lcg(seed);
    let hp = 0;
    return (i, sr) => {
      const t = i / sr;
      let par = 0;
      for (let k = 0; k < ratios.length; k++) {
        phases[k] += (2 * Math.PI * bright * ratios[k]) / sr;
        par += Math.sin(phases[k]) / (k + 1);
      }
      const n = noise.next() * 2 - 1;
      hp += (n - hp) * 0.25;
      const wash = (n - hp) * Math.exp(-t / decay) * 0.55;
      const strike = par * Math.exp(-t / (decay * 0.35)) * ping;
      return wash + strike;
    };
  };
}

interface Spec {
  seconds: number;
  gen: GenFactory;
  /** -1 hard left .. +1 hard right, matching the DRAWN kit layout. */
  pan: number;
  /** Pieces sharing a choke group cut each other off (PLAN 6.2). */
  choke: string | null;
  /** Trim, so the mix balances after per-buffer normalization. */
  trim: number;
}

const SPECS: Record<string, Spec> = {
  kick: { seconds: 0.4, gen: kick, pan: 0.0, choke: null, trim: 1.0 },
  snare: { seconds: 0.35, gen: snare, pan: -0.05, choke: null, trim: 0.85 },
  // Hi-hat and crash sit on the player's LEFT on screen, so they sit left here.
  "hi-hat": { seconds: 0.16, gen: hat(0.035, 3), pan: -0.5, choke: "hihat", trim: 0.6 },
  crash: { seconds: 1.7, gen: cymbal(0.55, 0.25, 7, 480), pan: -0.68, choke: null, trim: 0.62 },
  tom: { seconds: 0.55, gen: tom, pan: 0.4, choke: null, trim: 0.9 },
  ride: { seconds: 1.1, gen: cymbal(0.34, 0.55, 5, 720), pan: 0.62, choke: null, trim: 0.6 },
};

/** Anything triggered by a zone id we have no sample for. */
const DEFAULT_ID = "snare";

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

export class DrumKit {
  private ctx: AudioContext;
  private buffers = new Map<string, AudioBuffer>();
  private pans = new Map<string, StereoPannerNode | GainNode>();
  private voices = new Map<string, Voice>(); // by choke group
  private master: GainNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(ctx.destination);
  }

  /** Pre-render every sample. Call after a user gesture has unlocked the ctx. */
  init(): void {
    for (const [id, spec] of Object.entries(SPECS)) {
      this.buffers.set(id, render(this.ctx, spec.seconds, spec.gen()));
      let node: StereoPannerNode | GainNode;
      if (typeof this.ctx.createStereoPanner === "function") {
        const p = this.ctx.createStereoPanner();
        p.pan.value = spec.pan;
        node = p;
      } else {
        node = this.ctx.createGain(); // mono fallback, still routed
      }
      node.connect(this.master);
      this.pans.set(id, node);
    }
  }

  setVolume(v: number): void {
    this.master.gain.value = Math.max(0, Math.min(1, v));
  }

  /** Play `zone` at `velocity` (0..1, as the detector reports it). */
  play(zone: string | null, velocity = 1): void {
    const id = zone !== null && this.buffers.has(zone) ? zone : DEFAULT_ID;
    const buf = this.buffers.get(id);
    const out = this.pans.get(id);
    const spec = SPECS[id];
    if (!buf || !out || this.ctx.state !== "running") return;

    const now = this.ctx.currentTime;
    const v = Math.max(0, Math.min(1, velocity));

    if (spec.choke) this.choke(spec.choke, now);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    // Harder hits ring very slightly sharper, and no two strokes are bit-identical:
    // without this a roll sounds like one sample retriggered, which it is.
    src.playbackRate.value = 1 + 0.03 * (v - 0.5) + (Math.random() - 0.5) * 0.012;

    const gain = this.ctx.createGain();
    // Perceptual: velocity 0.5 should sound half as loud, not half the amplitude.
    gain.gain.value = spec.trim * (0.12 + 0.88 * Math.pow(v, 1.6));

    src.connect(gain);
    gain.connect(out);
    src.start(now);

    if (spec.choke) {
      this.voices.set(spec.choke, { src, gain });
      src.onended = (): void => {
        if (this.voices.get(spec.choke as string)?.src === src) {
          this.voices.delete(spec.choke as string);
        }
      };
    }
  }

  /** Cut the group's ringing voice over 20 ms: instant enough to read as a
   * choke, slow enough not to click. */
  private choke(group: string, now: number): void {
    const prev = this.voices.get(group);
    if (!prev) return;
    try {
      prev.gain.gain.cancelScheduledValues(now);
      prev.gain.gain.setValueAtTime(prev.gain.gain.value, now);
      prev.gain.gain.linearRampToValueAtTime(0.0001, now + 0.02);
      prev.src.stop(now + 0.025);
    } catch {
      // Already stopped; nothing to choke.
    }
    this.voices.delete(group);
  }
}
