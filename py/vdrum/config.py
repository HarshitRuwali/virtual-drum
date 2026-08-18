"""Tuning constants.

`config/default.json` is the single source of truth, read by BOTH the Python
and the TS implementations (PLAN 4). Neither side may hardcode these values;
tuning them in one place updates both, which is what stops the two detectors
drifting apart after the first tuning pass.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace
from pathlib import Path


@dataclass(frozen=True)
class FilterCfg:
    min_cutoff: float
    beta: float
    d_cutoff: float


@dataclass(frozen=True)
class DetectCfg:
    v_min: float
    v_max: float
    decel_ratio: float
    refrac_ms: float
    offset_ms: float
    min_conf: float
    match_window_ms: float


@dataclass(frozen=True)
class HandCfg:
    track_landmark: int
    palm_a: int
    palm_b: int
    num_hands: int


@dataclass(frozen=True)
class Config:
    filter: FilterCfg
    detection: DetectCfg
    hand: HandCfg

    @classmethod
    def load(cls, path: str | Path) -> "Config":
        raw = json.loads(Path(path).read_text())
        return cls.from_dict(raw)

    @classmethod
    def from_dict(cls, raw: dict) -> "Config":
        return cls(
            filter=FilterCfg(**raw["filter"]),
            detection=DetectCfg(**raw["detection"]),
            hand=HandCfg(**raw["hand"]),
        )

    def to_dict(self) -> dict:
        return {
            "filter": {
                "min_cutoff": self.filter.min_cutoff,
                "beta": self.filter.beta,
                "d_cutoff": self.filter.d_cutoff,
            },
            "detection": {
                "v_min": self.detection.v_min,
                "v_max": self.detection.v_max,
                "decel_ratio": self.detection.decel_ratio,
                "refrac_ms": self.detection.refrac_ms,
                "offset_ms": self.detection.offset_ms,
                "min_conf": self.detection.min_conf,
                "match_window_ms": self.detection.match_window_ms,
            },
            "hand": {
                "track_landmark": self.hand.track_landmark,
                "palm_a": self.hand.palm_a,
                "palm_b": self.hand.palm_b,
                "num_hands": self.hand.num_hands,
            },
        }

    def with_detection(self, **overrides: float) -> "Config":
        return replace(self, detection=replace(self.detection, **overrides))

    def with_filter(self, **overrides: float) -> "Config":
        return replace(self, filter=replace(self.filter, **overrides))


def find_config_dir() -> Path:
    """Locate the shared `config/` directory (PLAN 4: one source of truth).

    Checked in order: $VDRUM_CONFIG_DIR, then every ancestor of this file, then
    the CWD. Plain `parents[2]` only resolves when running from a source
    checkout -- an installed package sits in site-packages, where parents[2] is
    unrelated, so `vdrum` (the console script this project declares) could never
    find its own config.
    """
    env = os.environ.get("VDRUM_CONFIG_DIR")
    if env:
        d = Path(env).expanduser().resolve()
        if (d / "default.json").is_file():
            return d
        raise FileNotFoundError(f"VDRUM_CONFIG_DIR={env} has no default.json")
    here = Path(__file__).resolve()
    for base in (*here.parents, Path.cwd()):
        d = base / "config"
        if (d / "default.json").is_file():
            return d
    raise FileNotFoundError(
        "cannot locate config/default.json; set VDRUM_CONFIG_DIR to the "
        "directory holding default.json and zones.json"
    )


def default_config() -> Config:
    return Config.load(find_config_dir() / "default.json")
