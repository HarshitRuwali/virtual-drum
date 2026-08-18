/** Scoring semantics (PLAN 7.1): ported 1:1 from py/tests/test_score.py.
 * The Python suite pins these exact values; the TS port must produce the
 * same numbers (greedy order, P/R/F1, bias, population-stddev jitter). */
import { describe, expect, it } from "vitest";

import { fitOffset, score } from "../src/score";

describe("score (mirror of py/tests/test_score.py)", () => {
  it("test_perfect_match", () => {
    const s = score([100, 200], [100, 200], 50);
    expect([s.tp, s.fp, s.fn]).toEqual([2, 0, 0]);
    expect(s.precision).toBe(1.0);
    expect(s.recall).toBe(1.0);
    expect(s.f1).toBe(1.0);
    expect(s.bias_ms).toBe(0.0);
    expect(s.jitter_ms).toBe(0.0);
    expect(s.matched).toEqual([
      [100, 100],
      [200, 200],
    ]);
  });

  it("test_bias_and_jitter_are_stats_of_matched_pairs", () => {
    const s = score([110, 120], [100, 100], 50);
    expect([s.tp, s.fp, s.fn]).toEqual([2, 0, 0]);
    // dts = [+10, +20]
    expect(s.bias_ms).toBe(15.0);
    expect(s.jitter_ms).toBe(Math.sqrt(((10 - 15) ** 2 + (20 - 15) ** 2) / 2)); // 5.0
  });

  it("test_false_positive_and_false_negative", () => {
    const s = score([100, 500], [100, 900], 50);
    expect([s.tp, s.fp, s.fn]).toEqual([1, 1, 1]);
    expect(s.precision).toBe(0.5);
    expect(s.recall).toBe(0.5);
    expect(s.f1).toBe(0.5);
  });

  it("test_greedy_one_to_one", () => {
    // Two predictions both within window of ONE truth: only the closer may match.
    const s = score([100, 105], [100], 50);
    expect([s.tp, s.fp, s.fn]).toEqual([1, 1, 0]);
  });

  it("test_window_boundary_is_inclusive", () => {
    expect(score([150], [100], 50).tp).toBe(1);
    expect(score([151], [100], 50).tp).toBe(0);
  });

  it("test_empty_inputs", () => {
    const s = score([], [], 50);
    expect(s.tp).toBe(0);
    expect(s.precision).toBe(0.0);
    expect(s.recall).toBe(0.0);
    expect(s.f1).toBe(0.0);
    expect(s.bias_ms).toBe(0.0);
    expect(s.jitter_ms).toBe(0.0);
  });
});

describe("fitOffset (PLAN 8.4, app layer)", () => {
  it("null until minSamples reached, then mean(dt)", () => {
    const pred = [105, 115];
    const truth = [100, 110];
    expect(fitOffset(pred, truth, 50, 32)).toBeNull();
    expect(fitOffset(pred, truth, 50, 2)).toBe(5);
  });
});
