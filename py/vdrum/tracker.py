"""HandTracker: the MediaPipe-backed Tracker (PLAN 4.1).

The Tracker seam is what makes the Phase 6 marker swap a drop-in: detect.py
only ever sees Contact objects and never learns which tracker produced them.

Handedness -- written down, as PLAN 3.5 requires:
  We keep DETECTION in raw (un-mirrored) coordinates and mirror only at render
  time. MediaPipe's handedness assumes a mirrored selfie image, so on a raw
  webcam frame the user's RIGHT hand is labelled "Left". We swap below, so
  "R" always means the hand on the right side of the mirrored view the player
  sees (and the zone they intend to hit).
"""
from __future__ import annotations

import math

from .config import Config
from .detect import Contact


def contact_from_landmarks(landmarks, handedness, width: int, height: int, t_ms: float, cfg: Config) -> Contact:
    """Pure math: one hand's normalized landmarks -> a Contact.

    `landmarks` is any sequence of 21 objects with .x/.y in 0..1 image space;
    `handedness` is the per-hand list of (category_name, score). Keeping this
    free of mediapipe objects means it is unit-testable with plain namespaces.
    """
    aspect = width / height
    p = landmarks[cfg.hand.track_landmark]
    a = landmarks[cfg.hand.palm_a]
    b = landmarks[cfg.hand.palm_b]
    # Palm width in NORMALIZED units (the same space vy is measured in), so
    # vy/scale is dimensionless and ~distance invariant (PLAN 3.4).
    scale = math.hypot(a.x - b.x, a.y - b.y)
    cat = handedness[0]
    label = cat.category_name if hasattr(cat, "category_name") else cat[0]
    score = cat.score if hasattr(cat, "score") else cat[1]
    hand = "R" if label == "Left" else "L"
    return Contact(
        t_ms=t_ms,
        hand=hand,
        x=p.x * aspect,
        y=p.y,
        scale=scale,
        conf=float(score),
    )


class HandTracker:
    """Wraps MediaPipe HandLandmarker (VIDEO mode, explicit frame clock)."""

    def __init__(self, model_path: str, cfg: Config):
        # Deferred import: detect.py and the tests never pay for mediapipe.
        import mediapipe as mp
        from mediapipe.tasks.python import vision
        from mediapipe.tasks.python.core.base_options import BaseOptions

        self._mp = mp
        self.cfg = cfg
        self._last_ts = -1
        self.lm = vision.HandLandmarker.create_from_options(
            vision.HandLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=str(model_path)),
                running_mode=vision.RunningMode.VIDEO,
                num_hands=cfg.hand.num_hands,
            )
        )

    def process(self, frame_bgr, t_ms: float) -> list[Contact]:
        import cv2

        mp = self._mp
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        img = mp.Image(mp.ImageFormat.SRGB, rgb)
        # MediaPipe VIDEO mode requires strictly increasing timestamps.
        ts = max(int(round(t_ms)), self._last_ts + 1)
        self._last_ts = ts
        res = self.lm.detect_for_video(img, ts)
        h, w = frame_bgr.shape[:2]
        out = []
        for i, lms in enumerate(res.landmarks):
            if i >= len(res.handedness):
                break
            out.append(contact_from_landmarks(lms, res.handedness[i], w, h, t_ms, self.cfg))
        return out
