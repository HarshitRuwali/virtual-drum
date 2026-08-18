"""Hit detection on cached landmark tracks. THE PORTED CORE (PLAN 5, 9b).

Pure numpy + stdlib. This module never touches video, mediapipe, or the
network: it consumes a `Track`, so the Phase 2 sweep can run it thousands of
times without paying inference cost (14.66 ms/frame otherwise).

The TS port (web/src/detect.ts) mirrors this file operation-for-operation, in
the same order, over the same numbers -- that is what the parity gate (PLAN
7.2) checks. Do not "improve" one side independently.

Timing rules (PLAN 3.1, 3.2, 5):
  * t_ms is always the FRAME capture clock, never wall time.
  * Audio fires at peak detection (buys back 20-40 ms of pipeline latency).
  * The REPORTED timestamp is peak_t + OFFSET_MS, i.e. offset to the true
    strike instant so the readout stays honest (PLAN 8).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .config import Config
from .filter import OneEuro
from .zones import ZoneSet

# A position gap larger than this between two present frames is a hand
# re-identification glitch, not a stroke; never let it feed the velocity
# state machine (a teleport across the frame would otherwise read as a strike).
GAP_MS = 150.0


@dataclass(frozen=True)
class Contact:
    """One tracked hand at one frame. The Tracker interface (PLAN 4.1).

    x is aspect-corrected (X = x * W/H), y is normalized image y, scale is
    palm width ||p5 - p17|| in normalized units (the distance-invariance
    normalizer, PLAN 3.4). Un-mirrored coordinates; mirroring is render-only.
    """

    t_ms: float
    hand: str  # "L" | "R" (or a marker id later)
    x: float
    y: float
    scale: float
    conf: float


@dataclass(frozen=True)
class Hit:
    report_t_ms: float
    peak_t_ms: float
    hand: str
    zone: str | None
    velocity: float

    def to_dict(self) -> dict:
        return {
            "t_ms": self.report_t_ms,
            "peak_t_ms": self.peak_t_ms,
            "hand": self.hand,
            "zone": self.zone,
            "velocity": self.velocity,
        }


@dataclass
class Channel:
    x: np.ndarray
    y: np.ndarray
    scale: np.ndarray
    conf: np.ndarray
    present: np.ndarray


@dataclass
class Track:
    t_ms: np.ndarray
    channels: dict[str, Channel]

    @property
    def hands(self) -> list[str]:
        return list(self.channels)

    @classmethod
    def load(cls, path: str | Path) -> "Track":
        with np.load(path, allow_pickle=False) as d:
            hands = [str(h) for h in d["hands"]]
            channels = {
                h: Channel(
                    x=d[f"{h}_x"],
                    y=d[f"{h}_y"],
                    scale=d[f"{h}_scale"],
                    conf=d[f"{h}_conf"],
                    present=d[f"{h}_present"],
                )
                for h in hands
            }
            return cls(t_ms=np.asarray(d["t_ms"], dtype=np.float64), channels=channels)

    def save(self, path: str | Path) -> None:
        out: dict[str, object] = {"t_ms": self.t_ms, "hands": np.array(sorted(self.channels), dtype=object)}
        for h in sorted(self.channels):
            ch = self.channels[h]
            out[f"{h}_x"] = ch.x
            out[f"{h}_y"] = ch.y
            out[f"{h}_scale"] = ch.scale
            out[f"{h}_conf"] = ch.conf
            out[f"{h}_present"] = ch.present
        np.savez(path, **out)

    @classmethod
    def from_json(cls, raw: dict) -> "Track":
        """Build from a JSON dict (parity fixtures, PLAN 7.2)."""
        channels = {}
        for h in raw["hands"]:
            c = raw[h]
            channels[h] = Channel(
                x=np.asarray(c["x"], dtype=np.float64),
                y=np.asarray(c["y"], dtype=np.float64),
                scale=np.asarray(c["scale"], dtype=np.float64),
                conf=np.asarray(c["conf"], dtype=np.float64),
                present=np.asarray(c["present"], dtype=np.uint8),
            )
        return cls(t_ms=np.asarray(raw["t_ms"], dtype=np.float64), channels=channels)

    def to_json(self) -> dict:
        def f(a: np.ndarray) -> list[float]:
            return [float(v) for v in a]

        return {
            "t_ms": f(self.t_ms),
            "hands": sorted(self.channels),
            **{
                h: {
                    "x": f(self.channels[h].x),
                    "y": f(self.channels[h].y),
                    "scale": f(self.channels[h].scale),
                    "conf": f(self.channels[h].conf),
                    "present": [int(v) for v in self.channels[h].present],
                }
                for h in sorted(self.channels)
            },
        }


class HandState:
    """Per-hand velocity state machine (PLAN 5), with the One Euro filter.

    IDLE -> DESCENDING on vy_n > V_MIN; track the running peak; FIRE once
    velocity decays to DECEL_RATIO of the peak; REFRACTORY blocks a re-strike
    until REFRAC_MS has elapsed AND the velocity has settled back below V_MIN;
    a fade-out below V_MIN/2 before decel confirmation cancels.

    The settle test is load-bearing: the One Euro filter keeps "descending"
    for hundreds of ms after the hand actually stops (its tail catching up),
    and a time-only refractory would let that tail re-arm and fire a ghost
    second hit ~180 ms later. A genuine re-strike always rebounds first (the
    hand goes back up), which settles the velocity and passes both tests.

    A stroke still in progress when tracking is lost (the hand exits the
    frame, or confidence drops) is committed by `commit_if_pending()` at its
    observed peak: otherwise the decel confirmation never arrives and a hand
    that leaves the frame right after a strike loses the hit entirely.
    """

    __slots__ = (
        "hand", "oe", "state", "peak", "peak_t", "fire_t",
        "peak_x", "peak_y", "peak_scale", "yf_prev", "t_prev",
    )

    def __init__(self, hand: str, cfg: Config):
        f = cfg.filter
        self.hand = hand
        self.oe = OneEuro(f.min_cutoff, f.beta, f.d_cutoff)
        self.state = "IDLE"
        self.peak = 0.0
        self.peak_t = 0.0
        self.fire_t = 0.0
        self.peak_x = 0.0
        self.peak_y = 0.0
        self.peak_scale = 1.0
        self.yf_prev: float | None = None
        self.t_prev: float | None = None

    def step(self, t_ms: float, x: float, y: float, scale: float, cfg: Config,
             zones: ZoneSet | None) -> Hit | None:
        det = cfg.detection
        if self.t_prev is not None and (t_ms - self.t_prev) > GAP_MS:
            # The hand left and came back (or a re-ID glitch). The One Euro
            # filter's memory across the gap would read as a phantom stroke,
            # so resync the filter too. Any in-progress stroke was already
            # committed by commit_if_pending() before we got here.
            self.oe.reset()
            self.state = "IDLE"
            self.yf_prev = None
            self.t_prev = None
        yf = self.oe(t_ms / 1000.0, y)
        if self.yf_prev is None:
            self.yf_prev = yf
            self.t_prev = t_ms
            return None
        gap = t_ms - self.t_prev
        if gap <= 0.0:
            self.yf_prev = yf
            self.t_prev = t_ms
            return None
        vy_n = (yf - self.yf_prev) / (gap / 1000.0) / scale
        self.yf_prev = yf
        self.t_prev = t_ms

        if self.state == "IDLE":
            if vy_n > det.v_min:
                self.state = "DESCENDING"
                self.peak = vy_n
                self.peak_t = t_ms
                self.peak_x = x
                self.peak_y = yf
                self.peak_scale = scale
        elif self.state == "DESCENDING":
            if vy_n > self.peak:
                self.peak = vy_n
                self.peak_t = t_ms
                self.peak_x = x
                self.peak_y = yf
                self.peak_scale = scale
            elif vy_n < self.peak * det.decel_ratio:
                hit = self._fire(cfg, zones)
                self.state = "REFRACTORY"
                self.fire_t = t_ms
                return hit
            elif vy_n < det.v_min * 0.5:
                # Faded out before decel was confirmed: movement, not a strike.
                self.state = "IDLE"
        elif self.state == "REFRACTORY":
            if t_ms - self.fire_t > det.refrac_ms and vy_n < det.v_min:
                self.state = "IDLE"
        return None

    def _fire(self, cfg: Config, zones: ZoneSet | None) -> Hit:
        det = cfg.detection
        span = det.v_max - det.v_min
        velocity = max(0.0, min(1.0, (self.peak - det.v_min) / span)) if span > 0 else 0.0
        zone = zones.lookup(self.peak_x, self.peak_y, self.peak_scale) if zones else None
        return Hit(
            report_t_ms=self.peak_t + det.offset_ms,
            peak_t_ms=self.peak_t,
            hand=self.hand,
            zone=zone.id if zone else None,
            velocity=velocity,
        )

    def commit_if_pending(self, cfg: Config, zones: ZoneSet | None, t_ms: float) -> Hit | None:
        """The hand stopped being tracked (left the frame, low confidence,
        zero scale) while a stroke was in progress: commit it at its observed
        peak. Without this, the decel confirmation never arrives for a hand
        that leaves the frame right after a strike, and the hit is lost.
        """
        if self.state != "DESCENDING":
            return None
        hit = self._fire(cfg, zones)
        self.state = "REFRACTORY"
        self.fire_t = t_ms
        return hit


def detect(track: Track, cfg: Config, zones: ZoneSet | None = None) -> list[Hit]:
    """Run the per-hand state machines over a track. Pure function of inputs.

    A stroke in progress when a hand stops being tracked (absent, low
    confidence, zero scale) is committed at its observed peak -- see
    HandState.commit_if_pending().
    """
    hits: list[Hit] = []
    det = cfg.detection
    for hand in track.hands:
        ch = track.channels[hand]
        hs = HandState(hand, cfg)
        for i in range(len(track.t_ms)):
            t_i = float(track.t_ms[i])
            tracked = bool(ch.present[i]) and ch.conf[i] >= det.min_conf and ch.scale[i] > 0.0
            if tracked:
                hit = hs.step(t_i, float(ch.x[i]), float(ch.y[i]), float(ch.scale[i]), cfg, zones)
            else:
                hit = hs.commit_if_pending(cfg, zones, t_i)
            if hit is not None:
                hits.append(hit)
    # Total order: simultaneous hits (same report_t_ms) must come out in the
    # same order regardless of channel dict order (a JSON round-trip sorts the
    # hands list) -- required for the TS parity gate.
    hits.sort(key=lambda h: (h.report_t_ms, h.hand))
    return hits
