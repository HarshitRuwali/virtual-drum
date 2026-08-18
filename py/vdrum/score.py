"""Hit scoring (PLAN 7.1).

Greedy one-to-one matching by ascending |dt| within a fixed window, then
precision / recall / F1 and the timing statistics of the matched pairs.

Optimize F1 and stddev(dt), NEVER mean(dt): the mean is a calibration
constant you subtract (PLAN 8), not a quality signal. Keeping the match
window fixed keeps the numbers honest -- widening it inflates precision by
absorbing bad hits.
"""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Score:
    tp: int
    fp: int
    fn: int
    precision: float
    recall: float
    f1: float
    bias_ms: float
    jitter_ms: float
    matched: list[tuple[float, float]]  # (predicted_t, truth_t)

    def to_dict(self) -> dict:
        return {
            "tp": self.tp,
            "fp": self.fp,
            "fn": self.fn,
            "precision": self.precision,
            "recall": self.recall,
            "f1": self.f1,
            "bias_ms": self.bias_ms,
            "jitter_ms": self.jitter_ms,
        }


def score(predicted: list[float], truth: list[float], window_ms: float = 50.0) -> Score:
    cands: list[tuple[float, int, int]] = []
    for i, p in enumerate(predicted):
        for j, g in enumerate(truth):
            dt = p - g
            if abs(dt) <= window_ms:
                cands.append((abs(dt), i, j))
    cands.sort()
    used_p: set[int] = set()
    used_g: set[int] = set()
    matched: list[tuple[float, float]] = []
    for _, i, j in cands:
        if i in used_p or j in used_g:
            continue
        used_p.add(i)
        used_g.add(j)
        matched.append((predicted[i], truth[j]))

    tp = len(matched)
    fp = len(predicted) - tp
    fn = len(truth) - tp
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = (2.0 * precision * recall / (precision + recall)) if (precision + recall) else 0.0

    dts = [p - g for p, g in matched]
    if dts:
        bias = sum(dts) / len(dts)
        jitter = math.sqrt(sum((d - bias) ** 2 for d in dts) / len(dts))
    else:
        bias = 0.0
        jitter = 0.0

    return Score(tp, fp, fn, precision, recall, f1, bias, jitter, matched)
