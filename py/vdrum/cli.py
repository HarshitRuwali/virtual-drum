"""vdrum command-line interface.

    vdrum extract  clip.mp4                      # video -> tracks/clip.npz (once)
    vdrum detect   clip.mp4 | tracks/clip.npz    # track -> hits (cheap)
    vdrum score    hits.json truth.json          # P/R/F1 + bias + jitter
    vdrum sweep    [--fixtures dir]              # Phase 2 grid search
    vdrum fetch-model [--out path]               # download the shared model asset
    vdrum gen-parity-fixtures [--out dir]        # PLAN 7.2 parity fixtures
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .config import Config, default_config, DEFAULT_CONFIG_PATH

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)
MODEL_EXPECTED_BYTES = 7_819_105  # PLAN 2: pinned asset size

VIDEO_EXTS = (".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v")


def _load_cfg(args) -> Config:
    return Config.load(args.config) if args.config else default_config()


def _load_zones(args):
    from .zones import ZoneSet, default_zones

    if args.zones:
        return ZoneSet.load(args.zones)
    try:
        return default_zones()
    except FileNotFoundError:
        return None


def cmd_extract(args) -> int:
    from .extract import extract

    cfg = _load_cfg(args)
    out = Path(args.out) if args.out else Path("tracks") / (Path(args.video).stem + ".npz")
    track = extract(args.video, _model_path(args), out, cfg)
    print(f"[extract] saved {out} ({len(track.t_ms)} frames, hands={track.hands})")
    return 0


def _model_path(args) -> Path:
    p = Path(getattr(args, "model", None) or os.environ.get("VDRUM_MODEL") or "assets/hand_landmarker.task")
    if not p.exists():
        sys.exit(f"model asset not found: {p} (run: vdrum fetch-model --out {p})")
    return p


def cmd_detect(args) -> int:
    from .detect import Track, detect

    cfg = _load_cfg(args)
    zones = _load_zones(args)

    p = Path(args.path)
    if p.suffix.lower() in VIDEO_EXTS:
        track_path = Path(args.track_out) if args.track_out else Path("tracks") / (p.stem + ".npz")
        if track_path.exists() and not args.force:
            print(f"[detect] using cached track {track_path} (pass --force to re-extract)", file=sys.stderr)
        else:
            from .extract import extract
            track_path.parent.mkdir(parents=True, exist_ok=True)
            extract(p, _model_path(args), track_path, cfg)
        track = Track.load(track_path)
    else:
        track = Track.load(p)

    hits = detect(track, cfg, zones)
    result = {
        "source": str(p),
        "config": str(getattr(args, "config", None) or DEFAULT_CONFIG_PATH),
        "hits": [h.to_dict() for h in hits],
    }
    text = json.dumps(result, indent=2)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text + "\n")
        print(f"[detect] {len(hits)} hits -> {args.out}")
    else:
        print(text)
    return 0


def _t_list(raw) -> list[float]:
    if isinstance(raw, list) and raw and isinstance(raw[0], dict):
        return [float(h["t_ms"]) for h in raw]
    if isinstance(raw, dict) and "hits" in raw:
        return _t_list(raw["hits"])
    return [float(t) for t in (raw or [])]


def cmd_score(args) -> int:
    from .score import score

    cfg = _load_cfg(args)
    window = args.window if args.window is not None else cfg.detection.match_window_ms
    pred = _t_list(json.loads(Path(args.predicted).read_text()))
    truth = _t_list(json.loads(Path(args.truth).read_text()))
    s = score(pred, truth, window)
    print(
        f"matched {s.tp}  FP {s.fp}  FN {s.fn}  "
        f"P {s.precision:.3f}  R {s.recall:.3f}  F1 {s.f1:.3f}  "
        f"bias {s.bias_ms:+.1f} ms  jitter {s.jitter_ms:.1f} ms  (window ±{window:.0f} ms)"
    )
    return 0


def cmd_sweep(args) -> int:
    from .sweep import run_sweep, DEFAULT_GRID

    cfg = _load_cfg(args)
    zones = _load_zones(args)
    grid = dict(DEFAULT_GRID)
    if args.grid:
        for spec in args.grid:
            key, _, vals = spec.partition("=")
            grid[key] = [float(v) for v in vals.split(",")]
    rows = run_sweep(args.fixtures, cfg, zones, grid)
    if not rows:
        sys.exit("no (fixtures/*.hits.json + tracks/*.npz) pairs found -- record fixtures (Phase 0) and run `vdrum extract` first")
    print(f"{'v_min':>6} {'decel':>6} {'beta':>7} | {'F1':>7} {'jitter':>7} {'bias':>7} | {'P':>6} {'R':>6}")
    for r in rows[: args.top]:
        p = r.params
        print(
            f"{p.get('v_min', 0):>6} {p.get('decel_ratio', 0):>6} {p.get('beta', 0):>7} | "
            f"{r.f1:>7.3f} {r.jitter_ms:>7.1f} {r.bias_ms:>+7.1f} | {r.precision:>6.3f} {r.recall:>6.3f}"
        )
    if args.out:
        lines = ["v_min,decel_ratio,beta,f1,jitter_ms,bias_ms,precision,recall"]
        for r in rows:
            p = r.params
            lines.append(
                f"{p.get('v_min', '')},{p.get('decel_ratio', '')},{p.get('beta', '')},"
                f"{r.f1:.4f},{r.jitter_ms:.2f},{r.bias_ms:.2f},{r.precision:.4f},{r.recall:.4f}"
            )
        Path(args.out).write_text("\n".join(lines) + "\n")
        print(f"[sweep] {len(rows)} rows -> {args.out}")
    return 0


def cmd_fetch_model(args) -> int:
    import urllib.request

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"[fetch-model] {args.url}\n                 -> {out}")
    with urllib.request.urlopen(args.url, timeout=120) as r:  # noqa: S310
        data = r.read()
    if len(data) != MODEL_EXPECTED_BYTES:
        print(f"[fetch-model] WARNING: size {len(data)} != expected {MODEL_EXPECTED_BYTES} (PLAN 2)", file=sys.stderr)
    out.write_bytes(data)
    print(f"[fetch-model] {len(data)} bytes")
    return 0


def cmd_gen_parity(args) -> int:
    from .testgen import write_fixtures

    cfg = _load_cfg(args)
    from .zones import default_zones

    paths = write_fixtures(args.out, cfg, default_zones())
    for p in paths:
        print(f"[gen-parity] {p}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="vdrum", description="headless air-drum detection core")
    ap.add_argument("--config", default=None, help="path to config JSON (default: config/default.json)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("extract", help="video -> cached landmark track")
    sp.add_argument("video")
    sp.add_argument("--out", default=None)
    sp.add_argument("--model", default=None, help="hand_landmarker.task path")
    sp.set_defaults(fn=cmd_extract)

    sp = sub.add_parser("detect", help="track (or video) -> hits")
    sp.add_argument("path", help="clip.mp4 or tracks/x.npz")
    sp.add_argument("--out", default=None, help="write hits JSON here")
    sp.add_argument("--zones", default=None, help="zones JSON (default: config/zones.json)")
    sp.add_argument("--track-out", default=None, help="track cache path when path is a video")
    sp.add_argument("--model", default=None)
    sp.add_argument("--force", action="store_true", help="re-extract even if a cached track exists")
    sp.set_defaults(fn=cmd_detect)

    sp = sub.add_parser("score", help="score predicted hits against labelled truth")
    sp.add_argument("predicted")
    sp.add_argument("truth")
    sp.add_argument("--window", type=float, default=None, help="match window ms (default: config)")
    sp.set_defaults(fn=cmd_score)

    sp = sub.add_parser("sweep", help="Phase 2 parameter sweep over fixtures")
    sp.add_argument("--fixtures", default="fixtures")
    sp.add_argument("--zones", default=None)
    sp.add_argument("--grid", action="append", default=[], help="key=v1,v2 (e.g. v_min=0.4,0.6,0.8)")
    sp.add_argument("--top", type=int, default=10)
    sp.add_argument("--out", default=None, help="write CSV")
    sp.set_defaults(fn=cmd_sweep)

    sp = sub.add_parser("fetch-model", help="download the shared hand_landmarker.task")
    sp.add_argument("--out", default="assets/hand_landmarker.task")
    sp.add_argument("--url", default=MODEL_URL)
    sp.set_defaults(fn=cmd_fetch_model)

    sp = sub.add_parser("gen-parity-fixtures", help="generate PLAN 7.2 parity fixtures for the TS side")
    sp.add_argument("--out", default="web/test/fixtures")
    sp.set_defaults(fn=cmd_gen_parity)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
