"""Hit detection: state machine (driven directly) + synthetic cases (PLAN 5).

The state-machine tests drive HandState.step() with an *identity filter*
(min_cutoff -> inf), so injected velocity profiles pass through unmodified:
with scale = 1.0, a y-increment of v*dt injects exactly vy_n = v. This pins
the IDLE/DESCENDING/REFRACTORY semantics independently of the filter.
"""
import pytest

from vdrum.config import Config, default_config, FilterCfg, DetectCfg, HandCfg
from vdrum.detect import HandState, Track, detect
from vdrum.testgen import CASES, gen_cases
from vdrum.zones import default_zones

DT_MS = 1000.0 / 60.0
IDENT = FilterCfg(min_cutoff=1.0e6, beta=0.0, d_cutoff=1.0e6)


def cfg() -> Config:
    base = default_config()
    return Config(filter=IDENT, detection=base.detection, hand=base.hand)


def drive(values: list[float], xs: float = 0.89, y0: float = 0.55,
          times: list[float] | None = None, scale: float = 1.0) -> list:
    """Feed vy_n samples (palm-widths/s) through a fresh HandState; return hits."""
    hs = HandState("R", cfg())
    z = default_zones()
    y = y0
    hits = []
    ts = times if times is not None else [i * DT_MS for i in range(len(values) + 1)]
    hs.step(ts[0], xs, y, scale, cfg(), z)  # first sample, primes the filter
    for i, v in enumerate(values, start=1):
        y += v * (1.0 / 60.0)  # scale=1.0 => y increment == vy_n * dt
        hit = hs.step(ts[i], xs, y, scale, cfg(), z)
        if hit is not None:
            hits.append(hit)
    return hits


def test_vmin_boundary():
    # 0.79 stays IDLE, 0.81 enters DESCENDING, decay fires at the peak frame.
    hits = drive([0.79, 0.81, 0.3])
    assert len(hits) == 1
    assert hits[0].peak_t_ms == pytest.approx(2 * DT_MS, abs=1e-9)
    assert hits[0].report_t_ms == pytest.approx(2 * DT_MS + 25.0, abs=1e-9)


def test_peak_tracking_and_velocity():
    hits = drive([1.0, 1.5, 2.0, 0.5])
    assert len(hits) == 1
    h = hits[0]
    assert h.peak_t_ms == pytest.approx(3 * DT_MS, abs=1e-9)
    # velocity = (peak - V_MIN) / (V_MAX - V_MIN) = (2.0 - 0.8) / 7.2
    assert h.velocity == pytest.approx(1.2 / 7.2, abs=1e-4)
    assert 0.0 <= h.velocity <= 1.0


def test_refractory_suppresses_quick_second():
    # Fire at frame 3 (decay below 0.6*peak). The follow-through keeps
    # vy_n > V_MIN (frames 4-8), so even after the 60 ms window the state
    # stays locked: continuous fast descent is one stroke, not two. (A real
    # second hit rebounds first, which is what re-arms -- see
    # test_refractory_allows_slow_second.)
    hits = drive([1.2, 1.0, 0.5, 1.5, 1.5, 1.5, 1.5, 1.2, 0.5])
    assert len(hits) == 1
    assert hits[0].peak_t_ms == pytest.approx(1 * DT_MS, abs=1e-9)
    assert hits[0].report_t_ms == pytest.approx(1 * DT_MS + 25.0, abs=1e-9)


def test_filter_tail_does_not_ghost_second_hit():
    # The artifact the settle test exists for: after one stroke the One Euro
    # filter keeps "descending" (tail catching up). With the identity filter
    # the tail is exactly the injected decay, so this pins the re-arm rule
    # directly: the 0.5-decay tail (below V_MIN) must re-arm and NOT fire,
    # while the same tail held at 1.5 (above V_MIN) must stay locked.
    tail = drive([1.0, 1.0, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05, 0.02])
    assert len(tail) == 1
    locked = drive([1.0, 1.0, 0.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5])
    assert len(locked) == 1


def test_refractory_allows_slow_second():
    # Same first stroke, second stroke starts 67 ms after the fire (> 60 ms
    # refractory, < 150 ms GAP_MS): it must fire.
    hits = drive([1.2, 1.0, 0.5, 0.1, 0.1, 0.1, 0.1, 1.5, 0.5])
    assert len(hits) == 2
    assert hits[0].peak_t_ms == pytest.approx(1 * DT_MS, abs=1e-9)
    assert hits[1].peak_t_ms == pytest.approx(8 * DT_MS, abs=1e-9)


def test_gap_guard_no_false_hit_on_teleport():
    # A 200 ms absence with a 0.25-unit position jump must NOT read as a
    # strike (GAP_MS); the in-progress stroke before it is cancelled, and the
    # real stroke after the gap still fires exactly once.
    times = [0.0, 16.6666667, 216.6666667, 233.3333333, 250.0, 266.6666667]
    ys = [0.55, 0.5666667, 0.80, 0.8166667, 0.8333333, 0.8416667]
    hs = HandState("R", cfg())
    z = default_zones()
    hits = []
    for t, y in zip(times, ys):
        hit = hs.step(t, 0.89, y, 1.0, cfg(), z)
        if hit is not None:
            hits.append(hit)
    assert len(hits) == 1
    # The hit is the post-gap stroke (peak strictly after the 216.67 ms
    # absence) -- never a phantom from the teleport, never the cancelled
    # pre-gap stroke (peak would be ~16.7 ms).
    assert hits[0].peak_t_ms > 216.6666667
    assert hits[0].zone == "snare"


def test_zone_and_hand_assignment():
    hits = drive([1.0, 1.0, 0.5])
    assert len(hits) == 1
    assert hits[0].hand == "R"
    assert hits[0].zone == "snare"  # x=0.89, y~0.57 -> default snare rect


def test_outside_all_zones_is_zone_none():
    hits = drive([1.0, 1.0, 0.5], xs=0.02, y0=0.10)
    assert len(hits) == 1
    assert hits[0].zone is None


# ---------------------------------------------------------------- synthetic cases

def test_every_synthetic_case_matches_expected():
    """Round-trip through JSON (the exact surface the TS parity test uses)."""
    for case in gen_cases():
        track = Track.from_json(case["track"])
        cfg_i = Config.from_dict(case["config"])
        hits = detect(track, cfg_i, default_zones())
        exp = case["expected"]
        assert len(hits) == exp["count"], case["name"]
        for h, e in zip(hits, exp["hits"]):
            assert h.report_t_ms == pytest.approx(e["t_ms"], abs=1e-6), case["name"]
            assert h.peak_t_ms == pytest.approx(e["peak_t_ms"], abs=1e-6), case["name"]
            assert h.hand == e["hand"], case["name"]
            assert h.zone == e["zone"], case["name"]
            assert h.velocity == pytest.approx(e["velocity"], abs=1e-9), case["name"]


def test_case_names_cover_the_design_space():
    names = {c.name for c in CASES}
    for required in (
        "single-stroke-snare",
        "double-fast-merged",
        "double-slow",
        "refractory-suppresses-second",
        "weak-stroke-below-vmin",
        "left-hand-hihat",
        "distance-invariant",
        "plateau-fire-on-decel",
        "stationary-hand",
        "both-hands-simultaneous",
        "low-confidence-ignored",
        "gap-then-second-stroke",
    ):
        assert required in names
