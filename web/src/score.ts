/** Hit scoring (PLAN 7.1). TS port of `py/vdrum/score.py` -- SAME signature
 * shape, SAME greedy order, SAME statistics (population stddev, 0.0 defaults).
 *
 * Zones are grouped by the CALLER: score one zone's times against the
 * expected times of that zone, exactly as py/vdrum/sweep.py extracts
 * `[h.report_t_ms for h in hits]` per case before calling score().
 *
 * Optimize F1 and stddev(dt), NEVER mean(dt): the mean is a calibration
 * constant you subtract (PLAN 8), not a quality signal.
 */

export interface Score {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  bias_ms: number;
  jitter_ms: number;
  matched: Array<[number, number]>; // (predicted_t, truth_t)
}

export function score(
  predicted: number[],
  truth: number[],
  windowMs = 50.0,
): Score {
  const cands: Array<[number, number, number]> = [];
  for (let i = 0; i < predicted.length; i++) {
    for (let j = 0; j < truth.length; j++) {
      const dt = predicted[i] - truth[j];
      if (Math.abs(dt) <= windowMs) cands.push([Math.abs(dt), i, j]);
    }
  }
  cands.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const usedP = new Set<number>();
  const usedG = new Set<number>();
  const matched: Array<[number, number]> = [];
  for (const [, i, j] of cands) {
    if (usedP.has(i) || usedG.has(j)) continue;
    usedP.add(i);
    usedG.add(j);
    matched.push([predicted[i], truth[j]]);
  }

  const tp = matched.length;
  const fp = predicted.length - tp;
  const fn = truth.length - tp;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0.0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0.0;
  const f1 =
    precision + recall > 0
      ? (2.0 * precision * recall) / (precision + recall)
      : 0.0;

  const dts = matched.map(([p, g]) => p - g);
  let bias = 0.0;
  let jitter = 0.0;
  if (dts.length > 0) {
    bias = dts.reduce((a, b) => a + b, 0) / dts.length;
    jitter = Math.sqrt(
      dts.reduce((acc, d) => acc + (d - bias) * (d - bias), 0) / dts.length,
    );
  }
  return { tp, fp, fn, precision, recall, f1, bias_ms: bias, jitter_ms: jitter, matched };
}

/** Per-user offset fit (PLAN 8, app layer): mean(Δt) over matched pairs,
 * once enough beats have been collected. Replaces the constant OFFSET_MS in
 * the READOUT only; the audio trigger stays at peak + constant. */
export function fitOffset(
  predicted: number[],
  truth: number[],
  windowMs = 50.0,
  minSamples = 32,
): number | null {
  const s = score(predicted, truth, windowMs);
  if (s.matched.length < minSamples) return null;
  return s.bias_ms;
}
