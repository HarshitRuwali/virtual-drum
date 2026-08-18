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

_FIELDS = ("x", "y", "scale", "conf", "present")


class TrackBuilder:
    """Accumulates per-frame Contacts into equal-length channel arrays.

    THE INVARIANT: every channel is exactly as long as the frame list. detect()
    walks `range(len(track.t_ms))` and indexes each channel at `i`, so any
    channel that is short raises IndexError partway through a real clip.

    Two ways that invariant used to break, both fixed here:

      * A hand first detected at frame k (it enters the frame late, or
        MediaPipe misses the opening frames -- the normal case) started an
        empty channel, leaving it k samples short forever.
      * MediaPipe can label BOTH hands with the same handedness, which mapped
        two contacts onto one channel in a single frame and made it too long.
        First contact wins; the duplicate is counted and dropped.

    Kept free of cv2/mediapipe so it is unit-testable (py/tests/test_extract.py).
    """

    def __init__(self) -> None:
        self.hands: list[str] = []
        self.data: dict[str, dict[str, list[float]]] = {}
        self.t_ms: list[float] = []
        self.dropped_duplicates = 0

    def _ensure(self, hand: str) -> None:
        if hand not in self.data:
            pad = len(self.t_ms)  # frames completed before this one
            self.data[hand] = {f: [0.0] * pad for f in _FIELDS}
            self.hands.append(hand)

    def add_frame(self, t_ms: float, contacts) -> None:
        seen: set[str] = set()
        for c in contacts:
            if c.hand in seen:
                self.dropped_duplicates += 1
                continue
            self._ensure(c.hand)
            d = self.data[c.hand]
            d["x"].append(c.x)
            d["y"].append(c.y)
            d["scale"].append(c.scale)
            d["conf"].append(c.conf)
            d["present"].append(1.0)
            seen.add(c.hand)
        for h in self.data:
            if h not in seen:
                d = self.data[h]
                for f in _FIELDS:
                    d[f].append(0.0)
        self.t_ms.append(t_ms)

    def build(self) -> Track:
        n = len(self.t_ms)
        if n == 0:
            raise RuntimeError("no frames added")
        for h in self.hands:
            got = len(self.data[h]["present"])
            if got != n:
                raise AssertionError(
                    f"channel {h!r} has {got} samples for {n} frames -- the "
                    "length invariant in TrackBuilder is broken"
                )
        channels = {
            h: Channel(
                x=np.asarray(self.data[h]["x"], dtype=np.float64),
                y=np.asarray(self.data[h]["y"], dtype=np.float64),
                scale=np.asarray(self.data[h]["scale"], dtype=np.float64),
                conf=np.asarray(self.data[h]["conf"], dtype=np.float64),
                present=np.asarray(self.data[h]["present"], dtype=np.uint8),
            )
            for h in self.hands
        }
        return Track(t_ms=np.asarray(self.t_ms, dtype=np.float64), channels=channels)


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
    builder = TrackBuilder()

    idx = 0
    t0 = time.perf_counter()
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        t_ms = idx * 1000.0 / fps
        idx += 1
        builder.add_frame(t_ms, tracker.process(frame, t_ms))
    cap.release()

    if not builder.t_ms:
        raise RuntimeError(f"no frames decoded from {video}")
    track = builder.build()

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    track.save(out_path)

    n = len(builder.t_ms)
    elapsed = (time.perf_counter() - t0) * 1000.0
    dup = f", {builder.dropped_duplicates} duplicate-handedness contacts dropped" \
        if builder.dropped_duplicates else ""
    print(f"[extract] {video}: {n} frames @ {fps:.1f} fps -> {out_path} "
          f"({elapsed / max(n, 1):.2f} ms/frame{dup})", flush=True)
    return track
