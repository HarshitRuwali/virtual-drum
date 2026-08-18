"""extract + detect, end to end (PLAN 4)."""
from __future__ import annotations

from pathlib import Path

from .config import Config
from .detect import Track, Hit, detect
from .extract import extract
from .zones import ZoneSet


def run(video: str | Path, model_path: str | Path, cfg: Config,
        zones: ZoneSet | None = None, out_track: str | Path | None = None) -> tuple[Track, list[Hit]]:
    track = extract(video, model_path, out_track or Path("tracks") / (Path(video).stem + ".npz"), cfg)
    hits = detect(track, cfg, zones)
    return track, hits
