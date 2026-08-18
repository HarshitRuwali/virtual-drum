"""Phase 2 parameter sweep (PLAN 5.2, 7.1).

Grid-searches the tuning constants against cached tracks + labelled fixtures,
running only the cheap half (detect). Ranked by F1 first, then jitter
(stddev) second -- NEVER by bias: bias is a calibration constant (PLAN 8),
jitter is irreducible pipeline quality.
"""
from __future__ import annotations

import itertools
import json
from dataclasses import dataclass
from pathlib import Path

from .config import Config
from .detect import Track, detect
from .score import score
from .zones import ZoneSet

DEFAULT_GRID: dict[str, list[float]] = {
    "v_min": [0.4, 0.6, 0.8, 1.2],
    "decel_ratio": [0.4, 0.6, 0.8],
    "beta": [0.02, 0.05, 0.10],
}


@dataclass
class Row:
    params: dict[str, float]
    f1: float
    jitter_ms: float
    bias_ms: float
    precision: float
    recall: float

    def to_dict(self) -> dict:
        d = dict(self.params)
        d.update(
            f1=self.f1, jitter_ms=self.jitter_ms, bias_ms=self.bias_ms,
            precision=self.precision, recall=self.recall,
        )
        return d


def _pairs(fixtures_dir: Path) -> list[tuple[str, dict, Path]]:
    """(name, truth, track_path): a fixture is fixtures/<n>.hits.json + tracks/<n>.npz."""
    truths = {p.stem: json.loads(p.read_text()) for p in sorted(fixtures_dir.glob("*.hits.json"))}
    tracks = {p.stem: p for p in sorted(Path("tracks").glob("*.npz"))}
    return [(name, truths[name], tracks[name]) for name in truths if name in tracks]


def run_sweep(fixtures_dir: str | Path = "fixtures", cfg: Config | None = None,
              zones: ZoneSet | None = None, grid: dict[str, list[float]] | None = None) -> list[Row]:
    cfg = cfg or Config.load(Path(__file__).resolve().parents[2] / "config" / "default.json")
    grid = grid or DEFAULT_GRID
    pairs = _pairs(Path(fixtures_dir))
    if not pairs:
        return []

    keys = list(grid)
    rows: list[Row] = []
    for combo in itertools.product(*(grid[k] for k in keys)):
        params = dict(zip(keys, combo))
        sweep_cfg = cfg
        det_over = {k: v for k, v in params.items() if k != "beta"}
        filt_over = {"beta": params["beta"]} if "beta" in params else {}
        if det_over:
            sweep_cfg = sweep_cfg.with_detection(**det_over)
        if filt_over:
            sweep_cfg = sweep_cfg.with_filter(**filt_over)

        tp = fp = fn = 0
        dts: list[float] = []
        for name, truth, trk in pairs:
            track = Track.load(trk)
            hits = detect(track, sweep_cfg, zones)
            gt = [float(h["t_ms"]) for h in truth.get("hits", [])]
            s = score([h.report_t_ms for h in hits], gt, cfg.detection.match_window_ms)
            tp += s.tp
            fp += s.fp
            fn += s.fn
            dts.extend(p - g for p, g in s.matched)

        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = (2.0 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
        if dts:
            bias = sum(dts) / len(dts)
            jitter = (sum((d - bias) ** 2 for d in dts) / len(dts)) ** 0.5
        else:
            bias = 0.0
            jitter = 0.0
        rows.append(Row(params, f1, jitter, bias, precision, recall))

    rows.sort(key=lambda r: (-r.f1, r.jitter_ms))
    return rows
