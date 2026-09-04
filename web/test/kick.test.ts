/** The kick inputs (PLAN 6.2).
 *
 * Neither of these can be exercised by hand in CI: there is no microphone and
 * no pedal. Both are therefore the classic "wrong once, wrong forever" code,
 * so the DSP and the byte decoding are pure and tested here against synthetic
 * signals and synthetic MIDI packets.
 */
import { describe, expect, it } from "vitest";

import { DEFAULTS, StompDetector } from "../public/worklets/stompcore.js";
import { decode } from "../src/midi";

const SR = 48000;
const BLOCK = 128;

/** A floor thump: a fast-decaying low-frequency burst, which is what a shoe on
 * a hard floor actually looks like to a microphone. */
function stomp(buf: Float32Array, atMs: number, amp = 0.5): void {
  const start = Math.round((atMs / 1000) * SR);
  const decay = 0.045 * SR;
  for (let i = 0; i < decay * 4 && start + i < buf.length; i++) {
    buf[start + i] += amp * Math.exp(-i / decay) * Math.sin((2 * Math.PI * 55 * i) / SR);
  }
}

function noise(buf: Float32Array, amp: number): void {
  // Deterministic: a seeded LCG, so a failure is always reproducible.
  let seed = 12345;
  for (let i = 0; i < buf.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    buf[i] += ((seed / 0x7fffffff) * 2 - 1) * amp;
  }
}

/** Feed in worklet-sized blocks and return onset times in ms. */
function run(buf: Float32Array, det = new StompDetector(SR)): number[] {
  const out: number[] = [];
  for (let i = 0; i + BLOCK <= buf.length; i += BLOCK) {
    const hit = det.process(buf.subarray(i, i + BLOCK));
    if (hit) out.push(((i + hit.offset) / SR) * 1000);
  }
  return out;
}

describe("stomp detection", () => {
  it("finds a single stomp, close to when it happened", () => {
    const buf = new Float32Array(SR);
    stomp(buf, 500);
    const hits = run(buf);
    expect(hits).toHaveLength(1);
    // The envelope needs a few ms to rise; anything worse than this would
    // show up in the readout as a systematic late bias.
    expect(hits[0]).toBeGreaterThanOrEqual(500);
    expect(hits[0]).toBeLessThan(510);
  });

  it("stays silent on silence", () => {
    expect(run(new Float32Array(SR))).toEqual([]);
  });

  it("stays silent on room tone", () => {
    const buf = new Float32Array(SR);
    noise(buf, 0.01);
    expect(run(buf)).toEqual([]);
  });

  it("is deaf to a rising level, and only hears a rise", () => {
    // A fixed threshold would fire here. This is the whole reason the detector
    // compares two envelopes instead: a room getting louder is not a stomp.
    const buf = new Float32Array(SR * 2);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (i / buf.length) * 0.6 * Math.sin((2 * Math.PI * 55 * i) / SR);
    }
    expect(run(buf)).toEqual([]);
  });

  it("ignores a sustained tone above the cutoff", () => {
    const buf = new Float32Array(SR);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = 0.6 * Math.sin((2 * Math.PI * 2000 * i) / SR);
    }
    expect(run(buf)).toEqual([]);
  });

  it("ignores a loud cymbal, which is a transient the rise test cannot reject", () => {
    // This is the test that actually exercises the filter. A steady tone is
    // rejected for having no rise, whatever the frequency, so it leaves the
    // cutoff untested: with a single 6 dB/octave pole a 3 kHz crash still
    // lands ~26 dB down, an order of magnitude above the floor, and every
    // crash reads as a kick. Found by mutation testing, not by reading.
    const buf = new Float32Array(SR * 2);
    const start = Math.round(0.4 * SR);
    const decay = 0.25 * SR;
    for (let i = 0; start + i < buf.length; i++) {
      buf[start + i] += 0.7 * Math.exp(-i / decay) * Math.sin((2 * Math.PI * 3000 * i) / SR);
    }
    expect(run(buf)).toEqual([]);
  });

  it("ignores a shout, which leaks 9x the floor through the filter", () => {
    // Measured, not assumed: an 800 Hz burst at 0.6 puts 3.2e-2 into the low
    // band against a floor of 3.5e-3. Only the spectral-shape test rejects it.
    const buf = new Float32Array(SR * 2);
    const start = Math.round(0.4 * SR);
    const decay = 0.2 * SR;
    for (let i = 0; start + i < buf.length; i++) {
      buf[start + i] += 0.6 * Math.exp(-i / decay) * Math.sin((2 * Math.PI * 800 * i) / SR);
    }
    expect(run(buf)).toEqual([]);
  });

  it("keeps a wide spectral margin either side of the threshold", () => {
    /** Peak low-band / full-band ratio, the quantity the shape test keys on. */
    const shape = (buf: Float32Array): number => {
      const det = new StompDetector(SR);
      let best = 0;
      for (let i = 0; i + BLOCK <= buf.length; i += BLOCK) {
        det.process(buf.subarray(i, i + BLOCK));
        if (det.wide > 1e-6) best = Math.max(best, det.fast / det.wide);
      }
      return best;
    };
    const tone = (f: number, amp: number, decayS: number): Float32Array => {
      const b = new Float32Array(SR);
      for (let i = 0; i < b.length; i++) {
        b[i] = amp * Math.exp(-i / (decayS * SR)) * Math.sin((2 * Math.PI * f * i) / SR);
      }
      return b;
    };
    const L = DEFAULTS.lowFrac;
    // Pass/fail either side of the line is not enough: the filter order has to
    // be pinned by the MARGIN. With a single pole a shout measures 0.308
    // against a 0.35 threshold, a 14% gap that any chest-voice note would
    // close, yet every other test in this file stays green. Three poles put it
    // at 0.061. This assertion is the only thing that tells them apart.
    expect(shape(tone(55, 0.5, 0.045)), "stomp").toBeGreaterThan(L * 2);
    expect(shape(tone(800, 0.6, 0.2)), "voice").toBeLessThan(L * 0.5);
    expect(shape(tone(3000, 0.7, 0.25)), "cymbal").toBeLessThan(L * 0.5);
  });

  it("refuses a second stomp inside the refractory window", () => {
    // A foot physically cannot; a single stomp ringing the floor can.
    const buf = new Float32Array(SR);
    stomp(buf, 300);
    stomp(buf, 340);
    expect(run(buf)).toHaveLength(1);
  });

  it("takes both stomps when they are far enough apart", () => {
    const buf = new Float32Array(SR * 2);
    stomp(buf, 300);
    stomp(buf, 800);
    const hits = run(buf);
    expect(hits).toHaveLength(2);
    expect(hits[1] - hits[0]).toBeGreaterThan(400);
  });

  it("mute() stops the kit retriggering itself through the speakers", () => {
    // The stomp must land AFTER the warmup, or the test passes on warmup alone
    // and says nothing about mute. It did exactly that until a mutation that
    // gutted mute() left every test green.
    const buf = new Float32Array(SR);
    stomp(buf, 400);
    const muted: number[] = [];
    const det = new StompDetector(SR);
    for (let i = 0; i + BLOCK <= buf.length; i += BLOCK) {
      if (i === Math.floor((0.38 * SR) / BLOCK) * BLOCK) det.mute(120);
      const h = det.process(buf.subarray(i, i + BLOCK));
      if (h) muted.push(((i + h.offset) / SR) * 1000);
    }
    expect(muted).toEqual([]);
    // Control: the same signal WITHOUT the mute must fire, or the assertion
    // above is satisfied by the signal being undetectable in the first place.
    expect(run(buf)).toHaveLength(1);
  });

  it("reports a harder stomp as a louder one", () => {
    const soft = new Float32Array(SR);
    const hard = new Float32Array(SR);
    stomp(soft, 500, 0.12);
    stomp(hard, 500, 0.9);
    const vOf = (b: Float32Array): number => {
      const det = new StompDetector(SR);
      for (let i = 0; i + BLOCK <= b.length; i += BLOCK) {
        const h = det.process(b.subarray(i, i + BLOCK));
        if (h) return h.velocity;
      }
      return 0;
    };
    expect(vOf(hard)).toBeGreaterThan(vOf(soft));
    expect(vOf(soft)).toBeGreaterThan(0);
    expect(vOf(hard)).toBeLessThanOrEqual(1);
  });
});

describe("midi kick decoding", () => {
  const on = (note: number, vel: number): Uint8Array =>
    new Uint8Array([0x90, note, vel]);
  const cc = (num: number, val: number): Uint8Array =>
    new Uint8Array([0xb0, num, val]);

  it("takes a Note On as a kick, scaled to 0..1", () => {
    expect(decode(on(36, 127))).toBeCloseTo(1, 6);
    expect(decode(on(36, 64))).toBeCloseTo(64 / 127, 6);
  });

  it("ignores Note On with velocity 0, which is a Note Off", () => {
    // Missing this doubles every kick, and only on hardware that uses the
    // running-status convention, so it would look intermittent.
    expect(decode(on(36, 0))).toBeNull();
  });

  it("takes a sustain pedal press and ignores its release", () => {
    expect(decode(cc(64, 127))).toBe(1);
    expect(decode(cc(64, 64))).toBe(1); // the spec's own on/off split
    expect(decode(cc(64, 63))).toBeNull();
    expect(decode(cc(64, 0))).toBeNull();
  });

  it("ignores every other controller", () => {
    expect(decode(cc(1, 127))).toBeNull(); // mod wheel
    expect(decode(cc(7, 127))).toBeNull(); // volume
  });

  it("survives a short or absent packet", () => {
    expect(decode(null)).toBeNull();
    expect(decode(new Uint8Array([0x90]))).toBeNull();
  });
});
