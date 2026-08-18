"""Zone model + calibration (PLAN 6.1).

Zones are axis-aligned rectangles in aspect-corrected normalized space
(X = x * W/H, Y = y), optionally banded by `scale` (palm width) as the depth
proxy. `scale` is stored because w is proportional to 1/distance, so a band on
w is a band on depth (PLAN 3.4).

Coordinates are UN-mirrored (raw) image space; mirroring happens only at render
time (PLAN 3.5), so zone x ranges read as raw-image x, which for a mirrored
selfie view is the *opposite* screen side.
"""
from __future__ import annotations

import json
import statistics
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Zone:
    id: str
    x0: float
    x1: float
    y0: float
    y1: float
    scale_min: float = 0.0
    scale_max: float = 1.0
    sample: str | None = None

    def contains(self, x: float, y: float, scale: float) -> bool:
        return (
            self.x0 <= x <= self.x1
            and self.y0 <= y <= self.y1
            and self.scale_min <= scale <= self.scale_max
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "x": [self.x0, self.x1],
            "y": [self.y0, self.y1],
            "scale": [self.scale_min, self.scale_max],
            "sample": self.sample,
        }


@dataclass
class ZoneSet:
    zones: list[Zone]

    @classmethod
    def load(cls, path: str | Path) -> "ZoneSet":
        raw = json.loads(Path(path).read_text())
        zones = []
        for z in raw.get("zones", []):
            sc = z.get("scale", [0.0, 1.0])
            zones.append(
                Zone(
                    id=z["id"],
                    x0=z["x"][0],
                    x1=z["x"][1],
                    y0=z["y"][0],
                    y1=z["y"][1],
                    scale_min=sc[0],
                    scale_max=sc[1],
                    sample=z.get("sample"),
                )
            )
        return cls(zones=zones)

    def lookup(self, x: float, y: float, scale: float) -> Zone | None:
        for z in self.zones:
            if z.contains(x, y, scale):
                return z
        return None

    def calibrate(self, zone_id: str, samples: list[tuple[float, float, float]], padding: float = 0.08) -> Zone:
        """samples: [(x, y, scale), ...] ~15 frames held at the target position.

        Take the median of each coordinate (robust to a stray frame) and store a
        rectangle of `padding` around it (PLAN 6.1).
        """
        if not samples:
            raise ValueError("no samples")
        cx = statistics.median(s[0] for s in samples)
        cy = statistics.median(s[1] for s in samples)
        # No depth band by default: scale banding is optional (PLAN 6.1).
        return Zone(id=zone_id, x0=cx - padding, x1=cx + padding, y0=cy - padding, y1=cy + padding,
                    scale_min=0.0, scale_max=1.0)

    def to_dict(self) -> dict:
        return {"zones": [z.to_dict() for z in self.zones]}


DEFAULT_ZONES_PATH = Path(__file__).resolve().parents[2] / "config" / "zones.json"


def default_zones() -> ZoneSet:
    return ZoneSet.load(DEFAULT_ZONES_PATH)
