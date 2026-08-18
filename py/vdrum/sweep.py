"""Phase 2 parameter sweep (PLAN 5.2, 7.1).

Grid-searches the tuning constants against cached tracks + labelled fixtures,
running only the cheap half (detect). Ranked by F1 first, then jitter
(stddev) second -- NEVER by bias: bias is a calibration constant (PLAN 8),
jitter is irreducible pipeline quality.
"""
from __future__ import annotations

import itertools
import json
from dataclasses import dataclass, fields
from pathlib import Path

from .config import Config, DetectCfg, FilterCfg, default_config
from .detect import Track, detect
from .score import score
from .zones import ZoneSet

DEFAULT_GRID: dict[str, list[float]] = {
    "v_min": [0.4, 0.6, 0.8, 1.2],
    "decel_ratio": [0.4, 0.6, 0.8],
    "beta": [0.02, 0.05, 0.10],
}

# Which config section each grid key belongs to, derived from the dataclasses
# so adding a field to either one is picked up automatically. The old code
# hardcoded "beta" as the only filter key, so putting min_cutoff in the grid
# raised TypeError inside with_detection().
_FILTER_KEYS = {f.name for f in fields(FilterCfg)}
_DETECT_KEYS = {f.name for f in fields(DetectCfg)}


def _split_overrides(params: dict[str, float]) -> tuple[dict, dict]:
    det, filt, unknown = {}, {}, []
    for k, v in params.items():
        if k in _FILTER_KEYS:
            filt[k] = v
        elif k in _DETECT_KEYS:
            det[k] = v
        else:
            unknown.append(k)
    if unknown:
        raise KeyError(
            f"grid key(s) {unknown} match no field of FilterCfg or DetectCfg; "
            f"known: {sorted(_FILTER_KEYS | _DETECT_KEYS)}"
        )
    return det, filt


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


def _pairs(fixtures_dir: Path, tracks_dir: Path) -> list[tuple[str, dict, Path]]:
    """(name, truth, track_path): fixtures/<n>.hits.json + tracks/<n>.npz.

    `.hits.json` stems come out as "<n>.hits", so strip the extra suffix to
    match the track stem.
    """
    truths = {
        p.name[: -len(".hits.json")]: json.loads(p.read_text())
        for p in sorted(fixtures_dir.glob("*.hits.json"))
    }
    tracks = {p.stem: p for p in sorted(tracks_dir.glob("*.npz"))}
    return [(name, truths[name], tracks[name]) for name in truths if name in tracks]


def run_sweep(fixtures_dir: str | Path = "fixtures", cfg: Config | None = None,
              zones: ZoneSet | None = None, grid: dict[str, list[float]] | None = None,
              tracks_dir: str | Path = "tracks") -> list[Row]:
    cfg = cfg or default_config()
    grid = grid or DEFAULT_GRID
    pairs = _pairs(Path(fixtures_dir), Path(tracks_dir))
    if not pairs:
        return []

    # Load every track ONCE, outside the grid loop. Re-reading and re-parsing
    # the .npz per combination (the default grid is 4*3*3 = 36) throws away the
    # extract/detect split this module exists to exploit (PLAN 9b).
    loaded = [(name, truth, Track.load(trk)) for name, truth, trk in pairs]

    keys = list(grid)
    rows: list[Row] = []
    for combo in itertools.product(*(grid[k] for k in keys)):
        params = dict(zip(keys, combo))
        det_over, filt_over = _split_overrides(params)
        sweep_cfg = cfg
        if det_over:
            sweep_cfg = sweep_cfg.with_detection(**det_over)
        if filt_over:
            sweep_cfg = sweep_cfg.with_filter(**filt_over)

        tp = fp = fn = 0
        dts: list[float] = []
        for name, truth, track in loaded:
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
