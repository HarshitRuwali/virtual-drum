"""Scoring semantics (PLAN 7.1): greedy 1-1 matching, P/R/F1, bias, jitter."""
import math

from vdrum.score import score


def test_perfect_match():
    s = score([100, 200], [100, 200], 50)
    assert (s.tp, s.fp, s.fn) == (2, 0, 0)
    assert s.precision == 1.0 and s.recall == 1.0 and s.f1 == 1.0
    assert s.bias_ms == 0.0 and s.jitter_ms == 0.0
    assert s.matched == [(100.0, 100.0), (200.0, 200.0)]


def test_bias_and_jitter_are_stats_of_matched_pairs():
    s = score([110, 120], [100, 100], 50)
    assert (s.tp, s.fp, s.fn) == (2, 0, 0)
    # dts = [+10, +20]
    assert s.bias_ms == 15.0
    assert s.jitter_ms == math.sqrt(((10 - 15) ** 2 + (20 - 15) ** 2) / 2)  # 5.0


def test_false_positive_and_false_negative():
    s = score([100, 500], [100, 900], 50)
    assert (s.tp, s.fp, s.fn) == (1, 1, 1)
    assert s.precision == 0.5 and s.recall == 0.5 and s.f1 == 0.5


def test_greedy_one_to_one():
    # Two predictions both within window of ONE truth: only the closer may match.
    s = score([100, 105], [100], 50)
    assert (s.tp, s.fp, s.fn) == (1, 1, 0)


def test_window_boundary_is_inclusive():
    assert score([150], [100], 50).tp == 1
    assert score([151], [100], 50).tp == 0


def test_empty_inputs():
    s = score([], [], 50)
    assert s.tp == 0 and s.precision == 0.0 and s.recall == 0.0 and s.f1 == 0.0


def test_to_dict_keys():
    d = score([100], [101], 50).to_dict()
    assert set(d) == {"tp", "fp", "fn", "precision", "recall", "f1", "bias_ms", "jitter_ms"}
