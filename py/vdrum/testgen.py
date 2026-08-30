"""Synthetic track generator: unit-test cases + parity fixtures (PLAN 7.2, 9b).

Builds deterministic landmark tracks (no video, no model) whose stroke
profiles are analytic. A stroke is a full *tap* -- descent then rebound --
exactly like a drum hit, defined in *velocity* space:

    descent  [s, s+T] :  v =  V * sin(pi * (t - s) / T)          # palm-widths/s
    rebound  [s+T, s+2T]:  v = -V * sin(pi * (t - s - T) / T)

so the true peak velocity V (at s + T/2 in the descent), its instant, and
the normalizer w are known exactly, and the hand returns to its rest height. The rebound matters: it is the physical re-arm signal the state
machine's refractory rule waits for (see HandState in detect.py), so strokes
without a rebound would exercise a regime a real tap never produces. These tracks feed BOTH the Python unit tests and the TS parity
gate (web/test/fixtures/*.json) -- identical input numbers on both sides,
which is what makes the port checkable rather than vibe-checked (PLAN 7.2).

Expected hit COUNTS are asserted here at generation time, so a case design
that no longer holds (e.g. after a constant change in Phase 2) fails loudly
in Python before it ever reaches the TS side.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .config import Config, default_config
from .detect import Track, Channel, detect
from .zones import ZoneSet, default_zones

FPS = 60.0
DT_MS = 1000.0 / FPS
DUR_S = 2.0
N_FRAMES = int(DUR_S * FPS)

# Aspect-corrected X (raw, un-mirrored) for the two zones the cases aim at.
# These are COUPLED to config/zones.json: each must sit inside the named zone's
# x range, or the fixtures stop testing what their names say they test. Kept as
# named constants so a kit re-layout is a two-line change here, not a hunt
# through the case list.
X_SNARE = 0.89  # zones.json snare x = [0.60, 1.18]
X_HIHAT = 1.25  # zones.json hi-hat x = [1.20, 1.68]


@dataclass(frozen=True)
class Stroke:
    V: float  # peak velocity, palm-widths/s
    s: float  # start, s
    T: float  # half-period, s


@dataclass
class HandSpec:
    hand: str
    x: float
    y0: float
    w: float
    conf: float = 0.9
    present: list[tuple[float, float]] = field(default_factory=lambda: [(0.0, DUR_S)])
    strokes: list[Stroke] = field(default_factory=list)
    y_fn: Callable[[float], float] | None = None  # overrides the stroke profile

    def y_at(self, t: float) -> float:
        if self.y_fn is not None:
            return self.y_fn(t)
        y = self.y0
        for st in self.strokes:
            amp = self.w * st.V * st.T / math.pi
            if st.s <= t <= st.s + st.T:
                y += amp * (1.0 - math.cos(math.pi * (t - st.s) / st.T))
            elif st.s + st.T < t <= st.s + 2.0 * st.T:
                # rebound: back to rest height, velocity symmetric to the descent
                y += amp * (1.0 + math.cos(math.pi * (t - st.s - st.T) / st.T))
        return y


def _gap_y(t: float) -> float:
    """Two windows at different heights: hand leaves and returns mid-session.

    Window A [0.25, 0.55] at height 0.55 (stroke s=0.30), window B [0.75, 1.05]
    at height 0.80 (stroke s=0.80). Reappearance is a 0.25-unit jump over a
    200 ms gap -- without the GAP_MS guard it would read as a strike.
    """
    w, V, T = 0.10, 15.7, 0.20
    amp = w * V * T / math.pi

    def bump(base: float, s: float, t: float) -> float:
        if s <= t <= s + T:
            return base + amp * (1.0 - math.cos(math.pi * (t - s) / T))
        return base + (2.0 * amp if t > s + T else 0.0)

    if 0.25 <= t <= 0.55:
        return bump(0.55, 0.30, t)
    if 0.75 <= t <= 1.05:
        return bump(0.80, 0.80, t)
    return 0.55


def _plateau_y(t: float) -> float:
    """Velocity ramp 0->1.2 on [0.30,0.34), flat 1.2 on [0.34,0.60), ramp down.

    Peak is only 1.2 (just above V_MIN=0.8): the decel confirmation
    (vy_n < 0.6 * peak) is the ONLY exit, so this case pins the fire-on-decel
    branch and rejects a fire-at-peak or fire-at-fade implementation.
    """
    w, y0 = 0.10, 0.55
    a = w * 1.2 * 0.04 ** 2 / (2.0 * 0.04)  # ramp displacement
    if t <= 0.30:
        return y0
    if t < 0.34:
        return y0 + w * 1.2 * (t - 0.30) ** 2 / (2.0 * 0.04)
    if t < 0.60:
        return y0 + a + w * 1.2 * (t - 0.34)
    if t <= 0.64:
        return y0 + a + w * 1.2 * 0.26 + (a - w * 1.2 * (0.64 - t) ** 2 / (2.0 * 0.04))
    return y0 + a + w * 1.2 * 0.26 + a


@dataclass
class Case:
    name: str
    description: str
    expected_count: int
    hands: list[HandSpec]
    filter_over: dict[str, float] | None = None  # per-case filter override

    def build_track(self) -> Track:
        t_ms = [i * DT_MS for i in range(N_FRAMES)]
        channels = {}
        for spec in self.hands:
            present = [1.0] * N_FRAMES
            for i, t in enumerate(t_ms):
                t_s = t / 1000.0
                if not any(lo <= t_s <= hi for lo, hi in spec.present):
                    present[i] = 0.0
            channels[spec.hand] = Channel(
                x=[spec.x] * N_FRAMES,
                y=[spec.y_at(i * DT_MS / 1000.0) for i in range(N_FRAMES)],
                scale=[spec.w] * N_FRAMES,
                conf=[spec.conf] * N_FRAMES,
                present=present,
            )
        return Track(t_ms=t_ms, channels=channels)


def _spec(hand: str, x: float, V: float, s: float, T: float,
          y0: float = 0.55, w: float = 0.10, **kw) -> HandSpec:
    return HandSpec(hand=hand, x=x, y0=y0, w=w, strokes=[Stroke(V, s, T)], **kw)


CASES: list[Case] = [
    Case(
        name="single-stroke-snare",
        description="One clean R-hand stroke through the snare zone.",
        expected_count=1,
        hands=[_spec("R", X_SNARE, V=15.7, s=0.30, T=0.20)],
    ),
    Case(
        name="double-fast-merged",
        description="Two fast strokes whose velocity bumps merge under the 1 Hz-class filter: one hit.",
        expected_count=1,
        hands=[HandSpec(hand="R", x=X_SNARE, y0=0.55, w=0.10,
                        strokes=[Stroke(31.4, 0.30, 0.06), Stroke(31.4, 0.35, 0.06)])],
    ),
    Case(
        name="double-slow",
        description="Two strokes 200 ms apart: both register.",
        expected_count=2,
        hands=[HandSpec(hand="R", x=X_SNARE, y0=0.55, w=0.10,
                        strokes=[Stroke(23.6, 0.30, 0.10), Stroke(23.6, 0.50, 0.10)])],
    ),
    Case(
        name="refractory-suppresses-second",
        description="Two separated peaks 50 ms apart (nearly unfiltered): the second is inside the 60 ms refractory and is suppressed.",
        expected_count=1,
        hands=[HandSpec(hand="R", x=X_SNARE, y0=0.55, w=0.10,
                        strokes=[Stroke(15.7, 0.30, 0.04), Stroke(15.7, 0.35, 0.04)])],
        filter_over={"min_cutoff": 1.0e6, "beta": 0.0, "d_cutoff": 1.0e6},
    ),
    Case(
        name="weak-stroke-below-vmin",
        description="Peak velocity below V_MIN: hand movement, not a strike.",
        expected_count=0,
        hands=[_spec("R", X_SNARE, V=0.7, s=0.30, T=0.20)],
    ),
    Case(
        name="left-hand-hihat",
        description="L-hand stroke in the hi-hat zone.",
        expected_count=1,
        hands=[_spec("L", X_HIHAT, V=15.7, s=0.30, T=0.20)],
    ),
    Case(
        name="distance-invariant",
        description="Same physical stroke at two apparent sizes (amplitude AND palm width halved): identical vy/w, so both hands register.",
        expected_count=2,
        hands=[
            _spec("R", X_SNARE, V=15.7, s=0.30, T=0.20, w=0.10),
            _spec("L", X_HIHAT, V=15.7, s=0.30, T=0.20, w=0.05),
        ],
    ),
    Case(
        name="plateau-fire-on-decel",
        description="Velocity plateaus at 1.2 then decays: fires exactly once, on the decel crossing (0.6 * peak), not at the peak or the fade.",
        expected_count=1,
        hands=[HandSpec(hand="R", x=X_SNARE, y0=0.55, w=0.10, y_fn=_plateau_y)],
    ),
    Case(
        name="stationary-hand",
        description="A held, still hand never fires.",
        expected_count=0,
        hands=[HandSpec(hand="R", x=X_SNARE, y0=0.60, w=0.10, strokes=[])],
    ),
    Case(
        name="both-hands-simultaneous",
        description="Both hands strike at once: one hit each, zones resolved per hand.",
        expected_count=2,
        hands=[
            _spec("R", X_SNARE, V=15.7, s=0.30, T=0.20),
            _spec("L", X_HIHAT, V=15.7, s=0.30, T=0.20),
        ],
    ),
    Case(
        name="low-confidence-ignored",
        description="A stroke with conf below MIN_CONF is skipped, not a hit.",
        expected_count=0,
        hands=[HandSpec(hand="R", x=X_SNARE, y0=0.55, w=0.10, conf=0.3, strokes=[Stroke(15.7, 0.30, 0.20)])],
    ),
    Case(
        name="gap-then-second-stroke",
        description="Hand leaves the frame and returns at a different height: the GAP_MS guard stops the teleport reading as a strike, and both real strokes still fire.",
        expected_count=2,
        hands=[HandSpec(hand="R", x=X_SNARE, y0=0.55, w=0.10,
                        present=[(0.25, 0.55), (0.75, 1.05)], y_fn=_gap_y)],
    ),
]


def gen_cases(cfg: Config | None = None, zones: ZoneSet | None = None) -> list[dict]:
    """Build every case, run detect() to get expected hits, assert counts."""
    cfg = cfg or default_config()
    zones = zones or default_zones()
    out = []
    for case in CASES:
        track = case.build_track()
        case_cfg = cfg.with_filter(**case.filter_over) if case.filter_over else cfg
        hits = detect(track, case_cfg, zones)
        assert len(hits) == case.expected_count, (
            f"case {case.name}: expected {case.expected_count} hit(s), got {len(hits)}: "
            f"{[h.to_dict() for h in hits]}"
        )
        out.append(
            {
                "name": case.name,
                "description": case.description,
                "config": case_cfg.to_dict(),
                "track": track.to_json(),
                "expected": {
                    "count": len(hits),
                    "hits": [
                        {
                            "t_ms": h.report_t_ms,
                            "peak_t_ms": h.peak_t_ms,
                            "hand": h.hand,
                            "zone": h.zone,
                            "velocity": h.velocity,
                        }
                        for h in hits
                    ],
                },
            }
        )
    return out


def write_fixtures(out_dir: str | Path, cfg: Config | None = None, zones: ZoneSet | None = None) -> list[Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for i, case in enumerate(gen_cases(cfg, zones), start=1):
        p = out_dir / f"case-{i:02d}-{case['name']}.json"
        p.write_text(json.dumps(case, indent=1))
        paths.append(p)
    return paths
