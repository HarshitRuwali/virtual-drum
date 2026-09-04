/** The stage transform: mirroring, letterboxing, and the kit's on-screen
 * layout (PLAN-UI phases 1-2).
 *
 * This is the counterpart to `py/tests/test_zones.py::
 * test_mirrored_layout_is_a_right_handed_kit`. The Python side asserts the
 * layout from the CONFIG; this asserts that the renderer's flip actually puts
 * it there. Getting either one wrong makes the whole app unplayable while
 * every other test stays green -- the boxes simply appear on the wrong side of
 * the player from their hands.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { draw, rectOf, stageOf, sx, sy, type UiState } from "../src/ui";
import { ZoneSet } from "../src/zones";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const A = 16 / 9;

function kit(): ZoneSet {
  return ZoneSet.fromDict(
    JSON.parse(readFileSync(path.join(ROOT, "config", "zones.json"), "utf8")),
  );
}

function centres(w: number, h: number): Record<string, { cx: number; cy: number }> {
  const st = stageOf({ width: w, height: h }, A);
  const out: Record<string, { cx: number; cy: number }> = {};
  for (const z of kit().zones) {
    const [x, y, zw, zh] = rectOf(st, z);
    out[z.id] = { cx: x + zw / 2, cy: y + zh / 2 };
  }
  return out;
}

describe("stage transform", () => {
  it("letterboxes a 16:9 frame into a 16:9 canvas with no bars", () => {
    const st = stageOf({ width: 1600, height: 900 }, A);
    expect(st.x).toBeCloseTo(0, 6);
    expect(st.y).toBeCloseTo(0, 6);
    expect(st.w).toBeCloseTo(1600, 6);
    expect(st.h).toBeCloseTo(900, 6);
  });

  it("contains rather than crops: a wide canvas gets side bars, not a cut kit", () => {
    const st = stageOf({ width: 3000, height: 900 }, A);
    expect(st.h).toBeCloseTo(900, 6);
    expect(st.w).toBeCloseTo(1600, 6);
    expect(st.x).toBeCloseTo(700, 6); // centred
  });

  it("a tall canvas is limited by width, still whole", () => {
    const st = stageOf({ width: 800, height: 2000 }, A);
    expect(st.w).toBeCloseTo(800, 6);
    expect(st.h).toBeCloseTo(450, 6);
    expect(st.y).toBeCloseTo(775, 6);
  });

  it("mirrors X exactly once: raw 0 is the RIGHT edge", () => {
    const st = stageOf({ width: 1600, height: 900 }, A);
    expect(sx(st, 0)).toBeCloseTo(st.x + st.w, 6);
    expect(sx(st, A)).toBeCloseTo(st.x, 6);
    expect(sx(st, A / 2)).toBeCloseTo(st.x + st.w / 2, 6);
    // Y is not flipped.
    expect(sy(st, 0)).toBeCloseTo(st.y, 6);
    expect(sy(st, 1)).toBeCloseTo(st.y + st.h, 6);
  });

  it("draws a right-handed kit as the player sees it", () => {
    const c = centres(1600, 900);
    const mid = 800;

    // Player's left.
    expect(c["hi-hat"].cx).toBeLessThan(mid);
    expect(c["crash"].cx).toBeLessThan(mid);
    // Player's right.
    expect(c["tom"].cx).toBeGreaterThan(mid);
    expect(c["ride"].cx).toBeGreaterThan(mid);
    // Centre column, kick under the snare.
    expect(Math.abs(c["snare"].cx - mid)).toBeLessThan(80);
    expect(Math.abs(c["kick"].cx - mid)).toBeLessThan(80);
    expect(c["kick"].cy).toBeGreaterThan(c["snare"].cy);
    // Cymbals above the drums on their own side.
    expect(c["crash"].cy).toBeLessThan(c["hi-hat"].cy);
    expect(c["ride"].cy).toBeLessThan(c["tom"].cy);
  });

  it("keeps every piece inside the visible frame", () => {
    const st = stageOf({ width: 1600, height: 900 }, A);
    for (const z of kit().zones) {
      const [x, y, w, h] = rectOf(st, z);
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
      expect(x).toBeGreaterThanOrEqual(st.x - 0.001);
      expect(y).toBeGreaterThanOrEqual(st.y - 0.001);
      expect(x + w).toBeLessThanOrEqual(st.x + st.w + 0.001);
      expect(y + h).toBeLessThanOrEqual(st.y + st.h + 0.001);
    }
  });
});

// ---------------------------------------------------------------------------
// draw() smoke test
// ---------------------------------------------------------------------------

/** Records every 2D call. Returns itself from gradient factories so
 * `addColorStop` chains work without a real canvas implementation. */
function stubCtx(): { ctx: unknown; calls: string[] } {
  const calls: string[] = [];
  const gradient = { addColorStop: (): void => {} };
  const ctx: Record<string, unknown> = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    canvas: { width: 1600, height: 900 },
  };
  for (const m of [
    "clearRect", "setTransform", "fillRect", "strokeRect", "beginPath",
    "ellipse", "arc", "moveTo", "lineTo", "quadraticCurveTo", "bezierCurveTo",
    "closePath", "fill", "stroke",
    "save", "restore", "translate", "scale", "rotate", "clip", "drawImage",
    "fillText", "setLineDash",
  ]) {
    ctx[m] = (): void => {
      calls.push(m);
    };
  }
  return { ctx, calls };
}

function state(over: Partial<UiState> = {}): UiState {
  return {
    zones: kit(),
    aspect: A,
    nowMs: 1000,
    hits: [],
    hands: [],
    video: null,
    showZones: false,
    lastBeatMs: null,
    ...over,
  };
}

describe("draw()", () => {
  const canvas = (c: unknown): HTMLCanvasElement =>
    ({ width: 1600, height: 900, getContext: () => c }) as unknown as HTMLCanvasElement;

  it("renders the idle kit", () => {
    const { ctx, calls } = stubCtx();
    draw(state(), canvas(ctx));
    expect(calls).toContain("clearRect");
    // Six pieces, each at least an ellipse or an arc.
    expect(calls.filter((c) => c === "ellipse" || c === "arc").length).toBeGreaterThan(20);
  });

  it("renders strikes, sticks, beats and the zone overlay without throwing", () => {
    const { ctx, calls } = stubCtx();
    draw(
      state({
        hits: [
          { t_ms: 900, zone: "snare", hand: "R", velocity: 1, x: 0.89, y: 0.66 },
          { t_ms: 950, zone: "crash", hand: "L", velocity: 0.2, x: 1.5, y: 0.28 },
          { t_ms: 960, zone: "hi-hat", hand: "L", velocity: 0.7, x: 1.44, y: 0.6 },
          { t_ms: 970, zone: "kick", hand: "foot", velocity: 1, x: 0.89, y: 0.92 },
          { t_ms: 400, zone: "ride", hand: "R", velocity: 1, x: 0.25, y: 0.28 },
          { t_ms: 980, zone: null, hand: "R", velocity: 0.5, x: 0.5, y: 0.1 },
        ],
        hands: [
          { hand: "L", x: 1.44, y: 0.6, scale: 0.1, conf: 0.9 },
          { hand: "R", x: 0.3, y: 0.5, scale: 0.1, conf: 0.4 },
        ],
        lastBeatMs: 940,
        showZones: true,
      }),
      canvas(ctx),
    );
    expect(calls).toContain("fillText"); // zone labels
    expect(calls).toContain("setLineDash");
  });

  it("is a no-op when the canvas has no 2D context", () => {
    expect(() => draw(state(), canvas(null))).not.toThrow();
  });

  it("survives a zone id it has no artwork for", () => {
    const { ctx } = stubCtx();
    const zs = ZoneSet.fromDict({
      zones: [{ id: "cowbell", x: [0.2, 0.6], y: [0.2, 0.6] }],
    });
    expect(() => draw(state({ zones: zs }), canvas(ctx))).not.toThrow();
  });
});
