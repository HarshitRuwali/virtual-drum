"""TrackBuilder length invariant (regression, PLAN 9b).

Every channel must be exactly as long as t_ms: detect() indexes each channel
at every frame index, so a short channel raises IndexError partway through a
real clip. Both failure modes below shipped and crashed the real-video path
while every synthetic fixture passed.
"""
from types import SimpleNamespace

import numpy as np
import pytest

from vdrum.config import default_config
from vdrum.detect import detect
from vdrum.extract import TrackBuilder


def c(hand, x=0.5, y=0.5, scale=0.1, conf=0.9):
    return SimpleNamespace(hand=hand, x=x, y=y, scale=scale, conf=conf)


def test_hand_appearing_late_is_backfilled():
    """The normal case: a hand enters the frame partway through the clip."""
    b = TrackBuilder()
    for i in range(5):
        b.add_frame(i * 1000.0 / 60, [c("R")] if i >= 2 else [])
    track = b.build()
    assert len(track.t_ms) == 5
    assert len(track.channels["R"].present) == 5
    # The first two frames must read as ABSENT, not as a hand at (0,0).
    assert list(track.channels["R"].present) == [0, 0, 1, 1, 1]


def test_duplicate_handedness_in_one_frame_does_not_lengthen_channel():
    """MediaPipe can label both hands the same; first contact wins."""
    b = TrackBuilder()
    for i in range(4):
        b.add_frame(i * 1000.0 / 60, [c("R", x=0.3), c("R", x=0.8)])
    track = b.build()
    assert len(track.channels["R"].present) == 4
    assert b.dropped_duplicates == 4
    assert track.channels["R"].x[0] == pytest.approx(0.3)


def test_hand_disappearing_keeps_channel_full_length():
    b = TrackBuilder()
    for i in range(6):
        b.add_frame(i * 1000.0 / 60, [c("L")] if i < 3 else [])
    track = b.build()
    assert list(track.channels["L"].present) == [1, 1, 1, 0, 0, 0]


def test_detect_walks_a_late_hand_track_without_indexerror():
    """The end-to-end symptom: detect() used to raise IndexError here."""
    b = TrackBuilder()
    for i in range(30):
        b.add_frame(i * 1000.0 / 60, [c("R", y=0.5 + 0.01 * i)] if i >= 10 else [])
    track = b.build()
    detect(track, default_config(), None)  # must not raise


def test_two_hands_with_different_start_frames():
    b = TrackBuilder()
    for i in range(8):
        cs = []
        if i >= 1:
            cs.append(c("R"))
        if i >= 5:
            cs.append(c("L"))
        b.add_frame(i * 1000.0 / 60, cs)
    track = b.build()
    n = len(track.t_ms)
    for h in ("R", "L"):
        assert len(track.channels[h].present) == n
    assert list(track.channels["L"].present) == [0, 0, 0, 0, 0, 1, 1, 1]


def test_build_rejects_empty():
    with pytest.raises(RuntimeError):
        TrackBuilder().build()


def test_track_npz_roundtrip(tmp_path):
    """save() -> load() must survive allow_pickle=False.

    `hands` was written as a dtype=object array, so every .npz produced by
    extract() raised ValueError on load and the cached-track workflow was
    unusable end to end.
    """
    from vdrum.detect import Track

    b = TrackBuilder()
    for i in range(4):
        b.add_frame(i * 1000.0 / 60, [c("R", x=0.1 * i), c("L", y=0.2 * i)])
    original = b.build()

    path = tmp_path / "clip.npz"
    original.save(path)
    loaded = Track.load(path)

    assert sorted(loaded.channels) == ["L", "R"]
    assert np.allclose(loaded.t_ms, original.t_ms)
    for h in ("L", "R"):
        assert np.allclose(loaded.channels[h].x, original.channels[h].x)
        assert np.allclose(loaded.channels[h].present, original.channels[h].present)
