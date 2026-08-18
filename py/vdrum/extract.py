"""Video -> cached landmark track (PLAN 9b). The expensive half of the pipeline.

One MediaPipe inference per frame (~15 ms CPU here), run ONCE per fixture. The
result is a .npz that detect.py -- cheap, pure numpy -- can be re-run against
thousands of times during the Phase 2 sweep. `detect.py` must never own a
VideoCapture; this module is the only place that does.

Timestamps come from the frame clock (index * 1000 / fps), never wall time
(PLAN 3.1).
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np

from .config import Config
from .detect import Track, Channel
from .tracker import HandTracker


def extract(video: str | Path, model_path: str | Path, out_path: str | Path,
            cfg: Config, fps_override: float | None = None) -> Track:
    import cv2

    video = str(video)
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open video: {video}")
    fps = fps_override or cap.get(cv2.CAP_PROP_FPS) or 30.0
    if not (fps > 1.0):
        fps = 30.0

    tracker = HandTracker(model_path, cfg)

    hands: list[str] = []
    data: dict[str, dict[str, list[float]]] = {}

    def ensure(hand: str) -> None:
        if hand not in data:
            data[hand] = {"x": [], "y": [], "scale": [], "conf": [], "present": []}
            hands.append(hand)

    t_list: list[float] = []
    idx = 0
    t0 = time.perf_counter()
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        t_ms = idx * 1000.0 / fps
        idx += 1
        seen: set[str] = set()
        for c in tracker.process(frame, t_ms):
            ensure(c.hand)
            d = data[c.hand]
            d["x"].append(c.x)
            d["y"].append(c.y)
            d["scale"].append(c.scale)
            d["conf"].append(c.conf)
            d["present"].append(1.0)
            seen.add(c.hand)
        for h in data:
            if h not in seen:
                d = data[h]
                d["x"].append(0.0)
                d["y"].append(0.0)
                d["scale"].append(0.0)
                d["conf"].append(0.0)
                d["present"].append(0.0)
        t_list.append(t_ms)
    cap.release()

    n = len(t_list)
    if n == 0:
        raise RuntimeError(f"no frames decoded from {video}")
    channels = {
        h: Channel(
            x=np.asarray(data[h]["x"], dtype=np.float64),
            y=np.asarray(data[h]["y"], dtype=np.float64),
            scale=np.asarray(data[h]["scale"], dtype=np.float64),
            conf=np.asarray(data[h]["conf"], dtype=np.float64),
            present=np.asarray(data[h]["present"], dtype=np.uint8),
        )
        for h in hands
    }
    track = Track(t_ms=np.asarray(t_list, dtype=np.float64), channels=channels)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    track.save(out_path)

    elapsed = (time.perf_counter() - t0) * 1000.0
    print(f"[extract] {video}: {n} frames @ {fps:.1f} fps -> {out_path} "
          f"({elapsed / max(n, 1):.2f} ms/frame)", flush=True)
    return track
