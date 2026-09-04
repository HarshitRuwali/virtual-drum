/** The backing track transport.
 *
 * Runs against a stub AudioContext: node has no Web Audio, and the parts worth
 * asserting are scheduling and state, not sound.
 */
import { describe, expect, it, vi } from "vitest";

import { BackingTrack } from "../src/backing";

interface StubSource {
  buffer: unknown;
  loop: boolean;
  onended: (() => void) | null;
  startedAt: number | null;
  stopped: boolean;
  connect: () => void;
  disconnect: () => void;
  start: (t: number) => void;
  stop: () => void;
}

function stubCtx(now = 10): { ctx: AudioContext; sources: StubSource[] } {
  const sources: StubSource[] = [];
  const ctx = {
    currentTime: now,
    destination: {},
    createGain: () => ({
      gain: { value: 0, linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    }),
    createBufferSource: (): StubSource => {
      const s: StubSource = {
        buffer: null,
        loop: false,
        onended: null,
        startedAt: null,
        stopped: false,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: (t: number): void => {
          s.startedAt = t;
        },
        stop: (): void => {
          s.stopped = true;
          s.onended?.();
        },
      };
      sources.push(s);
      return s;
    },
  };
  return { ctx: ctx as unknown as AudioContext, sources };
}

/** A loaded track, without going near decodeAudioData. */
function loaded(ctx: AudioContext, duration = 8): BackingTrack {
  const t = new BackingTrack(ctx);
  (t as unknown as { buf: unknown }).buf = { duration };
  return t;
}

describe("backing track", () => {
  it("reports the exact instant it scheduled, for grid alignment", () => {
    // The metronome must pin beat 1 to THIS value, not to its own reading of
    // currentTime: computing two leads separately puts milliseconds of skew
    // between click and song, which lands in the readout as a late bias.
    const { ctx, sources } = stubCtx(10);
    const at = loaded(ctx).start();
    expect(at).toBeGreaterThan(10);
    expect(sources[0].startedAt).toBe(at);
  });

  it("does not claim the song ended when you merely stopped it", () => {
    // stop() fires onended on a real BufferSource. Letting it through would
    // reset the transport UI on every pause.
    const { ctx } = stubCtx();
    const t = loaded(ctx);
    const ended = vi.fn();
    t.onEnded = ended;
    t.start();
    t.stop();
    expect(ended).not.toHaveBeenCalled();
    expect(t.playing).toBe(false);
  });

  it("still reports a genuine end", () => {
    const { ctx, sources } = stubCtx();
    const t = loaded(ctx);
    const ended = vi.fn();
    t.onEnded = ended;
    t.start();
    sources[0].onended?.();
    expect(ended).toHaveBeenCalledOnce();
    expect(t.playing).toBe(false);
  });

  it("never leaves two sources playing at once", () => {
    const { ctx, sources } = stubCtx();
    const t = loaded(ctx);
    t.start();
    t.start();
    expect(sources).toHaveLength(2);
    expect(sources[0].stopped).toBe(true);
    expect(sources[1].stopped).toBe(false);
  });

  it("wraps position within the song when looping", () => {
    const { ctx } = stubCtx(10);
    const t = loaded(ctx, 8);
    t.start();
    (ctx as unknown as { currentTime: number }).currentTime = 30;
    // started at 10.06, so 19.94 elapsed, which is 3.94 into the third pass.
    expect(t.position).toBeCloseTo(19.94 % 8, 6);
    expect(t.position).toBeLessThan(t.duration);
  });

  it("is silent about position when stopped", () => {
    const { ctx } = stubCtx();
    const t = loaded(ctx);
    expect(t.position).toBe(0);
    t.start();
    t.stop();
    expect(t.position).toBe(0);
  });

  it("survives stop() on a source that already ended", () => {
    const { ctx, sources } = stubCtx();
    const t = loaded(ctx);
    t.start();
    sources[0].stop = (): void => {
      throw new DOMException("already stopped");
    };
    expect(() => t.stop()).not.toThrow();
  });
});
