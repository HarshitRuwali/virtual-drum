/** Synthesized drum kit (PLAN 9.2) -- zero downloads, zero dependencies.
 *
 * Each zone gets a short synthesized sample rendered once into an
 * AudioBuffer, then played back instantly on a hit (no per-hit synthesis,
 * no network). Deterministic PRNG (LCG) so the kit sounds identical
 * everywhere.
 */

type SampleGen = (i: number, sr: number) => number;

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
  for (let i = 0; i < n; i++) d[i] = gen(i, sr);
  return buf;
}

function kick(): SampleGen {
  let phase = 0;
  const click = new Lcg(1);
  let clickSample = 0;
  return (i, sr) => {
    const t = i / sr;
    const f = 45 + (165 - 45) * Math.exp(-t / 0.018);
    phase += (2 * Math.PI * f) / sr;
    if (i < 3) clickSample = (click.next() * 2 - 1) * 0.25;
    else clickSample = 0;
    return Math.sin(phase) * Math.exp(-t / 0.05) + clickSample;
  };
}

function snare(): SampleGen {
  const noise = new Lcg(2);
  let phase = 0;
  return (i, sr) => {
    const t = i / sr;
    phase += (2 * Math.PI * 190) / sr;
    const n = (noise.next() * 2 - 1) * Math.exp(-t / 0.012) * 0.45;
    const body = Math.sin(phase) * Math.exp(-t / 0.035) * 0.35;
    return n + body;
  };
}

function hihat(): SampleGen {
  const noise = new Lcg(3);
  return (i, sr) => {
    const t = i / sr;
    return (noise.next() * 2 - 1) * Math.exp(-t / 0.008) * 0.5;
  };
}

function tom(): SampleGen {
  let phase = 0;
  return (i, sr) => {
    const t = i / sr;
    const f = 70 + (120 - 70) * Math.exp(-t / 0.03);
    phase += (2 * Math.PI * f) / sr;
    return Math.sin(phase) * Math.exp(-t / 0.18);
  };
}

function ride(): SampleGen {
  const noise = new Lcg(5);
  let phase = 0;
  return (i, sr) => {
    const t = i / sr;
    phase += (2 * Math.PI * 5200) / sr;
    const n = (noise.next() * 2 - 1) * Math.exp(-t / 0.1) * 0.35;
    const ping = Math.sin(phase) * Math.exp(-t / 0.22) * 0.12;
    return n + ping;
  };
}

const SPECS: Array<[string, number, SampleGen]> = [
  ["kick", 0.35, kick()],
  ["snare", 0.3, snare()],
  ["hi-hat", 0.15, hihat()],
  ["tom", 0.5, tom()],
  ["ride", 0.9, ride()],
];

export class DrumKit {
  private ctx: AudioContext;
  private buffers = new Map<string, AudioBuffer>();
  private master: GainNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);
  }

  /** Pre-render all samples (call after a user gesture has unlocked the ctx). */
  init(): void {
    for (const [id, seconds, gen] of SPECS) {
      this.buffers.set(id, render(this.ctx, seconds, gen));
    }
  }

  setVolume(v: number): void {
    this.master.gain.value = Math.max(0, Math.min(1, v));
  }

  play(zone: string | null): void {
    const buf = this.buffers.get(zone ?? "snare") ?? this.buffers.get("snare");
    if (!buf || this.ctx.state !== "running") return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master);
    src.start();
  }
}
